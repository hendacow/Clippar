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

# NOTHING IN THIS FILE PRINTS A PATH OR A MATCHED LINE. Every sweep reports a
# COUNT. `git grep` emits "path:line:<the whole matching line>", so echoing its
# output prints the credential this script just caught — and CI logs on a public
# repository are world-readable for ~90 days at a pollable URL, so that copy
# outlives deleting the key from the tree. The file NAME alone is a locator too,
# which is why the filename gates count as well. Run the script locally to see
# what it found; that output is not public.

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
# `-z`, and NOT `-c core.quotePath=false`. git does not emit raw paths by
# default: anything containing a byte >= 0x80, a double-quote or a backslash is
# C-escaped and WRAPPED IN QUOTES, so `café.env` arrives as `"caf\303\251.env"`
# — ending in `"` rather than the extension, which every $-anchored regex in
# this file then misses. One accented character was a complete bypass of this
# check and of the binary check below, by accident as easily as on purpose.
#
# `core.quotePath=false` is NOT sufficient: per git-config(1) it only stops
# bytes above 0x80 counting as unusual, and quote/backslash/control characters
# are escaped regardless of it. `-z` emits paths NUL-separated and raw, which
# sidesteps quoting as a category rather than one class of it.
# Verified both ways. Do not simplify the -z back out.
tracked_env="$(git ls-files -z | grep -zE '(^|/)\.env($|\.)' | grep -zv '\.example$' | tr '\0' '\n' || true)"
if [ -n "$tracked_env" ]; then
  # COUNT ONLY, same rule as every other sweep in this file. A tracked dotenv
  # path is a locator for a live credential, and this now runs on every ref into
  # world-readable CI logs.
  n_env="$(printf '%s\n' "$tracked_env" | wc -l | tr -d ' ')"
  bad "${n_env} dotenv file(s) committed to the repo."
  note "Names deliberately not printed — CI logs are public. Run"
  note "./scripts/secret-scan.sh locally to list them."
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
  # Decoded service-role JWT payload. ANCHORED to a payload neighbour on the
  # same line for the same reason PEM_LINE is anchored: the bare string
  # `service_role"` matches PROSE, and this repository writes a great deal of
  # prose about leaked service-role keys — including the sentences in
  # reports/ that explain this very pattern. Unanchored, it fired three times
  # across history on documentation and zero times on a credential, which
  # turns the gate permanently red for a reason nobody can fix, and a gate
  # that cries wolf gets deleted rather than obeyed. A real decoded Supabase
  # payload always carries iss/ref/iat/exp beside the role; prose does not.
  # The ENCODED form is unaffected — it is caught by the
  # SUPABASE_SERVICE_ROLE_KEY line below.
  '"role"[[:space:]]*:[[:space:]]*"service_role".*"(iss|ref|iat|exp)"|"(iss|ref|iat|exp)".*"role"[[:space:]]*:[[:space:]]*"service_role"'
  # The ENCODED service-role claim, and this is the one that actually matters.
  #
  # The rule above is line-oriented, so it cannot see a decoded payload that was
  # committed pretty-printed (one claim per line) — the shape jwt.io, `jq` and
  # every editor's Format Document produce. That is a real gap in it and this
  # closes the class properly rather than widening the decoded rule, because a
  # decoded payload is NOT the credential: without the signature it authenticates
  # nothing. The encoded JWT is the credential, and this matches the credential
  # itself, so it fires whatever identifier holds it — `SERVICE_KEY`,
  # `supabaseAdmin`, a bare string argument to createClient(), a value in a .json
  # — every one of which the SUPABASE_SERVICE_ROLE_KEY rule below misses because
  # that rule needs the literal variable name.
  #
  # Three alternatives because base64 is byte-aligned: `"service_role"` encodes
  # differently depending on its offset in the payload, which varies with the
  # project ref. Verified by generating Supabase-shaped tokens across every
  # alignment: 27/27 service-role keys matched, 0 anon keys matched — the anon
  # key carries a `role: anon` claim, so the key that is MEANT to be public
  # cannot trip this. Structurally cannot match prose either, which is the
  # failure mode the decoded rule had to be anchored for.
  #
  # A service-role key bypasses RLS on every table. It is the highest-value
  # single credential in the project and until this line it was the least
  # covered.
  # Each alternative has ONE character bracketed so this line does not contain
  # its own match text. `[S]` matches `S`, so the regex is unchanged — but the
  # source no longer holds the literal run, which is what previously forced an
  # `:(exclude)` pathspec onto every sweep and made this the one file where a
  # committed-then-deleted credential was invisible to all of them. Do not
  # "tidy" the brackets away.
  'InNlcnZpY2Vfcm9sZ[S]I|ZXJ2aWNlX3JvbGU[i]|c2VydmljZV9yb2x[l]'
  'SUPABASE_SERVICE_ROLE_KEY[=:][[:space:]]*["'"'"']?ey[A-Za-z0-9_-]{20,}'
)
# A PEM header is handled separately and ANCHORED to a whole line. This codebase
# legitimately builds a PEM from a base64 secret at runtime (_shared/apple.ts)
# and the auth docs quote the header in prose; both embed it mid-line. Actual key
# material always has the header alone on its own line, which is what this
# matches — and matching prose instead would just train everyone to ignore the
# check.
PEM_LINE='^[+-]?[[:space:]]*\-\-\-\-\-BEGIN [A-Z ]*PRIVATE KEY\-\-\-\-\-[[:space:]]*$'
# COUNT ONLY here too. These sweeps used to print `path:line` via locs(), which
# is the sharpest locator in the file — it names the file AND the line holding a
# live credential — and it is now emitted on every ref into world-readable CI
# logs. Same rule, applied consistently: one inconsistent sweep in a file whose
# whole argument is consistency is what gets rediscovered next month.
# SELF-EXCLUSION IS PER-PATTERN, NOT BLANKET, and the difference is the whole
# point. Excluding this file from EVERY pattern made it the one place in the
# repository where a committed credential was invisible to both sweeps — which
# is precisely the file someone edits while holding a real key, tuning a rule or
# pasting a live value to check that it fires.
#
# Only one pattern needs the exclusion: the encoded service-role rule, whose
# match text this file's HISTORY still contains in cleartext (it was committed
# unbracketed earlier in this branch, and rewriting that history is not allowed
# here). Every other pattern — Stripe, Resend, RevenueCat, the named
# service-role key, the PEM rule — now scans this file like any other, in the
# tree and in history.
#
# RESIDUAL, stated rather than papered over: a RAW service-role JWT committed
# into THIS file, under no recognisable variable name, is still invisible. Every
# other credential shape, and a service-role key anywhere else in the repo, is
# not. Once this branch is squashed into main the literal leaves main's history
# and this exclusion can go entirely — that is a real follow-up, not a
# permanent design.
self_ref='InNlcnZpY2Vfcm9sZ[S]I|ZXJ2aWNlX3JvbGU[i]|c2VydmljZV9yb2x[l]'
for pat in "${CRED_PATTERNS[@]}"; do
  if [ "$pat" = "$self_ref" ]; then
    hits="$(git grep -IcE "$pat" -- . ':(exclude)scripts/secret-scan.sh' 2>/dev/null || true)"
  else
    hits="$(git grep -IcE "$pat" 2>/dev/null || true)"
  fi
  if [ -n "$hits" ]; then
    n_hit="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
    bad "credential-shaped string in the working tree, in ${n_hit} file(s)."
    note "Pattern and locations deliberately not printed — CI logs are public."
    note "Run ./scripts/secret-scan.sh locally to see them."
  fi
