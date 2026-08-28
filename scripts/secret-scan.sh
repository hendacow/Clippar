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
# COUNT — sections 3 and 4 included, which were the last two exceptions. `git grep` emits
# "path:line:<the whole matching line>", so echoing its output prints the
# credential this script just caught, and CI logs on a public repository are
# world-readable for ~90 days at a pollable URL, so that copy outlives deleting
# the key from the tree. The file NAME alone is a locator too, which is why the
# filename gates count as well.
#
# Sections 3 and 4 match hostnames and import specifiers rather than key
# material, so printing their lines was defensible — but it is a property of
# their PATTERNS, not of the sections, and section 3 greps whole config files
# that legitimately carry EXPO_PUBLIC_* values. Since this scan now runs on
# every branch and tag, a work-in-progress config pointing at a tunnel with a
# token in the query string would have been copied into a public log. They count
# like everything else now, so the rule needs no exception to remember.
#
# An earlier version of this comment claimed the rule held everywhere while two
# sweeps still printed lines. Making the claim true was cheaper than maintaining
# the caveat. Run the script locally to see what it found; that output is not
# public.

# ─────────────────────────────────────────────────────────────────────────────
# Sweep-integrity helper. Read this before touching any sweep below.
# ─────────────────────────────────────────────────────────────────────────────
# A GREP THAT DID NOT RUN IS NOT A GREP THAT FOUND NOTHING, and getting that
# distinction right in bash has three separate traps. This file has fallen into
# all three, twice each, so the rule lives in one place now.
#
#   1. `|| true` discards the status outright.
#   2. `set -o pipefail` gives the RIGHTMOST non-zero status, and `grep -c`
#      exits 1 for the ordinary "no match" — so a producer failing with 128
#      followed by a clean grep comes back as 1 and slips past a `-gt 1` guard.
#      Measured: `(exit 128) | grep -zE zzz | tr a b` yields $? = 1.
#   3. PIPESTATUS does NOT survive command substitution. `var=$(a | b)` is a
#      simple command to the caller, so PIPESTATUS afterwards describes the
#      ASSIGNMENT. Every guarded pipeline therefore writes to a file and is run
#      in this shell, never inside `$( )`.
#
# Copy PIPESTATUS in ONE assignment — reading a single element is itself a
# command and resets the array.
SWEEP_TMP="$(mktemp)"
trap 'rm -f "$SWEEP_TMP"' EXIT
# $1 names what PRODUCES the input, because the two kinds differ on exit 1:
#   git   — 1 is a failure. `git ls-files` and `git log` return 0 or they broke.
#   grep  — 1 is the ordinary "no match" and must NOT be treated as a failure.
# Getting this wrong the other way is not harmless either: an over-eager guard
# reports CANNOT RUN on a clean repo, which is a gate that cries wolf, and those
# get deleted rather than obeyed. (First draft of this helper did exactly that —
# it flagged the unpinned-import sweep on every repo with no edge functions.)
# Every LATER stage is a grep, so >1 is the failure signal there.
sweep_broke() {
  local producer="$1"; shift
  case "$producer" in
    git)  [ "${1:-0}" -ne 0 ] && return 0 ;;
    grep) [ "${1:-0}" -gt 1 ] && return 0 ;;
  esac
  local rc
  for rc in "$@"; do
    [ "$rc" -gt 1 ] && return 0
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. No dotenv file may be TRACKED.
# ─────────────────────────────────────────────────────────────────────────────
# `clippar_app/.gitignore` covers `.env*.local` INSIDE THAT DIRECTORY ONLY, and
# the root file covers the bare `.env`. Expo's CLI also loads `.env`,
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
git ls-files -z | grep -zE '(^|/)\.env($|\.)' | grep -zv '\.example$' | tr '\0' '\n' > "$SWEEP_TMP"
env_rcs=("${PIPESTATUS[@]}")
tracked_env="$(cat "$SWEEP_TMP")"
if sweep_broke git "${env_rcs[@]}"; then
  bad "dotenv scan CANNOT RUN (statuses: ${env_rcs[*]})."
  note "A gate that could not run is not a gate that found nothing."
  tracked_env=""
