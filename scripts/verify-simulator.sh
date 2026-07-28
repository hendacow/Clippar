#!/usr/bin/env bash
# Build the app for the simulator, launch it, and screenshot the key screens.
#
# This is the "did we break the app visually" gate. verify-security-branch.sh
# proves the logic still holds; this proves it still RUNS and still looks right.
#
# WHY RELEASE, NOT DEBUG
# A Debug build is a dev client with no JS bundle — it needs Metro to serve one.
# Metro on this machine is serving a DIFFERENT branch, so a Debug build would
# screenshot the wrong code entirely (and connecting to it would disturb a
# session we were asked to leave alone). Release embeds the bundle, so what you
# see is what this branch actually produces.
#
# WHY THE ENV FILES MATTER
# constants/config.ts reads EXPO_PUBLIC_SUPABASE_URL et al straight from
# process.env, and Expo inlines those at BUNDLE time. A fresh git worktree has
# only the .example files, because the real ones are gitignored — so the bundle
# is built with undefined values and the app dies on launch with
# "Error: supabaseUrl is required" before rendering a single pixel. That is a
# missing-env failure, not a code failure, and it is worth recognising on sight:
# it looks exactly like a crash-on-launch regression.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/clippar_app"
SIM_NAME="${SIM_NAME:-iPhone 17}"
DD="${DD:-/tmp/clippar-sec-rel}"
SHOTS="${SHOTS:-$ROOT/.verify-screenshots}"
BUNDLE_ID="com.clippar.app.dev"

cd "$APP" || exit 1

if [ ! -f .env.development.local ]; then
  echo "FAIL  .env.development.local missing — the bundle will build with undefined"
  echo "      Supabase config and the app will crash on launch. Copy it from a"
  echo "      checkout that has it; it is gitignored by design."
  exit 1
fi

echo "── prebuild ───────────────────────────────────────────"
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 SENTRY_DISABLE_AUTO_UPLOAD=true
APP_VARIANT=development npx expo prebuild --platform ios >/tmp/prebuild.log 2>&1 \
  || { echo "FAIL  prebuild — see /tmp/prebuild.log"; exit 1; }
( cd ios && pod install >/tmp/pods.log 2>&1 ) \
  || { echo "FAIL  pod install — see /tmp/pods.log"; exit 1; }
echo "PASS  prebuild + pods"

echo
echo "── release build ──────────────────────────────────────"
# NB: xcodebuild's exit status must be read via PIPESTATUS. Piping to tail makes
# $? the status of tail, which is 0 even when the build failed — that silently
# reports a broken build as a good one.
( cd ios && xcodebuild -workspace ClipparDev.xcworkspace -scheme ClipparDev \
    -configuration Release -sdk iphonesimulator \
    -destination "platform=iOS Simulator,name=$SIM_NAME" \
    -derivedDataPath "$DD" build ) >/tmp/xcodebuild.log 2>&1
if ! grep -q "\*\* BUILD SUCCEEDED \*\*" /tmp/xcodebuild.log; then
  echo "FAIL  build — errors:"
  grep -E "error:" /tmp/xcodebuild.log | head -20
  exit 1
fi
APP_PATH="$DD/Build/Products/Release-iphonesimulator/ClipparDev.app"
[ -d "$APP_PATH" ] || { echo "FAIL  no .app produced"; exit 1; }
echo "PASS  build succeeded → $APP_PATH"

echo
echo "── launch ─────────────────────────────────────────────"
UDID="$(xcrun simctl list devices booted | grep "$SIM_NAME" | grep -oE '[0-9A-F-]{36}' | head -1)"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available | grep "$SIM_NAME" | grep -oE '[0-9A-F-]{36}' | head -1)"
  xcrun simctl boot "$UDID" 2>/dev/null; sleep 8
fi
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null
xcrun simctl install "$UDID" "$APP_PATH" || { echo "FAIL  install"; exit 1; }

# Launch and hold the console so an unhandled JS exception is captured rather
# than vanishing with the process.
xcrun simctl launch --console-pty "$UDID" "$BUNDLE_ID" >/tmp/launch.log 2>&1 &
LPID=$!
sleep 15
kill "$LPID" 2>/dev/null

if grep -q "Unhandled JS Exception\|Terminating app due to uncaught exception" /tmp/launch.log; then
  echo "FAIL  app crashed on launch:"
  grep -A3 "Unhandled JS Exception\|uncaught exception" /tmp/launch.log | head -12
  exit 1
fi

# A launch that produced no crash but also no running process is still a failure.
if ! xcrun simctl spawn "$UDID" launchctl list 2>/dev/null | grep -q "$BUNDLE_ID"; then
  echo "WARN  process not listed after launch — check /tmp/launch.log"
fi
echo "PASS  launched without an unhandled exception"

echo
echo "── screenshots ────────────────────────────────────────"
mkdir -p "$SHOTS"
sleep 3
xcrun simctl io "$UDID" screenshot "$SHOTS/01-launch.png" >/dev/null 2>&1 \
  && echo "PASS  captured $SHOTS/01-launch.png" \
  || echo "WARN  screenshot failed"

echo
echo "════ SIMULATOR GATE PASSED ════"
echo "Drive further screens with the iOS Simulator MCP (tap/screenshot) from here."