done
# No exclusion: PEM_LINE is anchored to a whole line and this file only ever
# mentions the header mid-line, inside the pattern definition.
pem_hits="$(git grep -IcE "$PEM_LINE" 2>/dev/null || true)"
if [ -n "$pem_hits" ]; then
  n_pem="$(printf '%s\n' "$pem_hits" | wc -l | tr -d ' ')"
  bad "private-key PEM material in the working tree, in ${n_pem} file(s)."
  note "Names deliberately not printed — CI logs are public. Run"
  note "./scripts/secret-scan.sh locally to list them."
fi

# A SHALLOW clone cannot answer this question, and it fails silently in the one
# direction that matters. `git log --all` on a grafted repo walks the handful of
# commits it has, finds nothing, and the else-branch below prints "history
# clean" — byte-identical to a real pass. That is not hypothetical: it is the
# exact shape of this repository's own incident, where a check reported CLEAN
# because it never looked at the refs the key was on. "I cannot see history" and
# "history is clean" are different sentences and the script must not confuse
# them, so refuse to make the claim instead of making a false one.
#
# CI is unshallow (secret-scan.yml pins fetch-depth: 0, and a test pins that),
# so this guard is for a local run, a fork, or the day someone edits the
# workflow. Failing is right: an unverifiable gate is not a passing gate.
shallow="$(git rev-parse --is-shallow-repository 2>/dev/null || true)"
if [ "$shallow" != "true" ] && [ "$shallow" != "false" ]; then
  # git < 2.15 has no --is-shallow-repository; the marker file is the same fact.
  if [ -f "$(git rev-parse --git-dir 2>/dev/null || echo .git)/shallow" ]; then
    shallow=true
  else
    shallow=false
  fi
