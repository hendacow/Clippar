#!/usr/bin/env bash
#
# Deterministic secret / non-production-endpoint gate.
#
# WHY THIS EXISTS
# Six workflows and not one of them looked for a credential. `ci.yml` ran tsc
# plus node:test — 200-odd tests, none of which assert anything about secrets or
# endpoint hosts. `security.yml` is an LLM diff review: probabilistic,
# diff-scoped, and blind to history, so it could not have caught the
# GolfCourseAPI key that is already committed to this repo and survived two
# commits and a full security audit. Spec 6.3 asks for exactly this: "CI grep or
# binary scan for known secret patterns and non-production URLs".
#
# It is a grep, not gitleaks, on purpose: no third-party action holding a token,
# no licence gate that can turn CI red for a reason unrelated to security, and
# the rules are readable in the file that enforces them. It is a floor, not a
# ceiling — it catches the specific shapes that would actually hurt this project.
#
# Run it locally the same way CI does:
#   ./scripts/secret-scan.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
fail=0

note() { printf '  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. No dotenv file may be TRACKED.
# ─────────────────────────────────────────────────────────────────────────────
# .gitignore covers `.env*.local`, but Expo's CLI also loads `.env`,
# `.env.<mode>` and `.env.<mode>.local`. So `clippar_app/.env.production` — which
# per the committed .example files carries SUPABASE_SERVICE_ROLE_KEY and
# STRIPE_SECRET_KEY — matches no ignore rule at all, and `git add .` publishes
# it. This checks the thing that actually matters (is it tracked?) rather than
# trusting the ignore list to be complete.
echo "── tracked dotenv files ───────────────────────────────"
tracked_env="$(git -c core.quotePath=false ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' || true)"
if [ -n "$tracked_env" ]; then
  bad "dotenv file(s) committed to the repo:"
  echo "$tracked_env" | while read -r f; do note "$f"; done
else
  note "none tracked (only .example files)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1b. No credential-carrying BINARY document may be tracked.
# ─────────────────────────────────────────────────────────────────────────────
# Every pattern check below is a text grep, and `git log -p` prints "Binary
# files differ" for a document container — so a credential inside one is
# invisible to all of them, at any pattern strength, and no amount of tuning
# the patterns changes that. Filename is the only signal available for a
# container the scanner cannot open, so use it.
#
# Deliberately narrow: document containers, ARCHIVES and key-material
# extensions only — not images/fonts/video — so this stays a rule people trust
# rather than one they learn to ignore.
#
# Archives earn their place: a tarball holding a `.env` defeats every other
# check in this file. The dotenv rule at §1 matches on path and the archive's
# path is not a dotenv path; both content sweeps are blind because `git grep`
# skips binary files and `git log -p` prints only "Binary files differ".
# `.tar.gz`/`.tar.bz2` need no multi-suffix handling — the bare `gz`/`bz2`
# alternatives cover them.
#
# This list is open-ended by nature and will never be "complete". If a build
# ever legitimately needs a tracked file with one of these extensions, carve it
# out by PATH here rather than removing the extension, and say why.
#
# Checked in the index AND across every commit reachable from HEAD. The index
# alone is not enough, and the gap is the same shape as the one that hid the
# leak: a branch that adds the document in one commit and deletes it in the
# next has a clean tip index, and the history grep below cannot look inside the
# blob — so commit-then-delete, the case where rotation is the only remedy,
# would sail through. `ci.yml` checks out with `fetch-depth: 0`, so the
# reachable history is really there to scan.
#
# Scoped to HEAD, NOT `--all`, and that is deliberate rather than lazy:
# HEAD-reachable is the scope a PR author can actually act on. A gate that is
# red on every build for something the current change did not introduce, and
# cannot remove, is a gate everyone learns to click past.
echo
echo "── tracked credential-carrying binaries ───────────────"
BINARY_DOC_EXT='\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pdf|zip|7z|rar|tar|tgz|gz|bz2|xz|zst|kdbx|vsix|p8|p12|pfx|der|p7b|p7c|pkcs12|pkcs8|crt|cer|key|asc|gpg|jks|keystore|bcfks|ppk|ovpn|mobileprovision)$'
tracked_bin="$(git -c core.quotePath=false ls-files | grep -Ei "$BINARY_DOC_EXT" || true)"
if [ -n "$tracked_bin" ]; then
  bad "binary document/key file(s) tracked — text scans cannot see inside these:"
  echo "$tracked_bin" | head -5 | while read -r f; do note "$f"; done
  note "if this file is genuinely needed, store it outside the repo and link to it"
else
  note "none in the working tree"
fi

# Same rule against reachable history. A blob here is already leaked to anyone
# who can clone, so deleting it is NOT the fix — it has to be rotated.
hist_bin="$(git -c core.quotePath=false rev-list --objects HEAD 2>/dev/null \
  | grep -Ei "$BINARY_DOC_EXT" | awk '{ $1=""; sub(/^ /,""); print }' \
  | sort -u || true)"
if [ -n "$hist_bin" ]; then
  bad "binary document/key file(s) in history reachable from HEAD:"
  echo "$hist_bin" | head -5 | while read -r f; do note "$f"; done
  note "deleting the file does NOT undo this — treat anything inside it as compromised and rotate it"
else
  note "none in history reachable from HEAD"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. High-confidence live-credential shapes, in the working tree AND in history.
# ─────────────────────────────────────────────────────────────────────────────
# History matters: a key deleted in the next commit is still a leaked key. These
# are shapes that are never legitimately committed, so a hit is always real.
echo
echo "── live credential shapes ─────────────────────────────"
CRED_PATTERNS=(
  'sk_live_[0-9A-Za-z]{16,}'          # Stripe live secret key
  'rk_live_[0-9A-Za-z]{16,}'          # Stripe live restricted key
  'sk_test_[0-9A-Za-z]{16,}'          # Stripe test secret key
  'whsec_[0-9A-Za-z]{16,}'            # Stripe webhook signing secret
  're_[0-9A-Za-z]{8}_[0-9A-Za-z]{16,}' # Resend API key
  'sk_[0-9A-Za-z]{24,}'               # RevenueCat secret key
  # ANCHORED to the surrounding JSON, and split so this line cannot match
  # ITSELF — both halves are load-bearing. Every other pattern here is safe
  # already: their own text contains `[0-9A-Za-z]{16,}` rather than real
  # alphanumerics, so they cannot self-match. This one was a bare literal and
  # could, which forced a `:(exclude)scripts/secret-scan.sh` pathspec onto the
  # sweeps — and that pathspec was worse than the problem it solved. It made
  # THIS file the one path in the repo where a credential committed and then
  # deleted was invisible to BOTH sweeps, and on `git log` a pathspec also
  # switches on default history simplification (see the history sweep below).
  #
  # Anchoring on `"role":` fixes it at the root: a real decoded service-role
  # JWT payload always carries that prefix, while the bare literal this file
  # used to contain (still present in its own pre-anchor commits) does not. So
  # no pathspec is needed anywhere, and neither bypass can come back.
  #
  # `[[:space:]]*` is NOT optional decoration — JSON permits whitespace after
  # the colon, and every way a human actually produces one of these payloads
  # (jwt.io, `jq`, the Supabase dashboard, a pretty-printed debug log) emits it
  # pretty-printed, with a space between the colon and the value. Anchoring
  # without it silently narrowed this pattern to the compact form, which is the
  # LESS common paste of the two.
  #
  # It also preserves the no-self-match property, because in this line's own
  # source text `[[:space:]]*` is literal bracket characters rather than
  # whitespace — so the pathspec stays gone. (Do not write a pretty-printed
  # example anywhere in this file to illustrate the point: the pattern is doing
  # its job and will match it. Verified the hard way.)
  '"role":[[:space:]]*"service_ro''le"'  # decoded service-role JWT payload
  'SUPABASE_SERVICE_ROLE_KEY[=:][[:space:]]*["'"'"']?ey[A-Za-z0-9_-]{20,}'
)
# A PEM header is handled separately and ANCHORED to a whole line. This codebase
# legitimately builds a PEM from a base64 secret at runtime (_shared/apple.ts)
# and the auth docs quote the header in prose; both embed it mid-line. Actual key
# material always has the header alone on its own line, which is what this
# matches — and matching prose instead would just train everyone to ignore the
# check.
PEM_LINE='^[+-]?[[:space:]]*\-\-\-\-\-BEGIN [A-Z ]*PRIVATE KEY\-\-\-\-\-[[:space:]]*$'
for pat in "${CRED_PATTERNS[@]}"; do
  hits="$(git grep -InE "$pat" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    bad "credential-shaped string in the working tree: /$pat/"
    echo "$hits" | head -5 | while read -r l; do note "$l"; done
  fi
done
pem_hits="$(git grep -InE "$PEM_LINE" 2>/dev/null || true)"
if [ -n "$pem_hits" ]; then
  bad "private-key PEM material in the working tree:"
  echo "$pem_hits" | head -5 | while read -r l; do note "$l"; done
fi

# Same patterns across every commit reachable from any ref. `git log -p` is
# cheap on a repo this size and is the only way to see a key that was committed
# and then removed.
#
# The history sweep used to carry its OWN hand-written pattern list — a subset
# of five. Anything added to CRED_PATTERNS after that line was written was
# checked in the working tree and NOT in history, which is backwards: the tree
# can be cleaned with a delete, history cannot. The Resend shape above was in
# exactly that gap, and the scan reported "history clean" while a live Resend
# key sat in a pushed blob. The alternation is now built FROM the same array so
# the two sweeps can never drift again.
#
# NO PATHSPEC, and that is the whole point — do not re-add one. Passing
# `git log` a pathspec (even a pure `:(exclude)`) switches on default history
# simplification: for a merge TREESAME to one parent, git follows ONLY that
# parent, so every commit reachable just through the side parent falls out of
# the traversal and its `-p` output never reaches grep. `git merge -s ours` is
# TREESAME by construction — and "merge the leak branch with -s ours, then let
# GitHub delete the ref on merge" is a plausible attempt at tidying up a leak.
# The key would still be in public history and the scan would print "history
# clean".
#
# An earlier version of this file excluded `scripts/secret-scan.sh` here, to
# stop the pattern definitions matching themselves. That exclusion cost more
# than it bought twice over: it turned on the simplification above, AND it made
# this file the one path in the repo where a credential committed and then
# deleted was invisible to both sweeps. Anchoring the service-role pattern on
# `"role":"` removed the need for it (see CRED_PATTERNS), so this sweep now
# traverses everything, this file included. `--full-history` is kept anyway: it
# costs nothing with no pathspec, and it keeps the merge bypass closed if
# anyone re-adds one later.
#
# `--binary-files=text` is spelled out rather than using `-a`, and it must NOT
# be shortened back. `-a` (--binary-files=text) and `-I`
# (--binary-files=without-match) set the SAME grep option, so the last one on
# the command line wins. This call used to read `grep -aInE`, where the `I`
# comes after the `a` and therefore silently won:
#
#   grep -acE  PNG clippar_logo_green.png   -> 1
#   grep -aIcE PNG clippar_logo_green.png   -> 0   <- what we were running
#
# The trigger is a NUL byte in the stream. (Not an encoding error — a latin-1
# byte was tested in both C and C.UTF-8 locales on GNU grep 3.11 and did NOT
# trip binary detection. Verify before believing either claim.)
#
# A NUL reaches this stream more easily than it looks, because git's own
# "is this binary" heuristic only sniffs the FIRST 8000 BYTES of a blob. A file
# that is ordinary text for 8kB and contains a NUL after that is classified as
# text by git and inlined in full by `git log -p` — so the NUL lands in grep's
# input, grep calls the whole stream binary, and `-I` discards ALL of it.
# `$hist` comes back empty and the else-branch below prints "history clean for
# live-key shapes". Fail-open, silent, and byte-identical in the CI log to a
# real pass — the exact failure this gate exists to stop.
#
# Reproduced end-to-end in a scratch repo: with a committed-then-deleted Resend
# key plus one such file, `grep -aIcnE` finds 0 and `--binary-files=text` finds
# 2. On THIS repo today it is latent, not active (2275 `diff --git` lines under
# either form), but it is one committed blob away from permanent.
hist_pat="$(printf '%s|' "${CRED_PATTERNS[@]}")"
hist_pat="${hist_pat}APPLE_PRIVATE_KEY[=:][[:space:]]*[\"']?[A-Za-z0-9+/]{100,}|$PEM_LINE"
hist="$(git log -p --all --full-history --no-color -U0 2>/dev/null \
  | grep --binary-files=text -nE "$hist_pat" \
  | head -5 || true)"
if [ -n "$hist" ]; then
  bad "credential-shaped string present in git HISTORY (rotation required, not just deletion):"
  echo "$hist" | while read -r l; do note "$l"; done
else
  note "history clean for live-key shapes"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. No non-production endpoint may be baked into shipped config.
# ─────────────────────────────────────────────────────────────────────────────
# Scoped to the files that actually decide what the binary talks to. Test
# fixtures, CORS allowlists and docs legitimately mention localhost, so scanning
# the whole tree would just train everyone to ignore this.
echo
echo "── non-production endpoints in shipped config ─────────"
CONFIG_FILES=(
  clippar_app/eas.json
  clippar_app/app.config.js
  clippar_app/constants/config.ts
)
# punkaoeuityovwljpyag is the DEV Supabase project ref; it must never appear in
# a file that feeds a production build.
NONPROD='localhost|127\.0\.0\.1|ngrok|onrender\.com|punkaoeuityovwljpyag'
nonprod_hit=0
for f in "${CONFIG_FILES[@]}"; do
  [ -f "$f" ] || continue
  hits="$(grep -InE "$NONPROD" "$f" || true)"
  if [ -n "$hits" ]; then
    bad "non-production endpoint in $f:"
    nonprod_hit=1
    echo "$hits" | while read -r l; do note "$l"; done
  fi
done
[ "$nonprod_hit" = "0" ] && note "shipped config references no dev/local host"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Every remote import in the edge functions must be version-pinned.
# ─────────────────────────────────────────────────────────────────────────────
# deno.lock is gitignored and there is no import map, so the URL specifier IS the
# pin. An unversioned deno.land/std URL once sat in create-share-link's share-
# token generator — the module that mints the only secret protecting a shared
# reel — meaning the deployed behaviour of a security-critical function was not
# reproducible from the repo (spec 5.11).
echo
echo "── unpinned remote imports (edge functions) ───────────"
if [ -d clippar_app/supabase/functions ]; then
  # Only real import/export specifiers — a comment that quotes a URL (including
  # the one in create-share-link explaining why the import was removed) is prose,
  # not a dependency.
  unpinned="$(grep -rnE "from[[:space:]]+['\"]https://(deno\.land|esm\.sh)/" \
      clippar_app/supabase/functions --include='*.ts' \
    | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | grep -vE '@[0-9]' || true)"
  if [ -n "$unpinned" ]; then
    bad "unversioned remote import(s):"
    echo "$unpinned" | while read -r l; do note "$l"; done
  else
    note "all remote imports carry an @version"
  fi
fi

echo
if [ "$fail" = "0" ]; then
  echo "════ secret scan CLEAN ════"
else
  echo "════ secret scan FAILED — do not merge ════"
fi
exit "$fail"
