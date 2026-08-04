#!/usr/bin/env bash
#
# cc-feature.sh <feature-name> [base-port]
#
# Spins up an isolated git worktree + branch off the latest main, ready for its
# own Claude Code session and its own Metro instance. One feature = one of these.
#
#   ./scripts/cc-feature.sh analytics
#   ./scripts/cc-feature.sh scorecard 8083
#
# Then: open a new terminal tab, cd into the printed path, run `claude`.
set -euo pipefail

NAME="${1:?usage: cc-feature.sh <feature-name> [metro-port]}"
PORT="${2:-8081}"
SLUG="$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
BRANCH="feat/${SLUG}"

# Resolve the main repo root even when run from inside another worktree.
MAIN_ROOT="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_ROOT="$(cd "$(dirname "$MAIN_ROOT")" && pwd)"
WORKTREE_DIR="${MAIN_ROOT}/../clippar-${SLUG}"
LOGFILE="/tmp/metro-clippar-${SLUG}.log"

echo "→ fetching latest main…"
git -C "$MAIN_ROOT" fetch origin main --quiet || true

echo "→ creating worktree ${WORKTREE_DIR} on ${BRANCH}…"
# --no-track: the new feature branch must NOT track origin/main, or a bare
# `git push` from it would push straight to main. First push uses `-u` (below).
git -C "$MAIN_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" --no-track origin/main 2>/dev/null \
  || git -C "$MAIN_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" --no-track main

# ── Provisioning ──────────────────────────────────────────────────────────
#
# `git worktree add` copies TRACKED files only, so a fresh worktree has no
# node_modules and none of the gitignored .env*.local files. Both are needed
# before Metro can run, and skipping them fails in ways that look like app
# bugs rather than setup gaps:
#
#  * No node_modules → Node walks UP and may find the main checkout's. That
#    one satisfies `"shot-detector": "file:modules/shot-detector"` with a
#    symlink into the MAIN checkout's modules/, which is outside this
#    worktree's Metro project root — so Metro refuses it and every route
#    importing the bare 'shot-detector' specifier fails to resolve, taking
#    the whole expo-router tree down ("Unable to resolve module
#    shot-detector"). Even when bundling limps along, expo-router emits the
#    entry bundle as /../../../../node_modules/... which escapes the dev
#    server root, so the page loads blank with no console error.
#  * No .env*.local → "supabaseUrl is required" at boot.
#
# Net effect: `npm run web:dev` is unusable from a worktree, which silently
# disables the "SEE it render" verification step CLAUDE.md mandates for every
# feature. Installing here is cheap (~11s against a warm npm cache) and makes
# the worktree genuinely self-contained.
APP_DIR="${WORKTREE_DIR}/clippar_app"

echo "→ linking gitignored env files…"
for env_file in .env.local .env.development.local .env.staging.local; do
  if [ -f "${MAIN_ROOT}/clippar_app/${env_file}" ]; then
    # Symlink, not copy: credentials stay in one place, and rotating them in
    # the main checkout takes effect in every worktree at once. These are
    # gitignored, so nothing secret can be committed from here.
    ln -sf "${MAIN_ROOT}/clippar_app/${env_file}" "${APP_DIR}/${env_file}"
    echo "   ${env_file} → main checkout"
  fi
done

echo "→ installing dependencies (own node_modules — required for Metro)…"
( cd "$APP_DIR" && npm install --prefer-offline --no-audit --no-fund )

cat <<EOF

✅ Worktree ready — deps installed, env linked.

  Next steps:
  1) New terminal tab → cd "$WORKTREE_DIR"
  2) Start its own Metro (logged so Claude can read it):
       APP_VARIANT=development npx expo start --tunnel --port ${PORT} > ${LOGFILE} 2>&1 &
  3) Run \`claude\` and tell it the feature + that Metro logs are at ${LOGFILE}

  Browser verification (the CLAUDE.md "SEE it render" step) works here too:
       cd clippar_app && npm run web:dev

  Merge when done:  npm run verify → git push -u origin ${BRANCH} → open PR →
                    CI green → merge → git worktree remove "$WORKTREE_DIR"
EOF
