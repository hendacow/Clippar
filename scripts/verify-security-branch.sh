#!/usr/bin/env bash
# Regression gate for the security/hardening branch.
#
# Baseline recorded on the clean cut of origin/main @ 57c865d, 2026-07-29:
#   tests     151 pass / 0 fail
#   typecheck clean
#
# Any change that lands on this branch must still clear both. A new test is
# expected to RAISE the pass count; it must never lower it, and a fail is a
# stop-the-line event, not something to explain away.
set -uo pipefail

BASELINE_PASS=151
APP="$(cd "$(dirname "$0")/../clippar_app" && pwd)"
cd "$APP" || exit 1

fail=0

echo "── typecheck ──────────────────────────────────────────"
if npx tsc --noEmit; then
  echo "PASS  typecheck clean"
else
  echo "FAIL  typecheck errors above"
  fail=1
fi

echo
echo "── tests ──────────────────────────────────────────────"
out="$(npm test 2>&1)"
echo "$out" | tail -12
pass="$(echo "$out" | grep -E '^ℹ pass ' | awk '{print $3}')"
bad="$(echo "$out"  | grep -E '^ℹ fail ' | awk '{print $3}')"

if [ "${bad:-1}" != "0" ]; then
  echo "FAIL  ${bad} failing test(s)"
  fail=1
elif [ "${pass:-0}" -lt "$BASELINE_PASS" ]; then
  echo "FAIL  pass count ${pass} is below the ${BASELINE_PASS} baseline — a test was deleted or skipped"
  fail=1
else
  echo "PASS  ${pass}/${pass} (baseline ${BASELINE_PASS})"
fi

echo
echo "── edge functions (deno) ──────────────────────────────"
# The app's tsconfig EXCLUDES supabase/functions (they use https: imports that
# tsc cannot resolve), so `npm run typecheck` has never covered the backend at
# all. Deno checks them properly; without this a broken edge function ships
# green.
if command -v deno >/dev/null 2>&1; then
  for f in "$APP"/supabase/functions/*/index.ts "$APP"/supabase/functions/_shared/*.ts; do
    case "$f" in *.test.ts) continue ;; esac
    [ -f "$f" ] || continue
    if ! deno check --quiet "$f" 2>&1; then
      echo "FAIL  deno check ${f#$APP/}"
      fail=1
    fi
  done
  [ "$fail" = "0" ] && echo "PASS  all edge functions typecheck"

  dt="$(deno test --quiet "$APP"/supabase/functions/_shared/ 2>&1 | tail -3)"
  echo "$dt"
  echo "$dt" | grep -q "0 failed" || { echo "FAIL  deno tests"; fail=1; }
else
  echo "SKIP  deno not on PATH — edge functions unverified"
fi

echo
if [ "$fail" = "0" ]; then
  echo "════ GREEN — safe to continue ════"
else
  echo "════ RED — do not merge ════"
fi
exit "$fail"