elif [ -n "$tracked_env" ]; then
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
  # The first alternative STOPS AT THE QUOTE'S HIGH NIBBLE — no trailing `I`.
  # It used to carry one, which reached two bits past the closing quote of
  # `"service_role"` and so depended on the byte that FOLLOWS it. A payload whose
  # last claim is the role ends `"service_role"}`, and `}` is 0x7d, whose top
  # bits change that character from `I` to `J`. Measured across realistic
  # Supabase-shaped tokens: the trailing form missed 24 of 148, all of them
  # role-last. My original "27/27 matched" only ever generated tokens with
  # iat/exp AFTER the role, so it could not see this.
  #
  # Precision is unchanged, checked rather than assumed: all three forms
  # (trailing I, no trailing I, explicit [IJ]) match `service_roles` and
  # `service_role_admin` identically, because the THIRD alternative already
  # prefix-matches. Dropping the character costs nothing and covers the gap.
  #
  # Each alternative has ONE character bracketed so this line does not contain
  # its own match text. `[S]` matches `S`, so the regex is unchanged — but the
  # source no longer holds the literal run, which is what previously forced an
  # `:(exclude)` pathspec onto every sweep and made this the one file where a
  # committed-then-deleted credential was invisible to all of them. Do not
  # "tidy" the brackets away.
  'InNlcnZpY2Vfcm9sZ[S]|ZXJ2aWNlX3JvbGU[i]|c2VydmljZV9yb2x[l]'
  'SUPABASE_SERVICE_ROLE_KEY[=:][[:space:]]*["'"'"']?ey[A-Za-z0-9_-]{20,}'
)
# A PEM header is handled separately and ANCHORED to a whole line. This codebase
# legitimately builds a PEM from a base64 secret at runtime (_shared/apple.ts)
# and the auth docs quote the header in prose; both embed it mid-line. Actual key
# material always has the header alone on its own line, which is what this
# matches — and matching prose instead would just train everyone to ignore the
# check.
# UP TO TWO prefix columns, not one. A COMBINED diff — which `--diff-merges=cc`
# turns on for merge commits — uses one prefix column PER PARENT, so a private
# key added while resolving a conflict arrives as `++-----BEGIN ...` and a
# single-character anchor misses it entirely. Measured on a purpose-built merge:
# the one-column form finds 0, this one finds 1.
#
# That makes `--diff-merges=cc` and this anchor a PAIR. Adding the flag without
# widening the anchor was half a fix, and half a fix here is worse than none,
# because it looks like the merge case is covered.
PEM_LINE='^[-+ ]{0,2}[[:space:]]*\-\-\-\-\-BEGIN [A-Z ]*PRIVATE KEY\-\-\-\-\-[[:space:]]*$'
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
self_ref='InNlcnZpY2Vfcm9sZ[S]|ZXJ2aWNlX3JvbGU[i]|c2VydmljZV9yb2x[l]'
# NO `-I`. It tells git grep to skip every file git CLASSIFIES as binary,
# whether or not the credential's bytes are plainly in there — and the
# classification is caller-controllable: one line in `.gitattributes` marking a
# path `binary` makes `git grep -I` skip it entirely, while the bytes stay
# readable to anyone who clones. The filename gate in section 2b cannot
# compensate, because it is an extension allowlist and you cannot enumerate every
# name someone might use (`notes.dat`, `dump.bin`, or no extension at all).
# Dropping the flag closes it structurally: git grep reports binary matches too,
# and -c still counts them.
#
# A GREP THAT DID NOT RUN IS NOT A GREP THAT FOUND NOTHING. grep exits 0 for
# matched, 1 for no match, and >1 for "I could not do it" — a pattern that failed
# to compile, or a read error. The old `|| true` flattened all three into "no
# hits", so a CRED_PATTERNS entry that git grep rejects would be silently
# inactive while the gate reported CLEAN. That matters more since hist_pat became
# derived from this same array: every entry is now compiled by TWO engines
# (git grep -E here, plain grep -E in the history sweep) and they do not accept
# exactly the same dialect, so a future entry can be live in one sweep and dead
# in the other with nothing to show it.
for pat in "${CRED_PATTERNS[@]}"; do
  if [ "$pat" = "$self_ref" ]; then
    hits="$(git grep -cE "$pat" -- . ':(exclude)scripts/secret-scan.sh' 2>&1)"
  else
    hits="$(git grep -cE "$pat" 2>&1)"
  fi
  st=$?
  if [ "$st" -gt 1 ]; then
    bad "working-tree scan CANNOT RUN for one pattern (git grep exit ${st})."
    note "Every CRED_PATTERNS entry must be valid POSIX ERE. A pattern that"
    note "fails to compile is a rule that silently checks nothing."
  elif [ "$st" -eq 0 ] && [ -n "$hits" ]; then
    n_hit="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
    bad "credential-shaped string in the working tree, in ${n_hit} file(s)."
    note "Pattern and locations deliberately not printed — CI logs are public."
    note "Run ./scripts/secret-scan.sh locally to see them."
  fi