fi

# Same patterns across every commit reachable from any ref. `git log -p` is
# cheap on a repo this size and is the only way to see a key that was committed
# and then removed.
# The alternation is built FROM CRED_PATTERNS, never hand-written beside it.
# It used to be its own list of five, and everything added to CRED_PATTERNS
# after that line was written got checked in the working tree and NOT in
# history — backwards, because a tree is cleaned with a delete and history is
# not. The Resend shape on line 68 sat in exactly that gap while a live Resend
# key was in a pushed blob, and this sweep printed "history clean for live-key
# shapes". Deriving it here is what stops the two lists drifting again; the
# pathspec keeps the pattern definitions above from matching themselves.
hist_pat="$(printf '%s|' "${CRED_PATTERNS[@]}")"
hist_pat="${hist_pat}APPLE_PRIVATE_KEY[=:][[:space:]]*[\"']?[A-Za-z0-9+/]{100,}|$PEM_LINE"
# The same alternation MINUS the self-referential pattern, for the pass that
# scans this file too. Built by filtering the same array, so it cannot drift
# from CRED_PATTERNS either.
hist_pat_rest=""
for _p in "${CRED_PATTERNS[@]}"; do
  [ "$_p" = "$self_ref" ] && continue
  hist_pat_rest="${hist_pat_rest}${_p}|"
done
hist_pat_rest="${hist_pat_rest}APPLE_PRIVATE_KEY[=:][[:space:]]*[\"']?[A-Za-z0-9+/]{100,}|$PEM_LINE"
# `--full-history` is REQUIRED and is not decoration. Handing `git log` a
# pathspec — which the exclude above is — switches on default history
# simplification, and at a merge that is TREESAME to one parent for that
# pathspec git follows only that parent and PRUNES THE OTHER PARENT'S HISTORY
# ENTIRELY. `--all` does not save you: it adds start points, it does not disable
# simplification. So a branch that commits a key, deletes it, and is then merged
# TREESAME (`-s ours`, or work reverted before the merge) goes invisible the
# moment its own ref is deleted — and this sweep prints "history clean".
#
# Measured, not reasoned: on a repo built to that shape, the sweep finds 2
# without the pathspec, **0** with the pathspec, and 2 again with
# `--full-history`. That is the exact false-clean this check exists to prevent,
# reintroduced by the fix for a different false-clean. Never add a pathspec here
# without this flag.
#
# COUNT FIRST, then decide. `grep -c` on the untruncated stream is the real
# tally; the old form piped through `head -5` and then counted the truncated
# result, so any incident with more than five hits reported exactly "5
# match(es)" — a number that reads as complete and is not.
#
# TWO PASSES, for the same reason the working-tree sweep is per-pattern: a
# blanket exclude made this file the one place a committed-then-deleted
# credential was invisible. Pass 1 scans EVERYTHING, this file included, for
# every shape except the self-referential one. Pass 2 scans for that one shape
# with this file excluded, because its match text is in this file's own history
# in cleartext and history cannot be rewritten here.
if [ "$shallow" = "true" ]; then
  hist_n=0
