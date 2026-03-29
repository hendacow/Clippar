"""
merge_clips.py — merge all shot clips from outputs/shots into one video

Behaviour
---------
- Reads all .mp4 / .mov files from the shots output folder
- Sorts them by filename (clip001_... clip002_... preserves original order)
- Always skips *_annotated* clips (e.g. clip001_IMG_6143_annotated.mov)
- By default skips *_no_detection* clips — pass --include-no-detection to keep them
- All clips are re-encoded to a common resolution + FPS before concat so
  ffmpeg never chokes on mismatched streams
- Target resolution / FPS can be set in config.yaml or overridden on the CLI
- A plain-text summary log is written alongside the merged video
- Requires ffmpeg on PATH (same dependency as shot_detector.py)

Usage
-----
    python merge_clips.py                        # uses config.yaml
    python merge_clips.py --include-no-detection # include no-shot clips
    python merge_clips.py --output my_session.mov
    python merge_clips.py --width 1920 --height 1080 --fps 30
"""

import argparse
import csv
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yaml

# ════════════════════════════════════════════════════════════════
# Config
# ════════════════════════════════════════════════════════════════

DEFAULTS = dict(
    shots_dir      = "outputs/shots",       # folder produced by shot_detector.py
    merged_output  = "outputs/merged.mov",  # final output path
    target_width   = 0,                     # 0 = use first clip's width
    target_height  = 0,                     # 0 = use first clip's height
    target_fps     = 0,                     # 0 = use first clip's fps
    video_codec    = "libx264",             # libx264 or libx265
    crf            = 18,                    # quality: 0=lossless, 23=default, 28=smaller
    audio_codec    = "aac",
    audio_bitrate  = "192k",
    include_no_detection = True,           # include *_no_detection* clips
    sort_order     = "filename",            # "filename" only for now
    write_log      = True,                  # write a .txt summary next to output
    verbose        = True,
)

VIDEO_EXTENSIONS = (".mp4", ".mov")


def load_config(path="config.yaml"):
    cfg = DEFAULTS.copy()
    p = Path(path)
    if p.exists():
        with open(p) as f:
            user = yaml.safe_load(f) or {}
        # Only pick up merge-relevant keys from config.yaml
        for k in DEFAULTS:
            if k in user:
                cfg[k] = user[k]
        print(f"[Merge] Loaded '{path}'")
    else:
        print(f"[Merge] '{path}' not found — using defaults")
    return cfg


# ════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════

def ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def probe_clip(path):
    """Return (width, height, fps, duration_sec) for a clip via ffprobe.
    Accounts for rotation metadata so portrait videos report correct dimensions."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,duration",
        "-of", "csv=p=0",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    parts = result.stdout.strip().split(",")
    if len(parts) < 4:
        return None
    try:
        w   = int(parts[0])
        h   = int(parts[1])
        num, den = parts[2].split("/")
        fps = round(float(num) / float(den), 3)
        dur = float(parts[3]) if parts[3] else 0.0
    except Exception:
        return None

    # Check for rotation metadata (iPhone portrait videos store as 1920x1080 + rotation=-90)
    rot_cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream_side_data=rotation",
        "-of", "csv=p=0",
        str(path),
    ]
    rot_result = subprocess.run(rot_cmd, capture_output=True, text=True)
    rot_str = rot_result.stdout.strip()
    if rot_str:
        try:
            rotation = abs(int(float(rot_str)))
            if rotation in (90, 270):
                w, h = h, w
        except (ValueError, TypeError):
            pass

    return w, h, fps, dur


def format_time(s):
    s = max(0, s)
    return f"{int(s // 3600):02d}:{int((s % 3600) // 60):02d}:{int(s % 60):02d}"


def collect_clips(shots_dir, include_no_detection):
    """
    Return sorted list of clips from shots_dir.
    Sorting by filename naturally preserves clip001_ < clip002_ order.
    Always excludes *_annotated* clips.
    """
    shots_dir = Path(shots_dir)
    if not shots_dir.exists():
        print(f"[Merge] ERROR: shots_dir '{shots_dir}' does not exist.")
        sys.exit(1)

    clips = []
    for ext in VIDEO_EXTENSIONS:
        clips.extend(shots_dir.glob(f"*{ext}"))
        clips.extend(shots_dir.glob(f"*{ext.upper()}"))

    # Deduplicate (case-insensitive filesystems)
    seen, unique = set(), []
    for c in sorted(clips, key=lambda p: p.name.lower()):
        key = c.resolve()
        if key not in seen:
            seen.add(key)
            unique.append(c)

    # Always skip annotated clips
    before = len(unique)
    unique = [c for c in unique if "_annotated" not in c.name.lower()]
    skipped = before - len(unique)
    if skipped:
        print(f"[Merge] Skipped {skipped} annotated clip(s) (clips with '_annotated' in filename)")

    if not include_no_detection:
        before = len(unique)
        unique = [c for c in unique if "_no_detection" not in c.name]
        skipped = before - len(unique)
        if skipped:
            print(f"[Merge] Skipped {skipped} no-detection clip(s) "
                  f"(pass --include-no-detection to keep them)")

    return unique


def resolve_target(clips, cfg):
    """
    Determine the target width, height, and fps.
    If any dimension is 0 in config, use the first clip's value.
    """
    tw = cfg["target_width"]
    th = cfg["target_height"]
    tf = cfg["target_fps"]

    if tw == 0 or th == 0 or tf == 0:
        info = probe_clip(clips[0])
        if info is None:
            print(f"[Merge] ERROR: could not probe '{clips[0].name}' — is ffprobe installed?")
            sys.exit(1)
        w0, h0, fps0, _ = info
        if tw == 0: tw = w0
        if th == 0: th = h0
        if tf == 0: tf = fps0
        print(f"[Merge] Target resolution from first clip: {tw}x{th} @ {tf}fps")
    else:
        print(f"[Merge] Target resolution from config: {tw}x{th} @ {tf}fps")

    return tw, th, tf


# ════════════════════════════════════════════════════════════════
# Pre-flight check — report any mismatches before encoding
# ════════════════════════════════════════════════════════════════

def preflight(clips, tw, th, tf, verbose):
    """
    Probe every clip and report resolution / FPS.
    Mismatches are warnings, not errors — ffmpeg will scale them.
    Returns list of (path, width, height, fps, duration) tuples.
    """
    print(f"\n[Merge] Pre-flight check ({len(clips)} clip(s))...")
    infos = []
    mismatches = []
    total_dur = 0.0

    for c in clips:
        info = probe_clip(c)
        if info is None:
            print(f"  ⚠  Could not probe: {c.name} — skipping")
            continue
        w, h, fps, dur = info
        infos.append((c, w, h, fps, dur))
        total_dur += dur
        match = (w == tw and h == th and abs(fps - tf) < 0.1)
        flag  = "" if match else "  ← will be rescaled"
        if not match:
            mismatches.append(c.name)
        if verbose:
            print(f"  {c.name:<55}  {w}x{h} @ {fps}fps  {dur:.1f}s{flag}")

    print(f"\n  {len(infos)} clip(s) OK  |  "
          f"{len(mismatches)} will be rescaled  |  "
          f"total runtime ~{format_time(total_dur)}")
    return infos, total_dur


# ════════════════════════════════════════════════════════════════
# Core merge — normalise → concat
# ════════════════════════════════════════════════════════════════

def normalise_clip(src, dst, tw, th, tf, vcodec, crf, acodec, abitrate):
    """
    Re-encode src to dst at target resolution/fps.
    Uses scale+pad to letterbox if aspect ratio differs.
    """
    # scale to fit within tw x th, pad the rest with black
    vf = (
        f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
        f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:black,"
        f"fps={tf}"
    )
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src),
        "-vf", vf,
        "-c:v", vcodec,
        "-crf", str(crf),
        "-preset", "fast",
        "-c:a", acodec,
        "-b:a", abitrate,
        "-ar", "44100",      # normalise sample rate — prevents concat audio glitches
        "-ac", "2",          # stereo
        str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        print(f"\n  [ffmpeg] ERROR normalising {Path(src).name}:")
        print(result.stderr[-400:].decode(errors="replace"))
        return False
    return True


def build_concat_list(norm_paths, list_path):
    """Write an ffmpeg concat demuxer file."""
    with open(list_path, "w") as f:
        for p in norm_paths:
            # ffmpeg concat list needs forward slashes and escaped single quotes
            safe = str(p).replace("'", "'\\''")
            f.write(f"file '{safe}'\n")


def concat_clips(list_path, output_path, vcodec, crf, acodec, abitrate):
    """Concatenate pre-normalised clips via ffmpeg concat demuxer."""
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_path),
        "-c:v", vcodec,
        "-crf", str(crf),
        "-preset", "fast",
        "-c:a", acodec,
        "-b:a", abitrate,
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        print(f"\n[Merge] ERROR during concat:")
        print(result.stderr[-600:].decode(errors="replace"))
        return False
    return True


# ════════════════════════════════════════════════════════════════
# Log writer
# ════════════════════════════════════════════════════════════════

def write_log(output_path, infos, tw, th, tf, total_dur, elapsed):
    log_path = Path(output_path).with_suffix(".txt")
    with open(log_path, "w") as f:
        f.write("GOLF SHOT MERGE LOG\n")
        f.write("=" * 60 + "\n")
        f.write(f"Output      : {Path(output_path).name}\n")
        f.write(f"Resolution  : {tw}x{th} @ {tf}fps\n")
        f.write(f"Clips merged: {len(infos)}\n")
        f.write(f"Total runtime: {format_time(total_dur)}\n")
        f.write(f"Processing time: {elapsed:.1f}s\n")
        f.write("\nCLIPS (in merge order)\n")
        f.write("-" * 60 + "\n")

        cumulative = 0.0
        writer = csv.writer(f)
        writer.writerow(["#", "filename", "start_in_merged", "duration",
                         "original_res", "original_fps"])
        for i, (c, w, h, fps, dur) in enumerate(infos, start=1):
            writer.writerow([
                i,
                c.name,
                format_time(cumulative),
                f"{dur:.2f}s",
                f"{w}x{h}",
                f"{fps}",
            ])
            cumulative += dur

    print(f"[Merge] Log written → {log_path.name}")


# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════

def merge(cfg):
    if not ffmpeg_available():
        print("[Merge] ERROR: ffmpeg not found on PATH — cannot merge clips.")
        sys.exit(1)

    clips = collect_clips(cfg["shots_dir"], cfg["include_no_detection"])
    if not clips:
        print(f"[Merge] No clips found in '{cfg['shots_dir']}' — nothing to merge.")
        sys.exit(0)

    print(f"[Merge] {len(clips)} clip(s) to merge → {cfg['merged_output']}")

    tw, th, tf = resolve_target(clips, cfg)
    infos, total_dur = preflight(clips, tw, th, tf, cfg["verbose"])

    if not infos:
        print("[Merge] No valid clips after pre-flight — aborting.")
        sys.exit(1)

    output_path = Path(cfg["merged_output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    start = time.time()

    # Work in a temp dir — normalised clips live here temporarily
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        norm_paths = []
        failed     = []

        print(f"\n[Merge] Normalising {len(infos)} clip(s) to {tw}x{th} @ {tf}fps...")
        for i, (c, w, h, fps, dur) in enumerate(infos, start=1):
            # Keep same extension as source so container is consistent
            norm_dst = tmpdir / f"{i:04d}{c.suffix.lower()}"
            needs_encode = (w != tw or h != th or abs(fps - tf) >= 0.1)

            if needs_encode:
                print(f"  [{i}/{len(infos)}] rescaling  {c.name}")
                ok = normalise_clip(
                    c, norm_dst, tw, th, tf,
                    cfg["video_codec"], cfg["crf"],
                    cfg["audio_codec"], cfg["audio_bitrate"],
                )
            else:
                # Already matches target — re-encode anyway to guarantee
                # identical codec/container so concat never mismatches
                print(f"  [{i}/{len(infos)}] encoding   {c.name}")
                ok = normalise_clip(
                    c, norm_dst, tw, th, tf,
                    cfg["video_codec"], cfg["crf"],
                    cfg["audio_codec"], cfg["audio_bitrate"],
                )

            if ok:
                norm_paths.append(norm_dst)
            else:
                failed.append(c.name)

        if failed:
            print(f"\n[Merge] WARNING: {len(failed)} clip(s) failed normalisation "
                  f"and will be skipped:")
            for name in failed:
                print(f"  {name}")

        if not norm_paths:
            print("[Merge] No clips survived normalisation — aborting.")
            sys.exit(1)

        # Build concat list and merge
        list_path = tmpdir / "concat.txt"
        build_concat_list(norm_paths, list_path)

        print(f"\n[Merge] Concatenating {len(norm_paths)} clip(s)...")
        ok = concat_clips(
            list_path, output_path,
            cfg["video_codec"], cfg["crf"],
            cfg["audio_codec"], cfg["audio_bitrate"],
        )

    elapsed = time.time() - start

    if not ok:
        print("[Merge] Merge failed — check ffmpeg output above.")
        sys.exit(1)

    size_mb = output_path.stat().st_size / 1_048_576
    print(f"\n{'='*52}")
    print(f"  MERGE COMPLETE")
    print(f"{'='*52}")
    print(f"  Output   : {output_path}")
    print(f"  Size     : {size_mb:.1f} MB")
    print(f"  Runtime  : {format_time(total_dur)}")
    print(f"  Clips    : {len(norm_paths)}")
    if failed:
        print(f"  Skipped  : {len(failed)} (failed normalisation)")
    print(f"  Time     : {elapsed:.1f}s")
    print(f"{'='*52}\n")

    if cfg["write_log"]:
        # Rebuild infos for log using only the clips that succeeded
        succeeded = [inf for inf in infos if inf[0].name not in failed]
        write_log(output_path, succeeded, tw, th, tf, total_dur, elapsed)


# ════════════════════════════════════════════════════════════════
# Entry point
# ════════════════════════════════════════════════════════════════

def parse_args():
    p = argparse.ArgumentParser(description="Merge golf shot clips into one video")
    p.add_argument("--shots-dir",            default=None,
                   help="Folder of shot clips (default: from config.yaml)")
    p.add_argument("--output",               default=None,
                   help="Output file path (default: from config.yaml)")
    p.add_argument("--include-no-detection", action="store_true",
                   help="Include *_no_detection* clips in the merge")
    p.add_argument("--width",                type=int, default=None)
    p.add_argument("--height",               type=int, default=None)
    p.add_argument("--fps",                  type=float, default=None)
    p.add_argument("--crf",                  type=int, default=None,
                   help="Video quality 0-51 (lower=better, 18=default)")
    p.add_argument("--config",               default="config.yaml")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    cfg  = load_config(args.config)

    # CLI overrides config
    if args.shots_dir:            cfg["shots_dir"]             = args.shots_dir
    if args.output:               cfg["merged_output"]         = args.output
    if args.include_no_detection: cfg["include_no_detection"]  = True
    if args.width:                cfg["target_width"]          = args.width
    if args.height:               cfg["target_height"]         = args.height
    if args.fps:                  cfg["target_fps"]            = args.fps
    if args.crf:                  cfg["crf"]                   = args.crf

    merge(cfg)
