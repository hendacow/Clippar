#!/usr/bin/env bash
# Extract web-optimized demo clips for the landing page
# Output: static/landing_assets/*.mp4 (H.264, CRF 28, max 720px wide)

set -euo pipefail
OUT="static/landing_assets"
mkdir -p "$OUT"

# Common ffmpeg flags: H.264, CRF 28, scale to max 720px wide, fast web start
VFLAG="-vf scale='min(720,iw)':-2 -c:v libx264 -preset medium -crf 28 -movflags +faststart -an"

echo "==> demo_raw.mp4  (5s raw footage)"
ffmpeg -y -ss 2 -t 5 -i "inputs/IMG_3622.MOV" \
  -vf "scale='min(720,iw)':-2" -c:v libx264 -preset medium -crf 28 -movflags +faststart -an \
  "$OUT/demo_raw.mp4"

echo "==> demo_detected.mp4  (5s skeleton overlay)"
ffmpeg -y -ss 1 -t 5 -i "validation_runs/post_patch_check/clips/clip001_IMG_3623_annotated.mov" \
  -vf "scale='min(720,iw)':-2" -c:v libx264 -preset medium -crf 28 -movflags +faststart -an \
  "$OUT/demo_detected.mp4"

echo "==> demo_clean.mp4  (5s clean output clip)"
ffmpeg -y -ss 0 -t 5 -i "outputs/clips/clip001_IMG_3622_swing01_ball+audio.mov" \
  -vf "scale='min(720,iw)':-2" -c:v libx264 -preset medium -crf 28 -movflags +faststart -an \
  "$OUT/demo_clean.mp4"

echo "==> demo_reel.mp4  (10s highlight reel)"
ffmpeg -y -ss 5 -t 10 -i "outputs/merged/merged.mov" \
  -vf "scale='min(720,iw)':-2" -c:v libx264 -preset medium -crf 28 -movflags +faststart -an \
  "$OUT/demo_reel.mp4"

echo "Done — demo clips in $OUT/"
ls -lh "$OUT"/*.mp4