else
  hist_all="$(git log -p --all --full-history --no-color -U0 2>/dev/null \
    | grep -acE "$hist_pat_rest" || true)"
  hist_self="$(git log -p --all --full-history --no-color -U0 \
      -- . ':(exclude)scripts/secret-scan.sh' 2>/dev/null \
    | grep -acE "$self_ref" || true)"
  hist_n=$(( ${hist_all:-0} + ${hist_self:-0} ))
fi
if [ "$shallow" = "true" ]; then
  bad "history scan CANNOT RUN: this is a shallow clone."
  note "A key that was committed and then deleted is invisible from here, so"
  note "\"clean\" would be a false statement, not a pass. Re-run with full"
  note "history: fetch-depth: 0 in CI, or 'git fetch --unshallow' locally."
elif [ "${hist_n:-0}" -gt 0 ]; then
  # COUNT ONLY. A location in history is itself a search-narrowing locator for a
  # key that is, by definition, already committed.
  bad "credential-shaped string present in git HISTORY (rotation required, not just deletion):"
  note "${hist_n} match(es). Locations deliberately not printed — CI logs are"
  note "public. Run ./scripts/secret-scan.sh locally to see them."
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
# Archives: `tgz` and `tar.gz` alone left the CHEAPEST instance of this class
# uncovered. A plain `.tar` needs no compression at all to defeat every text
# grep here — the NUL padding is enough for git to call it binary — and
# `keys.sql.gz` is one command away from any database dump.
BINDOC="$BINDOC"'|[.](zip|7z|rar|jar|war|tgz|tar|gz|bz2|xz|zst)$|[.]tar[.](gz|bz2|xz|zst)$'
# `kdbx` is a password database — a pure credential container, higher value than
# any office format above it. The mobile bundles ship signing and provisioning
# material.
BINDOC="$BINDOC"'|[.](p12|pfx|jks|keystore|bcfks|kdbx|mobileprovision|cer|der|sqlite3?|db)$'
BINDOC="$BINDOC"'|[.](apk|aab|ipa)$'
# `-z` for the quoting reason given in full at the dotenv check above: without
# it a single accented character in the filename walks straight past this gate.
tracked_bin="$(git ls-files -z | grep -zEi "$BINDOC" | tr '\0' '\n' || true)"
if [ -n "$tracked_bin" ]; then
  # COUNT ONLY, for exactly the reason the history sweep below already gives,
  # and this half was the one place in the file breaking its own rule.
  #
  # It matters more now than when this check was written for PRs into main: the
  # scan runs on EVERY ref, including refs that carry an un-rotated credential
  # inside a binary document. Public-repo Actions logs are readable
  # unauthenticated at a stable URL and retained ~90 days, so one push to such a
  # branch would have written the document's exact path — the single locator
  # every other artefact here deliberately withholds — somewhere far easier to
  # find than the blob itself. Deleting the branch afterwards does not delete
  # the log.
  n_bin="$(printf '%s\n' "$tracked_bin" | wc -l | tr -d ' ')"
  bad "${n_bin} opaque binary document(s) tracked — credential patterns cannot see inside these."
  note "Names deliberately not printed — CI logs are public. Run"
  note "./scripts/secret-scan.sh locally to list them."
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
#
# Shallow clones: this sweep is as blind as the one above. It says nothing when
# the count is zero, and silence reads as "none" — so say which it is. The run
# is already FAILing by this point, but the log should not imply a clean sweep.
if [ "$shallow" = "true" ]; then
  hist_bin=0
  note "history not searched — shallow clone (see above)."
else
  # `--full-history` is a NO-OP here today — this walk takes no pathspec, so
  # simplification is not on — and it is here so it stays that way. The sweep
  # above was silently pruning whole merged branches the moment a pathspec was
  # added to it; this is the same command shape one edit away from the same
  # trap. Cheap insurance, and the reason is written down rather than assumed.
  # `-z` here too — `git log --name-only` quotes exactly as `ls-files` does, so
  # this half had the same accented-filename bypass as the index half above.
  # With -z the record separator becomes NUL, so paths arrive raw.
  hist_bin="$(git log --all --full-history --pretty=format: --name-only -z --diff-filter=AMR 2>/dev/null \
    | tr '\0' '\n' | sort -u | grep -icE "$BINDOC" || true)"
fi
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
