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

cat <<EOF

✅ Worktree ready.

  Next steps:
  1) New terminal tab → cd "$WORKTREE_DIR"
  2) Start its own Metro (logged so Claude can read it):
       APP_VARIANT=development npx expo start --tunnel --port ${PORT} > ${LOGFILE} 2>&1 &
  3) Run \`claude\` and tell it the feature + that Metro logs are at ${LOGFILE}

  Merge when done:  npm run verify → git push -u origin ${BRANCH} → open PR →
                    CI green → merge → git worktree remove "$WORKTREE_DIR"
EOF
