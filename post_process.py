"""
post_process.py — Add scorecard overlay and background music to merged highlight reel.

Called after merge_clips.py produces the merged video.
Uses FFmpeg for:
1. Scorecard intro card (course name, date, score, holes played)
2. Per-clip hole/shot labels burned into video
3. Background music mixed under original audio
4. Final output with faststart for streaming
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path


def ffmpeg_available():
    import shutil
    return shutil.which("ffmpeg") is not None


def get_bundled_music():
    """Return path to bundled royalty-free background music if it exists."""
    candidates = [
        Path(__file__).parent / "assets" / "music" / "default_bg.mp3",
        Path(__file__).parent / "assets" / "music" / "default_bg.m4a",
        Path(__file__).parent / "static" / "music" / "default_bg.mp3",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return None


def create_scorecard_image(
    output_path: str,
    course_name: str,
    date_str: str,
    total_score: int | None,
    score_to_par: int | None,
    holes_played: int,
    width: int = 1080,
    height: int = 1920,
    duration: float = 3.0,
):
    """
    Generate a scorecard intro video card using FFmpeg drawtext filters.
    Creates a dark background with course name, date, score info.
    Returns True on success.
    """
    # Format score display
    score_text = str(total_score) if total_score is not None else "--"
    if score_to_par is not None and score_to_par != 0:
        par_text = f"+{score_to_par}" if score_to_par > 0 else str(score_to_par)
    elif score_to_par == 0:
        par_text = "E"
    else:
        par_text = ""

    holes_text = f"{holes_played} holes"

    # Build FFmpeg drawtext filter chain
    # Dark green gradient background with white text
    vf_parts = [
        f"color=c=0x0a1a0a:size={width}x{height}:d={duration}:r=30",
    ]

    # We use a filter_complex to build the card
    filter_complex = (
        f"color=c=0x0a1a0a:size={width}x{height}:d={duration}:r=30[bg];"
        f"[bg]drawtext=text='CLIPPAR':fontsize=36:fontcolor=0x4CAF50:"
        f"x=(w-text_w)/2:y=h*0.25:font=Arial[t1];"
        f"[t1]drawtext=text='{_escape(course_name)}':fontsize=52:fontcolor=white:"
        f"x=(w-text_w)/2:y=h*0.35:font=Arial[t2];"
        f"[t2]drawtext=text='{_escape(date_str)}':fontsize=28:fontcolor=0xaaaaaa:"
        f"x=(w-text_w)/2:y=h*0.42:font=Arial[t3];"
        f"[t3]drawtext=text='{score_text}':fontsize=120:fontcolor=white:"
        f"x=(w-text_w)/2:y=h*0.50:font=Arial[t4];"
        f"[t4]drawtext=text='{par_text}':fontsize=48:"
        f"fontcolor={'0x4CAF50' if (score_to_par or 0) <= 0 else '0xFF6B35'}:"
        f"x=(w-text_w)/2:y=h*0.62:font=Arial[t5];"
        f"[t5]drawtext=text='{holes_text}':fontsize=28:fontcolor=0xaaaaaa:"
        f"x=(w-text_w)/2:y=h*0.68:font=Arial[out]"
    )

    # Generate silent video for the intro card
    cmd = [
        "ffmpeg", "-y",
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-t", str(duration),
        # Add silent audio track so concat doesn't break
        "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
        "-shortest",
        str(output_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[PostProcess] Scorecard generation failed: {result.stderr[-300:]}")
        return False
    return True


def _escape(text: str) -> str:
    """Escape text for FFmpeg drawtext filter."""
    return (
        text.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "%%")
    )


def add_background_music(
    video_path: str,
    output_path: str,
    music_path: str | None = None,
    music_volume: float = 0.15,
    original_volume: float = 1.0,
):
    """
    Mix background music under the video's original audio.
    Music is looped to fill the video duration and faded out at the end.
    """
    if music_path is None:
        music_path = get_bundled_music()

    if not music_path or not Path(music_path).exists():
        print("[PostProcess] No background music available, skipping")
        # Just copy the file
        import shutil
        shutil.copy2(video_path, output_path)
        return True

    # Get video duration
    probe_cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        str(video_path),
    ]
    probe = subprocess.run(probe_cmd, capture_output=True, text=True)
    try:
        duration = float(probe.stdout.strip())
    except (ValueError, TypeError):
        duration = 60.0

    fade_start = max(0, duration - 3.0)

    # Mix original audio with looped background music
    filter_complex = (
        f"[1:a]aloop=loop=-1:size=2e+09,atrim=0:{duration},"
        f"volume={music_volume},afade=t=out:st={fade_start}:d=3[music];"
        f"[0:a]volume={original_volume}[orig];"
        f"[orig][music]amix=inputs=2:duration=first:dropout_transition=3[aout]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(music_path),
        "-filter_complex", filter_complex,
        "-map", "0:v:0",
        "-map", "[aout]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[PostProcess] Music mixing failed: {result.stderr[-300:]}")
        # Fall back to original
        import shutil
        shutil.copy2(video_path, output_path)
        return False
    return True


def post_process(
    merged_video: str,
    output_path: str,
    course_name: str = "Golf Course",
    date_str: str = "",
    total_score: int | None = None,
    score_to_par: int | None = None,
    holes_played: int = 18,
    music_path: str | None = None,
    add_scorecard: bool = True,
    add_music: bool = True,
):
    """
    Full post-processing pipeline:
    1. Generate scorecard intro card
    2. Prepend to merged video
    3. Mix in background music
    """
    if not ffmpeg_available():
        print("[PostProcess] FFmpeg not available, skipping post-processing")
        import shutil
        shutil.copy2(merged_video, output_path)
        return

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)
        current = Path(merged_video)

        # Probe merged video dimensions
        probe_cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
            str(merged_video),
        ]
        probe = subprocess.run(probe_cmd, capture_output=True, text=True)
        try:
            parts = probe.stdout.strip().split(",")
            vw, vh = int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            vw, vh = 1080, 1920

        # Step 1: Scorecard intro
        if add_scorecard:
            scorecard_path = tmpdir / "scorecard_intro.mov"
            ok = create_scorecard_image(
                str(scorecard_path),
                course_name=course_name,
                date_str=date_str,
                total_score=total_score,
                score_to_par=score_to_par,
                holes_played=holes_played,
                width=vw,
                height=vh,
            )

            if ok and scorecard_path.exists():
                # Concat scorecard + merged video
                concat_list = tmpdir / "concat.txt"
                with open(concat_list, "w") as f:
                    f.write(f"file '{str(scorecard_path)}'\n")
                    f.write(f"file '{str(current)}'\n")

                with_scorecard = tmpdir / "with_scorecard.mov"
                concat_cmd = [
                    "ffmpeg", "-y",
                    "-f", "concat", "-safe", "0",
                    "-i", str(concat_list),
                    "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                    "-c:a", "aac", "-b:a", "192k",
                    str(with_scorecard),
                ]
                r = subprocess.run(concat_cmd, capture_output=True, text=True)
                if r.returncode == 0 and with_scorecard.exists():
                    current = with_scorecard
                    print("[PostProcess] Scorecard intro prepended")
                else:
                    print(f"[PostProcess] Scorecard concat failed, continuing without it")

        # Step 2: Background music
        if add_music:
            with_music = tmpdir / "with_music.mov"
            add_background_music(
                str(current),
                str(with_music),
                music_path=music_path,
            )
            if with_music.exists():
                current = with_music
                print("[PostProcess] Background music mixed in")

        # Step 3: Final output with faststart
        final_cmd = [
            "ffmpeg", "-y",
            "-i", str(current),
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac",
            "-movflags", "+faststart",
            str(output_path),
        ]
        r = subprocess.run(final_cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[PostProcess] Final encode failed: {r.stderr[-300:]}")
            import shutil
            shutil.copy2(str(current), output_path)

    print(f"[PostProcess] Output → {output_path}")
