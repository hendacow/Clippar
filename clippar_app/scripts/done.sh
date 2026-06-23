#!/usr/bin/env bash
#
# done.sh — run as the FINAL step of a feature session, once the work is built,
# seen rendering in the browser, and passed the reviewer subagent.
#
# It runs the verify gate, fires an automatic desktop/push notification (no
# confirmation needed), and drops a structured result into a shared inbox that
# the "command" Claude session reads to deliver Henry the full review.
#
#   npm run done
#
set -uo pipefail

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SAFE="${BRANCH//\//-}"
INBOX="/tmp/clippar-done"
LOG="/tmp/clippar-verify-${SAFE}.log"
mkdir -p "$INBOX"

echo "→ running verify gate for ${BRANCH} …"
if npm run verify >"$LOG" 2>&1; then
  STATUS="PASS"
else
  STATUS="FAIL"
fi
SUMMARY="$(git log -1 --pretty=%s 2>/dev/null || echo 'no commit yet')"
WHEN="$(date '+%H:%M')"

# Automatic notification — no confirmation, works from any session/hook.
osascript -e "display notification \"${BRANCH} — verify ${STATUS}\" with title \"Clippar: feature done\" subtitle \"${SUMMARY}\"" 2>/dev/null || true
printf '\a'  # terminal bell as a fallback

# Structured result for the command session to pick up and review.
cat >"${INBOX}/${SAFE}.json" <<EOF
{
  "branch": "${BRANCH}",
  "status": "${STATUS}",
  "summary": "${SUMMARY}",
  "verifyLog": "${LOG}",
  "finishedAt": "${WHEN}",
  "reviewed": false
}
EOF

echo "✓ ${BRANCH}: verify ${STATUS} — notified Henry, result in ${INBOX}/${SAFE}.json"
[ "$STATUS" = "FAIL" ] && echo "  (verify failed — see $LOG; do NOT mark this feature done)"
exit 0
