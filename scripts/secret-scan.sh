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

# path:line ONLY — never the matched text. `git grep -In` emits
# "path:line:<the whole matching line>", so echoing its output verbatim prints
# the credential this script just caught. CI logs on a public repository are
# world-readable for ~90 days, so that republishes the secret to a URL an
# attacker can poll, and that copy outlives deleting the key from the tree.
# Piping every match through this is the difference between reporting a leak
# and committing one.
locs() { cut -d: -f1,2; }

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
tracked_env="$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' || true)"
if [ -n "$tracked_env" ]; then
  bad "dotenv file(s) committed to the repo:"
  echo "$tracked_env" | while read -r f; do note "$f"; done
else
  note "none tracked (only .example files)"
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
  'service_role"'                      # decoded service-role JWT payload
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
  hits="$(git grep -InE "$pat" -- . ':(exclude)scripts/secret-scan.sh' 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    bad "credential-shaped string in the working tree: /$pat/"
    echo "$hits" | head -5 | locs | while read -r l; do note "$l"; done
  fi
done
pem_hits="$(git grep -InE "$PEM_LINE" \
    -- . ':(exclude)scripts/secret-scan.sh' 2>/dev/null || true)"
if [ -n "$pem_hits" ]; then
  bad "private-key PEM material in the working tree:"
  echo "$pem_hits" | head -5 | locs | while read -r l; do note "$l"; done
fi

# Same patterns across every commit reachable from any ref. `git log -p` is
# cheap on a repo this size and is the only way to see a key that was committed
# and then removed.
hist="$(git log -p --all --no-color -U0 2>/dev/null \
  | grep -aInE "sk_live_[0-9A-Za-z]{16,}|whsec_[0-9A-Za-z]{16,}|APPLE_PRIVATE_KEY[=:][[:space:]]*[\"']?[A-Za-z0-9+/]{100,}|SUPABASE_SERVICE_ROLE_KEY[=:][[:space:]]*[\"']?ey[A-Za-z0-9_-]{20,}|$PEM_LINE" \
  | head -5 || true)"
if [ -n "$hist" ]; then
  # COUNT ONLY. `git log -p | grep -n` numbers lines in the DIFF STREAM, so there
  # is no useful path to print anyway — and a location in history is itself a
  # search-narrowing locator for a key that is, by definition, already committed.
  bad "credential-shaped string present in git HISTORY (rotation required, not just deletion):"
  note "$(echo "$hist" | wc -l | tr -d ' ') match(es). Locations deliberately not"
  note "printed — CI logs are public. Run ./scripts/secret-scan.sh locally to see them."
else
  note "history clean for live-key shapes"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2b. No OPAQUE BINARY DOCUMENT may be tracked.
# ─────────────────────────────────────────────────────────────────────────────
# This is a FILENAME check on purpose, and the reason matters more than the rule.
#
# Every check above greps for credential SHAPES, and they are blind to binary
# blobs for TWO independent reasons — the second is the broader one and an
# earlier version of this comment missed it:
#
#   1. `git grep -I` (used above) skips every file git considers binary, whether
#      or not the key's bytes are actually in there. Verified, not assumed: a
#      plain uncompressed file containing `sk_live_...` next to a NUL byte is
#      found WITHOUT -I and skipped WITH it.
#   2. A compressed container (Office, zip, tgz) does not contain the literal
#      bytes at all, so even an unfiltered grep would miss it.
#
# `git log -p` compounds both by rendering any binary blob as
# "Binary files differ". NO PATTERN ADDED TO CRED_PATTERNS CAN EVER FIRE ON
# BINARY CONTENT.
#
# Reason 1 is why this list must cover credential CONTAINERS — a keystore, a
# .p12, a SQLite file — and not just documents. Those are the higher-value leak:
# an Android signing keystore or an APNs certificate is worse than a memo, and
# the key material genuinely is in the bytes; git just never looks.
#
# .gitignore does not close it either: ignore rules are advisory, and `git add -f`,
# an editor's "commit anyway", or a `git add .` predating the rule all walk past.
# The only thing pattern-matching cannot miss is whether the blob EXISTS.
echo
echo "── opaque binary documents ────────────────────────────"
# Documents and archives, then — the half that matters more — binary credential
# containers. Keep in sync with the extension list in .gitignore.
BINDOC='[.](docx?|docm|xlsx?|xlsm|pptx?|odt|ods|odp|rtf|pdf|vsix|numbers|pages)$'
BINDOC="$BINDOC"'|[.](zip|7z|rar|jar|war|tgz)$|[.]tar[.]gz$'
BINDOC="$BINDOC"'|[.](p12|pfx|jks|keystore|bcfks|mobileprovision|cer|der|sqlite3?|db)$'
tracked_bin="$(git ls-files | grep -iE "$BINDOC" || true)"
if [ -n "$tracked_bin" ]; then
  bad "opaque binary document(s) tracked — credential patterns cannot see inside these:"
  echo "$tracked_bin" | while read -r f; do note "$f"; done
else
  note "none tracked"
fi

# History half is a WARNING, not a failure: a pre-existing blob would otherwise
# wedge every merge until a purge lands, and a check that blocks everything gets
# deleted rather than fixed. Flip to `bad` once history is clean.
#
# COUNT ONLY — never print the names. CI logs on a public repository are world
# readable for 90 days, so a check that names the file it is worried about
# publishes it somewhere easier to find than where it lives. This repo has made
# that exact mistake before: an earlier version of this script printed the
# matched line, password included, straight into the build log. Run the script
# locally to see which files; that output is not public.
# AMR, not A: `diff.renames` defaults on, so a blob added under a harmless name
# and later renamed to a matching extension is reported as R and would never be
# counted — a rename should not be a way around this.
hist_bin="$(git log --all --pretty=format: --name-only --diff-filter=AMR 2>/dev/null \
  | sort -u | grep -icE "$BINDOC" || true)"
if [ "${hist_bin:-0}" -gt 0 ]; then
  note "WARN ${hist_bin} opaque binary document(s) in git HISTORY."
  note "     Names deliberately not printed — CI logs are public. Run this"
  note "     script locally to list them. Rotation, not deletion, is the remedy."
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
