#!/usr/bin/env bash
#
# build.sh — compile the three native harnesses the bench drives.
#
#   tracerdet   the shipped tracer ball detector (TracerDetect + TracerDetectCore)   [macOS]
#   svharness   the app's PRIMARY impact estimator, swing-vision                     [macOS + iOS sim]
#   sdharness   the app's FALLBACK impact estimator, ShotDetectorModule.detectAndTrim [iOS sim]
#
# Every module file is compiled from the CHECKED-IN SOURCE, COPIED NOT EDITED.
# The only added file is ExpoShim.swift, standing in for the ExpoModulesCore pod
# (read its header for exactly what it does and does not do).
#
# sdharness is built for the iOS SIMULATOR because ShotDetectorModule.swift
# imports UIKit and calls os_proc_available_memory(), neither of which exists on
# macOS. Shimming those would put a stand-in on the detection path; building for
# the simulator does not. It is run with `xcrun simctl spawn`.
#
# Build artifacts live OUTSIDE the repo, under $BENCH_WORK, so a stray `git add`
# in this shared checkout cannot sweep up a 100 MB compiled model.
#
set -euo pipefail

APP="${APP:-$HOME/projects/clippar/final_shipment/clippar_app}"
BENCH="$APP/docs/tracer-v3/bench"
WORK="${BENCH_WORK:-$HOME/.cache/clippar-tracer-bench}"
IOS="$APP/modules/shot-detector/ios"
SV="$APP/modules/swing-vision/ios"
SIM_TARGET="arm64-apple-ios15.1-simulator"

mkdir -p "$WORK/models"

newer() { [ "$1" -nt "$2" ]; }

# ── models (compiled once; deterministic and slow) ────────────────────────────
[ -d "$WORK/models/GolfBallDetector.mlmodelc" ] || {
  echo "[build] compiling GolfBallDetector.mlpackage"
  xcrun coremlcompiler compile "$IOS/GolfBallDetector.mlpackage" "$WORK/models" >/dev/null; }
[ -d "$WORK/models/MobileCLIP2S2Image.mlmodelc" ] || {
  echo "[build] compiling MobileCLIP2S2Image.mlpackage"
  xcrun coremlcompiler compile "$SV/MobileCLIP2S2Image.mlpackage" "$WORK/models" >/dev/null; }

# ── ExpoModulesCore stand-in, built as a real module for both platforms ───────
build_expo() { # $1 = dir, $2... = extra swiftc flags
  local d="$1"; shift
  mkdir -p "$d"
  if [ ! -f "$d/libExpoModulesCore.dylib" ] || newer "$BENCH/ExpoShim.swift" "$d/libExpoModulesCore.dylib"; then
    echo "[build] ExpoModulesCore shim -> $d"
    ( cd "$d" && xcrun swiftc -O "$@" -emit-module -emit-library -module-name ExpoModulesCore \
        "$BENCH/ExpoShim.swift" -o libExpoModulesCore.dylib \
        -emit-module-path ExpoModulesCore.swiftmodule \
        -Xlinker -install_name -Xlinker "$d/libExpoModulesCore.dylib" )
  fi
}
SDK_SIM="$(xcrun --sdk iphonesimulator --show-sdk-path)"
build_expo "$WORK/expo"
build_expo "$WORK/expo-sim" -sdk "$SDK_SIM" -target "$SIM_TARGET"

# ── 1. tracer detector (macOS) ────────────────────────────────────────────────
D="$WORK/tracerdet"; mkdir -p "$D/ShotDetectorResources.bundle"
cp "$IOS/TracerDetect.swift" "$IOS/TracerDetectCore.swift" "$D/"
cp "$BENCH/mainTracerDet.swift" "$D/main.swift"
[ -d "$D/ShotDetectorResources.bundle/GolfBallDetector.mlmodelc" ] || \
  cp -R "$WORK/models/GolfBallDetector.mlmodelc" "$D/ShotDetectorResources.bundle/"
if [ ! -x "$D/tracerdet" ] || newer "$IOS/TracerDetectCore.swift" "$D/tracerdet" \
   || newer "$IOS/TracerDetect.swift" "$D/tracerdet" || newer "$BENCH/mainTracerDet.swift" "$D/tracerdet"; then
  echo "[build] tracerdet"
  ( cd "$D" && xcrun swiftc -O TracerDetectCore.swift TracerDetect.swift main.swift -o tracerdet 2>&1 \
      | grep -E "error:" || true )
  [ -x "$D/tracerdet" ] || { echo "[build] FAILED: tracerdet"; exit 1; }
