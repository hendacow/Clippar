# Golf Shot Detection Pipeline

Automatically detects and trims golf shots and putts from manually recorded clips. Each clip should contain one shot recorded with a Bluetooth clicker. The system uses pose estimation, ball tracking, and audio impact detection to find the exact moment of impact and save a clean trimmed clip.

---

## How It Works

For each input clip the pipeline runs three checks in parallel:

**1. Pose + Ball (visual detection)**
Tracks the player's spine angle, foot stability, and wrist motion to detect address position and swing. Tracks the golf ball and confirms the shot when the ball moves after the swing.

**2. Audio (impact sound)**
Analyses the clip audio inline at runtime — no separate audio file needed. Applies a high-pass filter to isolate the sharp impact transient, then checks if a spike falls within the swing window.

**3. Fallback scan**
If the state machine finds nothing (ball not visible, swing not detected), the full clip is scanned for any audio impact with ball evidence before and after — catching shots the visual system missed.

**Confirmation tags on output clips:**
| Tag | Meaning |
|---|---|
| `_ball` | Ball movement confirmed the shot |
| `_audio` | Audio confirmed, ball not tracked |
| `_ball+audio` | Both confirmed — highest confidence |
| `_audio_scan` | Full-clip fallback scan found it |
| `_no_detection` | Nothing detected — original clip saved as-is |

---

## Installation

**Requirements:** Python 3.9+, ffmpeg

**Install ffmpeg:**
```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg

# Windows
# Download from https://www.gyan.dev/ffmpeg/builds/ and add to PATH
```

**Install Python dependencies:**
```bash
pip install -r requirements.txt
```

**`requirements.txt` should contain:**
---

## Quickstart

**1. Put your clips in a folder:**
```
Test clips/
  IMG_6143.MOV
  IMG_6144.MOV
  IMG_6145.MOV
  ...
```
Supports `.mp4` and `.mov` (including uppercase `.MP4` / `.MOV`).

**2. Edit `config.yaml` — set your input and output folders:**
```yaml
input_dir  : "Test clips/"
output_dir : "outputs/shots"
```

**3. Run:**
```bash
python run_pipeline.py
```

**Output:**
```
outputs/shots/
  clip001_IMG_6143_swing01_ball.mp4          ← trimmed shot clip with audio
  clip001_IMG_6143_annotated.mp4             ← full clip with debug overlays
  clip002_IMG_6144_swing01_ball+audio.mp4
  clip002_IMG_6144_annotated.mp4
  clip003_IMG_6145_no_detection.mp4          ← nothing found, original saved
  ...
  merged_video.mp4                           ← all shot clips merged in order
```

---

## Configuration

All settings are in `config.yaml`. You should not need to edit anything other than `input_dir` and `output_dir` for normal use.

```yaml
# ── Paths ──────────────────────────────────────────────
input_dir  : "Test clips/"
output_dir : "outputs/shots"

# ── Models ─────────────────────────────────────────────
pose_model : "models/yolov8n-pose.pt"
ball_model : "models/golfballyolov8n.pt"
```

### Tuning parameters (only change if getting wrong results)

**Address / Setup phase** — controls when the system thinks the player is in position:

| Parameter | Default | What to change if... |
|---|---|---|
| `setup_frames` | 20 | Player moves into position quickly → lower to 10-15 |
| `setup_ankle_max` | 50px | Too many false setups → lower; missing real setups → raise |
| `spine_lean_min` | 15° | Player stands more upright → lower |
| `spine_lean_max` | 60° | Player bends more than usual → raise |

**Swing detection** — controls what counts as a swing vs standing still:

| Parameter | Default | What to change if... |
|---|---|---|
| `wrist_swing` | 50px | Missing full swings → lower to 30-40 |
| `wrist_putt` | 10px | Missing putts → lower to 6-8 |
| `swing_window` | 25 | Slow swings not detected → raise to 35 |

**Ball confirmation:**

| Parameter | Default | What to change if... |
|---|---|---|
| `ball_wait_frames` | 180 | Ball moves late in frame → raise; too many false positives → lower |
| `ball_move_threshold` | 6px | Missing slow putts → lower to 4; false shoe detections → raise |
| `shoe_proximity` | 80px | Shoe still being detected as ball → raise to 120 |
| `min_shot_duration` | 3.0s | Short clips being saved falsely → raise to 4.0 |

**Clip trimming:**

| Parameter | Default | Effect |
|---|---|---|
| `pre_roll` | 1.0s | Seconds before impact included in output clip |
| `post_roll` | 4.0s | Seconds after impact included in output clip |

For `ball+audio` confirmed shots the clip is anchored to the audio spike timestamp (most precise) and trimmed to exactly `pre_roll + post_roll` seconds.

**Output options:**

```yaml
save_annotated: true    # set to false for faster runs once you're happy with results
verbose       : true    # set to false to reduce console output
```

---

## Annotated Video Guide

When `save_annotated: true`, each input clip gets a full debug video showing exactly what the system saw.

**Skeleton colors:**
- Grey — IDLE, waiting for address position
- Yellow — SETUP, address detected, watching for swing
- Orange — SWING, swing detected, waiting for ball movement
- Green — BALL MOVED, shot confirmed

**Spine line:** drawn from hips to shoulders on the player's body. Green = angle in valid range, blue = out of range.

**Right sidebar shows:**
- Current state and frame counter
- Setup progress bar
- Spine angle and feet stability with thresholds
- All four swing scores (wrist, shoulder, hip, elbow) with their required thresholds
- Ball confidence and disappearance counter
- Swing wait countdown
- Audio hit info when audio confirms
- Rejection reason when a detection is rejected

**Phase bar** at the bottom highlights the active phase.

---

## Troubleshooting

**No shots detected in any clip (`_no_detection` on everything):**
- Check the annotated video — is the skeleton appearing at all? If not, pose model may not be loading
- Is the spine angle shown in the sidebar within your `spine_lean_min`/`spine_lean_max` range?
- Is the ball being detected? Look for the ball dot on the annotated video
- Try lowering `setup_frames` to 10 and `wrist_swing` to 30

**Too many false positives (wrong clips being saved):**
- Raise `min_shot_duration` to 4.0 or 5.0
- Raise `shoe_proximity` to 120 if shoes are being detected as ball
- Raise `ball_move_threshold` to 8-10 if small movements are triggering shots

**Shot detected but clip is wrong length:**
- The `pre_roll` and `post_roll` values in `config.yaml` control clip length
- `ball+audio` clips are always exactly `pre_roll + post_roll` seconds

**Audio not detecting impacts:**
- Make sure your clips have audio (some screen recorders strip audio)
- Check the sidebar in the annotated video for `[Audio]` lines in console output
- The high-pass filter is set to 1200Hz — if your impact sound is low frequency this may filter it out

**ffmpeg errors on saving:**
- Run `ffmpeg -version` to confirm it is installed and in your PATH
- The pipeline falls back to OpenCV (no audio) if ffmpeg fails

---