done
# No exclusion: PEM_LINE is anchored to a whole line and this file only ever
# mentions the header mid-line, inside the pattern definition.
pem_hits="$(git grep -cE "$PEM_LINE" 2>&1)"
pem_st=$?
if [ "$pem_st" -gt 1 ]; then
  bad "working-tree PEM scan CANNOT RUN (git grep exit ${pem_st})."
  note "See the note on pattern compilation above."
  pem_hits=""
fi
if [ "$pem_st" -eq 0 ] && [ -n "$pem_hits" ]; then
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
# not. One of the shapes above sat in exactly that gap while a real key of that
# shape was in a pushed blob, and this sweep still printed "history clean".
# Deriving it here is what stops the two lists drifting again; the
# pathspec keeps the pattern definitions above from matching themselves.
# ONE alternation, built by filtering the same array so it cannot drift from
# CRED_PATTERNS. There used to be a second, unfiltered `hist_pat` beside this —
# dead, since both passes run on hist_pat_rest and self_ref, whose union is the
# full set. A dead alternation sitting next to two live ones, in the file whose
# whole argument is "these lists must not drift", is what gets edited by
# mistake.
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
hist_broken=0
if [ "$shallow" = "true" ]; then
  hist_n=0
else
  # Same rule as the working-tree sweep: >1 means the grep did not run. With
  # `set -o pipefail` on, a git log failure surfaces here too, so neither can be
  # mistaken for "no matches".
  # `--text` and `--diff-merges=cc` are BOTH load-bearing and neither is
  # cosmetic. Measured on a purpose-built repo, planted key vs. matches found:
  #
  #   without --text ............... 0   with it ... 2
  #   without --diff-merges=cc ..... 0   with it ... 1
  #
  # --text: `git log -p` makes its OWN binary decision from the `diff`
  # gitattribute, before grep ever sees a byte, and renders the blob as
  # "Binary files ... differ". `grep -a` cannot help — the bytes never reach it.
  # `.gitattributes` is a tracked, PR-editable file, so the blinding travels in
  # the same push as the credential; and a repo that later adds an LFS line or
  # `*.json binary` blinds this sweep by accident.
  #
  # --diff-merges=cc: plain `git log -p` shows NO diff for a merge commit, so
  # content that exists in neither parent — a credential typed into a
  # hand-resolved conflict — is invisible to this sweep entirely. That is not a
  # hypothetical shape in this repository: this very branch is a hand-resolved
  # merge of two others.
  #
  # Keep `grep -a` as well. The two flags fix two different decisions and neither
  # substitutes for the other. And never put `-I` back on the same grep as `-a`:
  # they set the same option, so whichever is last silently wins.
  # PIPESTATUS, not `$?`, and this is not style — `set -o pipefail` is ACTIVELY
  # WRONG for this pipeline. pipefail yields the RIGHTMOST non-zero status, and
  # `grep -c` exits 1 for the entirely normal "no match". So when `git log`
  # fails with 128 and grep then reports no match, the pipeline status is 1, a
  # `-gt 1` guard does not fire, and the sweep that never ran is reported as
  # "history clean". Measured, not reasoned: `(exit 128) | grep -acE zzzz`
  # yields $? = 1 under pipefail.
  #
  # Copy the WHOLE array in one assignment. Reading ${PIPESTATUS[0]} into a
  # variable is itself a command, which resets PIPESTATUS to a single element,
  # so a later read of [1] is unbound under `set -u`.
  # Runs the pipeline in THIS shell and writes to files, never inside `$( )`.
  # PIPESTATUS does not survive command substitution: `out=$(a | b)` is a simple
  # command to the calling shell, so PIPESTATUS afterwards describes the
  # ASSIGNMENT and not the inner pipeline. Capturing the count that way made the
  # guard read a stale single-element array — a false-clean one layer below the
  # false-clean it was added to prevent. Caught by it firing on a clean repo.
  hist_err="$(mktemp)"; hist_out="$(mktemp)"
  hist_sweep() {
    local pat="$1"; shift
    git log -p --all --full-history --diff-merges=cc --text --no-color -U0 "$@" 2>"$hist_err" \
      | grep --binary-files=text -cE "$pat" >"$hist_out"
    # Copy the WHOLE array in one assignment. Reading ${PIPESTATUS[0]} into a
    # variable is itself a command, which resets PIPESTATUS to a single element,
    # so a later read of [1] is unbound under `set -u`.
    local rcs=("${PIPESTATUS[@]}")
    # rcs[0] is git log: non-zero means the log could not be read.
    # rcs[1] is grep: 0 matched, 1 no match, >1 could not run (bad pattern).
    if [ "${rcs[0]}" -ne 0 ]; then
      hist_broken=1
      hist_why="git log failed (rc=${rcs[0]}): $(head -1 "$hist_err")"
      SWEEP_N=0
      return
    fi
    if [ "${rcs[1]}" -gt 1 ]; then
      hist_broken=1
      hist_why="grep rejected the pattern set (rc=${rcs[1]})"
      SWEEP_N=0
      return
    fi
    SWEEP_N="$(cat "$hist_out" 2>/dev/null || echo 0)"
  }
  # Called PLAINLY, never as `$(hist_sweep ...)`. Command substitution forks a
  # subshell, so `hist_broken=1` set inside one is discarded and the caller sees
  # a clean zero. The result comes back in SWEEP_N for the same reason.
  hist_why=""
  SWEEP_N=0
  hist_sweep "$hist_pat_rest"; hist_all="$SWEEP_N"
  hist_sweep "$self_ref" -- . ':(exclude)scripts/secret-scan.sh'; hist_self="$SWEEP_N"
  rm -f "$hist_err" "$hist_out"
  hist_n=$(( ${hist_all:-0} + ${hist_self:-0} ))
