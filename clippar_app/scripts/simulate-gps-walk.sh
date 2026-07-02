#!/usr/bin/env bash
#
# simulate-gps-walk.sh — Tracer V2 V3/V5 helper.
#
# Drives a booted iOS simulator through a scripted GPS "walk" (bag → walk →
# ball) at ~1 Hz via `xcrun simctl location`, so you can watch the continuous
# GPS backbone react:
#   • ~1 Hz [GPS-RING] lines in the Metro logs (per fix, throttled to 1/s),
#   • the record-screen GPS health chip go locking → green,
#   • the STOP-fallback vs IMPACT [GPS-RING] estimator lines when you record.
#
# This is the A1 scenario: the ball sits ~120 m from the bag, so an
# impact-anchored fix must land on the BALL cluster, not the bag.
#
# PREREQS (all device-side — cannot be done headless):
#   1. A booted simulator with the clippar-dev build installed.
#   2. Metro running:  APP_VARIANT=development npx expo start
#      (pipe to a file you can grep:  npm run metro:log  → /tmp/metro-clippar.log)
#   3. The app open on the RECORD tab, in an in-progress round.
#
# USAGE:
#   scripts/simulate-gps-walk.sh [UDID]      # defaults to the booted device
#   # then, in another terminal, watch:  grep --line-buffered GPS-RING /tmp/metro-clippar.log
#
set -euo pipefail

UDID="${1:-booted}"

# Bag (start-press spot) and ball (~120 m north). lat 0.00108° ≈ 120 m.
BAG_LAT=-37.81000; BAG_LON=144.96000
BALL_LAT=-37.80892; BALL_LON=144.96000

setloc() { xcrun simctl location "$UDID" set "$1,$2" >/dev/null; }

echo "[walk] warm-up + standing at the BAG (15s warm-up is excluded by the estimator)…"
for i in $(seq 1 20); do setloc "$BAG_LAT" "$BAG_LON"; sleep 1; done

echo "[walk] >>> PRESS START (record) NOW while standing at the bag, then walk <<<"
sleep 3

echo "[walk] walking BAG → BALL over ~20s (speed gate should exclude these)…"
for i in $(seq 1 20); do
  f=$(echo "scale=8; $i/20" | bc)
  lat=$(echo "scale=8; $BAG_LAT + ($BALL_LAT - $BAG_LAT)*$f" | bc)
  setloc "$lat" "$BAG_LON"; sleep 1
done

echo "[walk] standing at the BALL — set up + swing. >>> STOP recording after the shot <<<"
for i in $(seq 1 20); do setloc "$BALL_LAT" "$BALL_LON"; sleep 1; done

echo "[walk] done. Expect: impact [GPS-RING] fix ~at the ball; STOP-fallback close too."
echo "[walk] reset with:  xcrun simctl location $UDID clear"