fi

# ── 2. swing-vision, the app's primary impact (macOS AND iOS sim) ─────────────
build_sv() { # $1 = dir, $2 = binary name, rest = flags
  local d="$1" bin="$2"; shift 2
  mkdir -p "$d/SwingVisionResources.bundle"
  cp "$SV/SwingLocalizer.swift" "$SV/SwingPose.swift" "$SV/SwingVisionModule.swift" "$d/"
  cp "$SV/swing_prototypes.json" "$d/SwingVisionResources.bundle/"
  cp "$BENCH/mainSwingVision.swift" "$d/main.swift"
  [ -d "$d/SwingVisionResources.bundle/MobileCLIP2S2Image.mlmodelc" ] || \
    cp -R "$WORK/models/MobileCLIP2S2Image.mlmodelc" "$d/SwingVisionResources.bundle/"
  if [ ! -x "$d/$bin" ] || newer "$SV/SwingLocalizer.swift" "$d/$bin" \
     || newer "$BENCH/mainSwingVision.swift" "$d/$bin" || newer "$BENCH/ExpoShim.swift" "$d/$bin"; then
    echo "[build] $bin"
    ( cd "$d" && xcrun swiftc -O "$@" \
        SwingLocalizer.swift SwingPose.swift SwingVisionModule.swift main.swift -o "$bin" 2>&1 \
        | grep -E "error:" || true )
    [ -x "$d/$bin" ] || { echo "[build] FAILED: $bin"; exit 1; }
  fi
}
build_sv "$WORK/svharness" svharness -I "$WORK/expo" -L "$WORK/expo" -lExpoModulesCore
# NOT built for the simulator. The simulator's Core ML cannot run
# MobileCLIP2S2Image ("MpsGraph backend validation on incompatible OS"); every
# prototype score comes back 0 and the localizer silently degenerates to the
# highest raw motion peak while still reporting decision=SWING. See bench.md.

# ── 3. shot-detector detectAndTrim, the app's fallback impact (iOS sim only) ──
T="$WORK/sdharness"; mkdir -p "$T"
cp "$IOS/ShotDetectorModule.swift" "$IOS/ShotTracer.swift" "$IOS/TracerDetect.swift" \
   "$IOS/TracerDetectCore.swift" "$IOS/TracerRenderV3.swift" "$T/"
cp "$BENCH/mainShotDetector.swift" "$T/main.swift"
if [ ! -x "$T/sdharness" ] || newer "$IOS/ShotDetectorModule.swift" "$T/sdharness" \
   || newer "$BENCH/mainShotDetector.swift" "$T/sdharness" || newer "$BENCH/ExpoShim.swift" "$T/sdharness"; then
  echo "[build] sdharness (iOS simulator)"
  ( cd "$T" && xcrun swiftc -O -sdk "$SDK_SIM" -target "$SIM_TARGET" \
      -I "$WORK/expo-sim" -L "$WORK/expo-sim" -lExpoModulesCore \
      -Xlinker -rpath -Xlinker "$WORK/expo-sim" \
      ShotDetectorModule.swift ShotTracer.swift TracerDetect.swift TracerDetectCore.swift \
      TracerRenderV3.swift main.swift -o sdharness 2>&1 | grep -E "error:" | head -25 || true )
  [ -x "$T/sdharness" ] || { echo "[build] FAILED: sdharness"; exit 1; }
fi

# ── source hashes: the detection cache key includes these, so editing any of
#    these files invalidates every cached detection automatically.
shasum -a 256 "$IOS/TracerDetect.swift" "$IOS/TracerDetectCore.swift" | shasum -a 256 | cut -c1-12 > "$WORK/tracerdet.hash"
shasum -a 256 "$SV"/Swing*.swift | shasum -a 256 | cut -c1-12 > "$WORK/svharness.hash"
shasum -a 256 "$IOS/ShotDetectorModule.swift" | shasum -a 256 | cut -c1-12 > "$WORK/sdharness.hash"

echo "[build] ok — $WORK"