fi
if [ "$shallow" = "true" ]; then
  bad "history scan CANNOT RUN: this is a shallow clone."
  note "A key that was committed and then deleted is invisible from here, so"
  note "\"clean\" would be a false statement, not a pass. Re-run with full"
  note "history: fetch-depth: 0 in CI, or 'git fetch --unshallow' locally."
elif [ "$hist_broken" = "1" ]; then
  bad "history scan CANNOT RUN — ${hist_why:-reason unknown}"
  note "\"I cannot see history\" and \"history is clean\" are different sentences."
  note "Every CRED_PATTERNS entry must be valid POSIX ERE for plain grep -E, not"
  note "only for git grep -E."
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
BINDOC="$BINDOC"'|[.](p8|p12|pfx|jks|keystore|bcfks|kdbx|mobileprovision|cer|der|sqlite3?|db)$'
BINDOC="$BINDOC"'|[.](apk|aab|ipa)$'
# `-z` for the quoting reason given in full at the dotenv check above: without
# it a single accented character in the filename walks straight past this gate.
# BINDOC is hand-edited every time an extension is added — the comment above
# invites it — so an unbalanced paren here would silently disable the one check
# that can see a credential inside a binary document.
git ls-files -z | grep -zEi "$BINDOC" | tr '\0' '\n' > "$SWEEP_TMP"
bin_rcs=("${PIPESTATUS[@]}")
tracked_bin="$(cat "$SWEEP_TMP")"
if sweep_broke git "${bin_rcs[@]}"; then
  bad "binary-document scan CANNOT RUN (statuses: ${bin_rcs[*]})."
  note "BINDOC must be valid POSIX ERE."
  tracked_bin=""
elif [ -n "$tracked_bin" ]; then
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
  # `--diff-merges=cc` for the same reason as the credential sweep above: without
  # it a file first appearing in a hand-resolved merge is named by nothing here.
  git log --all --full-history --diff-merges=cc --pretty=format: --name-only -z --diff-filter=AMR \
    | tr '\0' '\n' | sort -u | grep -icE "$BINDOC" > "$SWEEP_TMP"
  hb_rcs=("${PIPESTATUS[@]}")
  hist_bin="$(cat "$SWEEP_TMP")"
  if sweep_broke git "${hb_rcs[@]}"; then
    bad "binary-document HISTORY scan CANNOT RUN (statuses: ${hb_rcs[*]})."
    note "Silence here would read as \"none in history\", which is the one thing"
    note "this section must never say when it could not look."
    hist_bin=0
  fi
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
  # Single command, so `$?` is the grep's own status and PIPESTATUS is not
  # needed — but the `|| true` still had to go: a malformed NONPROD would have
  # printed the affirmative "references no dev/local host", which reads as a
  # stronger pass than mere silence.
  hits="$(grep -InE "$NONPROD" "$f")"
  np_st=$?
  if [ "$np_st" -gt 1 ]; then
    bad "non-production endpoint scan CANNOT RUN for $f (grep exit ${np_st})."
    note "NONPROD must be valid POSIX ERE."
    nonprod_hit=1
  elif [ "$np_st" -eq 0 ] && [ -n "$hits" ]; then
    n_np="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
    bad "non-production endpoint in $f, on ${n_np} line(s)."
    nonprod_hit=1
    note "Lines deliberately not printed — CI logs are public. Run"
    note "./scripts/secret-scan.sh locally to see them."
  fi
done
# Same rule: `nonprod_hit` is set on a CANNOT RUN too, so the all-clear cannot
# print after one.
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
  grep -rnE "from[[:space:]]+['\"]https://(deno\.land|esm\.sh)/" \
      clippar_app/supabase/functions --include='*.ts' \
    | grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | grep -vE '@[0-9]' > "$SWEEP_TMP"
  up_rcs=("${PIPESTATUS[@]}")
  unpinned="$(cat "$SWEEP_TMP")"
  up_broke=0
  if sweep_broke grep "${up_rcs[@]}"; then
    up_broke=1
    bad "unpinned-import scan CANNOT RUN (statuses: ${up_rcs[*]})."
    note "A failure here used to print \"all remote imports carry an @version\","
    note "which reads as a stronger pass than silence would."
    unpinned=""
  fi
  if [ -n "$unpinned" ]; then
    n_up="$(printf '%s\n' "$unpinned" | wc -l | tr -d ' ')"
    bad "unversioned remote import(s): ${n_up} line(s)."
    note "Lines deliberately not printed — CI logs are public. Run"
    note "./scripts/secret-scan.sh locally to see them."
  elif [ "$up_broke" = "0" ]; then
    # Only claim the all-clear when the sweep actually ran. Printing it after a
    # CANNOT RUN in the same section is a self-contradicting log, and the
    # reassuring half is the one people remember.
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
