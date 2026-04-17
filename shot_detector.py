"""
shot_detector.py — 3-phase state machine golf shot detector

IDLE → SETUP → SWING → BALL_MOVED → save clip → IDLE

Changes:
- Right sidebar panel — frame stays clear, all info in slim right strip
- Shot merging — overlapping detections merged before saving
- Audio fallback via AudioValidator (impact_sounds.csv + clips_timestamps.csv)
- .mov support — accepts both .mp4 and .mov input clips
- Config via config.yaml instead of argparse
- Audio preserved in every saved clip via ffmpeg muxing
- No-detection fallback — clips with zero shots are saved as-is (with audio)
- Output clips always match source container format (.mp4 → .mp4, .mov → .mov)
"""

import csv, cv2, numpy as np, math, time, collections, subprocess, shutil, tempfile, os
import multiprocessing
import torch
from pathlib import Path

import librosa
from scipy import signal
import yaml
from ultralytics import YOLO


def _detect_device():
    """Pick the best available accelerator: MPS (Apple Silicon) > CUDA > CPU."""
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"

# ── Keypoint indices (COCO 17) ──────────────────────────────────
KP_LEFT_SHOULDER  = 5;  KP_RIGHT_SHOULDER = 6
KP_LEFT_ELBOW     = 7;  KP_RIGHT_ELBOW    = 8
KP_LEFT_WRIST     = 9;  KP_RIGHT_WRIST    = 10
KP_LEFT_HIP       = 11; KP_RIGHT_HIP      = 12
KP_LEFT_KNEE      = 13; KP_RIGHT_KNEE     = 14
KP_LEFT_ANKLE     = 15; KP_RIGHT_ANKLE    = 16

POSE_CONNECTIONS = [
    (KP_LEFT_SHOULDER, KP_RIGHT_SHOULDER),
    (KP_LEFT_SHOULDER, KP_LEFT_ELBOW),    (KP_RIGHT_SHOULDER, KP_RIGHT_ELBOW),
    (KP_LEFT_ELBOW,    KP_LEFT_WRIST),    (KP_RIGHT_ELBOW,    KP_RIGHT_WRIST),
    (KP_LEFT_SHOULDER, KP_LEFT_HIP),      (KP_RIGHT_SHOULDER, KP_RIGHT_HIP),
    (KP_LEFT_HIP,      KP_RIGHT_HIP),
    (KP_LEFT_HIP,      KP_LEFT_KNEE),     (KP_RIGHT_HIP,      KP_RIGHT_KNEE),
    (KP_LEFT_KNEE,     KP_LEFT_ANKLE),    (KP_RIGHT_KNEE,     KP_RIGHT_ANKLE),
]

STATE_COLOR = {
    "IDLE":       (180, 180, 180),
    "SETUP":      (0,   255, 255),
    "SWING":      (0,   165, 255),
    "BALL_MOVED": (0,   255, 0  ),
}

# Supported video file extensions
VIDEO_EXTENSIONS = ("*.mp4", "*.mov", "*.MP4", "*.MOV")

# fourcc codes per container — OpenCV temp file must match output container
FOURCC_FOR_EXT = {
    ".mp4": "mp4v",
    ".mov": "mp4v",   # mp4v works in both; ffmpeg re-encodes to H.264 anyway
}


# ════════════════════════════════════════════════════════════════
# Config Loader
# ════════════════════════════════════════════════════════════════

def load_config(config_path="config.yaml"):
    """Load config.yaml, falling back to defaults for any missing keys."""
    defaults = dict(
        clips_dir="clips",
        output_dir="outputs/shots",
        pose_model_path="models/yolov8n-pose.pt",
        ball_model_path="models/golfballyolov8n.pt",
        audio_sample_rate=44100,
        audio_highpass_hz=1200.0,
        audio_min_strength="weak",
        audio_overlay_sec=1.5,
        audio_peak_rel_threshold=0.4,
        audio_peak_min_separation_sec=0.75,
        audio_impact_window_sec=0.75,
        audio_transient_min_score=0.65,
        audio_wind_reject_max_duration=0.12,
        ball_confidence=0.15,
        setup_frames=20,
        setup_ankle_max=50.0,
        feet_gap_max_px=50.0,
        setup_ball_max=4.0,
        spine_lean_min=15.0,
        spine_lean_max=60.0,
        swing_window=25,
        wrist_swing_threshold=50.0,
        wrist_putt_threshold=10.0,
        wrist_speed_swing_threshold=13.0,
        shoulder_swing_threshold=8.0,
        hip_swing_threshold=5.0,
        vision_fallback_enabled=True,
        vision_wrist_confirm_threshold=65.0,
        vision_torso_confirm_threshold=12.0,
        vision_followthrough_frames=6,
        vision_setup_min_frames=20,
        vision_setup_confidence_min=0.75,
        vision_posture_break_grace_sec=3.0,
        ball_move_threshold=8.0,
        putt_ball_move_threshold=4.5,
        putt_confirm_frames=2,
        save_putts=False,
        max_shots_per_clip=1,
        ball_wait_frames=360,
        max_disappear_frames=15,
        ema_alpha=0.5,
        pre_roll_sec=3.0,
        post_roll_sec=2.0,
        display=False,
        save_annotated=True,
        verbose=True,
        fast_mode=False,
        device="auto",
        inference_imgsz=640,
        parallel_workers=0,
    )
    config_path = Path(config_path)
    if not config_path.exists():
        print(f"[Config] '{config_path}' not found — using built-in defaults.")
        return defaults

    with open(config_path) as f:
        user = yaml.safe_load(f) or {}

    merged = {**defaults, **user}
    print(f"[Config] Loaded '{config_path}'")
    return merged


# ════════════════════════════════════════════════════════════════
# Skeleton EMA Smoother
# ════════════════════════════════════════════════════════════════

class SkeletonSmoother:
    def __init__(self, alpha=0.5):
        self.alpha    = alpha
        self.smoothed = None
        self.conf_buf = None

    def update(self, keypoints, confidences):
        if keypoints is None or confidences is None:
            self.smoothed = None
            self.conf_buf = None
            return None, None
        kp = np.array(keypoints, dtype=float)
        cf = np.array(confidences, dtype=float)
        if self.smoothed is None:
            self.smoothed = kp.copy()
            self.conf_buf = cf.copy()
        else:
            for i in range(17):
                if cf[i] > 0.2:
                    self.smoothed[i] = self.alpha * kp[i] + (1-self.alpha) * self.smoothed[i]
            self.conf_buf = self.alpha * cf + (1-self.alpha) * self.conf_buf
        return self.smoothed.copy(), self.conf_buf.copy()


# ════════════════════════════════════════════════════════════════
# Audio Validator
# ════════════════════════════════════════════════════════════════

class AudioValidator:
    """
    Matches SWING phase windows against pre-extracted audio impact timestamps.
    Loads impact_sounds.csv and clips_timestamps.csv from the clips folder.
    """

    def __init__(self, clips_dir, clip_name=None,
                 audio_tolerance_sec=1.5, min_strength=None,
                 min_transient_score=0.0, max_duration_sec=None):
        self.clips_dir       = Path(clips_dir)
        self.clip_name       = clip_name
        self.audio_tolerance = audio_tolerance_sec
        self.min_strength    = min_strength
        self.min_transient_score = float(min_transient_score or 0.0)
        self.max_duration_sec = (float(max_duration_sec)
                                 if max_duration_sec not in (None, "")
                                 else None)
        self.clip_start_sec  = None
        self.impacts         = []
        self.enabled         = False
        self.strength_rank   = {"very_weak": 0, "weak": 1, "medium": 2, "strong": 3}
        self._load(clip_name)

    def _load(self, clip_name):
        impacts_csv    = self.clips_dir / "impact_sounds.csv"
        timestamps_csv = self.clips_dir / "clips_timestamps.csv"

        if not impacts_csv.exists():
            print(f"  [Audio] impact_sounds.csv not found at {impacts_csv} — audio validation disabled")
            return
        if not timestamps_csv.exists():
            print(f"  [Audio] clips_timestamps.csv not found — audio validation disabled")
            return

        with open(timestamps_csv) as f:
            for row in csv.DictReader(f):
                if row["clip_name"] == clip_name:
                    self.clip_start_sec = float(row["start_sec"])
                    break

        if self.clip_start_sec is None:
            print(f"  [Audio] '{clip_name}' not in timestamps CSV — disabled")
            return

        min_rank = self.strength_rank.get(self.min_strength, 0)
        with open(impacts_csv) as f:
            for row in csv.DictReader(f):
                row_clip = row.get("clip_name")
                if row_clip and row_clip != clip_name:
                    continue
                strength = row.get("strength", "weak")
                if self.strength_rank.get(strength, 0) < min_rank:
                    continue
                transient_score = float(row.get("transient_score", 0.0) or 0.0)
                duration_sec = float(row.get("duration_sec", 0.0) or 0.0)
                if transient_score < self.min_transient_score:
                    continue
                if self.max_duration_sec is not None and duration_sec > self.max_duration_sec:
                    continue
                abs_ts = float(row["timestamp_sec"])
                clip_ts_raw = row.get("clip_time_sec")
                clip_ts = (float(clip_ts_raw) if clip_ts_raw not in (None, "")
                           else abs_ts - self.clip_start_sec)
                self.impacts.append({
                    "timestamp_sec": abs_ts,
                    "clip_time_sec": clip_ts,
                    "amplitude": float(row["amplitude"]),
                    "strength": strength,
                    "transient_score": transient_score,
                    "duration_sec": duration_sec,
                    "centroid_hz": float(row.get("centroid_hz", 0.0) or 0.0),
                })

        self.enabled = True
        print(f"  [Audio] {len(self.impacts)} impact(s)  "
              f"clip_start={self.clip_start_sec:.2f}s  tol=±{self.audio_tolerance}s")

    def check_window(self, swing_start_frame, swing_end_frame, fps):
        if not self.enabled or not self.impacts:
            return False, None
        win_start = max(0.0, swing_start_frame / fps)
        win_end   = swing_end_frame / fps + self.audio_tolerance
        candidates = [impact for impact in self.impacts
                      if win_start <= impact["clip_time_sec"] <= win_end]
        if not candidates:
            return False, None
        window_end_bias = swing_end_frame / fps
        best = max(
            candidates,
            key=lambda x: (
                x.get("transient_score", 0.0),
                x["amplitude"],
                -abs(x["clip_time_sec"] - window_end_bias),
            ),
        )
        offset = best["clip_time_sec"] - swing_start_frame / fps
        return True, {
            "timestamp_sec": best["timestamp_sec"],
            "clip_time_sec": best["clip_time_sec"],
            "amplitude": best["amplitude"],
            "strength": best["strength"],
            "transient_score": best.get("transient_score", 0.0),
            "duration_sec": best.get("duration_sec", 0.0),
            "centroid_hz": best.get("centroid_hz", 0.0),
            "offset_sec": round(offset, 3),
        }

    def best_clip_hit(self, min_strength=None):
        if not self.enabled or not self.impacts:
            return False, None
        min_rank = self.strength_rank.get(min_strength or self.min_strength, 0)
        candidates = [impact for impact in self.impacts
                      if self.strength_rank.get(impact["strength"], 0) >= min_rank]
        if not candidates:
            return False, None
        best = max(candidates, key=lambda x: (x.get("transient_score", 0.0), x["amplitude"]))
        return True, {
            "timestamp_sec": best["timestamp_sec"],
            "clip_time_sec": best["clip_time_sec"],
            "amplitude": best["amplitude"],
            "strength": best["strength"],
            "transient_score": best.get("transient_score", 0.0),
            "duration_sec": best.get("duration_sec", 0.0),
            "centroid_hz": best.get("centroid_hz", 0.0),
            "offset_sec": 0.0,
        }


# ════════════════════════════════════════════════════════════════
# Shot State Machine
# ════════════════════════════════════════════════════════════════

class ShotStateMachine:

    IDLE       = "IDLE"
    SETUP      = "SETUP"
    SWING      = "SWING"
    BALL_MOVED = "BALL_MOVED"

    def __init__(
        self, fps,
        setup_frames=20, setup_ankle_max=50.0, setup_ball_max=4.0,
        feet_gap_max_px=50.0,
        spine_lean_min=15.0, spine_lean_max=60.0,
        swing_window=25,
        wrist_swing_threshold=50.0, wrist_putt_threshold=10.0,
        wrist_speed_swing_threshold=13.0,
        shoulder_swing_threshold=8.0, hip_swing_threshold=5.0,
        hip_putt_max=4.0, min_keypoint_conf=0.25,
        ball_move_threshold=8.0, putt_ball_move_threshold=4.5,
        putt_confirm_frames=2, save_putts=False, max_shots_per_clip=1, ball_wait_frames=360,
        max_disappear_frames=15,
        verbose=True,
    ):
        self.fps                      = fps
        self.setup_frames             = setup_frames
        self.setup_ankle_max          = setup_ankle_max
        self.feet_gap_max_px          = feet_gap_max_px
        self.setup_ball_max           = setup_ball_max
        self.spine_lean_min           = spine_lean_min
        self.spine_lean_max           = spine_lean_max
        self.swing_window             = swing_window
        self.wrist_swing_threshold    = wrist_swing_threshold
        self.wrist_putt_threshold     = wrist_putt_threshold
        self.wrist_speed_swing_threshold = wrist_speed_swing_threshold
        self.shoulder_swing_threshold = shoulder_swing_threshold
        self.hip_swing_threshold      = hip_swing_threshold
        self.hip_putt_max             = hip_putt_max
        self.min_keypoint_conf        = min_keypoint_conf
        self.ball_move_threshold      = ball_move_threshold
        self.putt_ball_move_threshold = max(1.0, float(putt_ball_move_threshold))
        self.putt_confirm_frames      = max(1, int(putt_confirm_frames))
        self.save_putts               = bool(save_putts)
        self.max_shots_per_clip       = max(1, int(max_shots_per_clip))
        self.ball_wait_frames         = ball_wait_frames
        self.max_disappear_frames     = max_disappear_frames
        self.verbose                  = verbose

        self.state               = self.IDLE
        self.shot_type           = None
        self.setup_frame_count   = 0
        self.kp_history          = collections.deque(maxlen=swing_window)
        self.last_ball_pos       = None
        self.last_known_ball_pos = None
        self.disappeared_frames  = 0
        self.ball_trail          = collections.deque(maxlen=30)
        self.ball_wait_countdown = 0
        self.shot_detected       = False
        self.shot_frame_idx      = None
        self.swing_entry_frame   = None
        self.swing_scores        = {}
        self.last_spine_angle    = 0.0
        self.feet_stable         = False
        self.last_ankle_gap      = None
        self.spine_in_range      = False
        self.rejection_reason    = ""
        self._swing_timed_out    = False
        self._swing_faded_out    = False
        self._audio_confirmed    = False
        self._audio_info         = None
        self._ball_confirmed     = False
        self.post_shot_cooldown_frames = max(12, int(round(0.75 * fps)))
        self.cooldown_remaining   = 0
        self.low_motion_frames    = 0
        self.putt_reference_ball_pos = None
        self.putt_move_frames        = 0
        self.putt_max_departure      = 0.0
        self.last_ball_move_dist     = None
        self.scene_putt_score        = 0.0
        self.scene_putt_peak         = 0.0
        self.scene_green_ratio       = 0.0
        self.scene_pose_height_ratio = None
        self.scene_texture_laplacian = 0.0
        self.putt_scene_score_min    = 0.72
        self.putt_scene_green_ratio_min = 0.60
        self.putt_scene_pose_height_max = 0.23
        self.putt_shoulder_relaxed_max = 28.0
        self.putt_hip_relaxed_max      = 12.0
        self.putt_wrist_speed_relaxed_max = 40.0
        self.putt_elbow_relaxed_max    = 140.0

    def update(self, frame_idx, keypoints, confidences, ball_pos):
        self.shot_detected    = False
        self.rejection_reason = ""
        self._swing_timed_out = False
        self._swing_faded_out = False

        prev_ball     = self.last_ball_pos
        resolved_ball = self._resolve_ball(ball_pos)

        if keypoints is not None and confidences is not None:
            self.kp_history.append(self._extract_kp(keypoints, confidences))

        prev_state = self.state

        if self.cooldown_remaining > 0 and self.state in (self.IDLE, self.SETUP):
            self.cooldown_remaining -= 1
            self.setup_frame_count = 0
            self.state = self.IDLE
            if resolved_ball is not None:
                self.last_ball_pos = resolved_ball
            return self.state

        if self.state == self.IDLE:
            self._update_idle(frame_idx, resolved_ball, prev_ball)
        elif self.state == self.SETUP:
            self._update_setup(frame_idx, resolved_ball, prev_ball)
        elif self.state == self.SWING:
            self._update_swing(frame_idx, resolved_ball, prev_ball)
        elif self.state == self.BALL_MOVED:
            self.state = self.IDLE
            self._reset()

        if self.state != prev_state and self.verbose:
            reason = f"  ({self.rejection_reason})" if self.rejection_reason else ""
            stype  = f"  type={self.shot_type}" if self.shot_type else ""
            print(f"    [SM f{frame_idx}] {prev_state} → {self.state}{stype}{reason}")

        if resolved_ball is not None:
            self.last_ball_pos = resolved_ball

        return self.state

    def _enter_swing_state(self, frame_idx, swing_type, ball_pos, prev_ball):
        self.state               = self.SWING
        self.shot_type           = swing_type
        self.ball_wait_countdown = self.ball_wait_frames
        self.swing_entry_frame   = frame_idx
        self.low_motion_frames   = 0
        reference_ball = ball_pos if ball_pos is not None else prev_ball
        if reference_ball is None:
            reference_ball = self.last_known_ball_pos
        self.putt_reference_ball_pos = reference_ball
        self.putt_move_frames = 0
        self.putt_max_departure = 0.0
        self.kp_history.clear()

    def _scene_prefers_putt(self):
        scene_score = self._scene_putt_score_effective()
        return scene_score >= self.putt_scene_score_min

    def _scene_putt_score_effective(self):
        return max(self.scene_putt_score, self.scene_putt_peak * 0.97)

    def _scene_strong_putt_like(self):
        scene_score = self._scene_putt_score_effective()
        pose_height = self.scene_pose_height_ratio
        if scene_score < 0.90:
            return False
        if self.scene_green_ratio < 0.63:
            return False
        if pose_height is not None and pose_height > 0.24:
            return False
        return True

    def _is_clear_full_swing(self, scores):
        if not scores:
            return False
        wrist_speed = scores.get("wrist_speed", 0.0)
        shoulder = scores.get("shoulder_change", 0.0)
        hip = scores.get("hip_change", 0.0)
        elbow = scores.get("elbow_motion", 0.0)
        return (
            wrist_speed >= self.wrist_speed_swing_threshold * 1.25
            and (
                shoulder >= self.shoulder_swing_threshold * 1.60
                or hip >= self.hip_swing_threshold * 2.0
                or elbow >= self.wrist_swing_threshold * 1.10
            )
        )

    def _update_idle(self, frame_idx, ball_pos, prev_ball):
        ball_still        = self._is_ball_still(ball_pos, self.last_ball_pos)
        in_address, angle = self._check_address()
        self.last_spine_angle = angle
        swing_type, scores = self._score_swing()
        self.swing_scores = scores

        strong_wrist_now = scores.get("wrist_motion", 0.0) >= self.wrist_swing_threshold
        if strong_wrist_now:
            if swing_type == "PUTT" or (
                self._scene_strong_putt_like()
                and not self._is_clear_full_swing(scores)
            ):
                self._enter_swing_state(frame_idx, "PUTT", ball_pos, prev_ball)
                return
            if swing_type == "SWING" or not self._scene_prefers_putt():
                self._enter_swing_state(frame_idx, "SWING", ball_pos, prev_ball)
            return

        if ball_still and in_address:
            self.setup_frame_count += 1
            if self.verbose and self.setup_frame_count % 5 == 0:
                print(f"    [SM f{frame_idx}] IDLE  "
                      f"setup:{self.setup_frame_count}/{self.setup_frames}  "
                      f"spine:{angle:.1f}°  feet:{self.feet_stable}")
            if self.setup_frame_count >= self.setup_frames:
                self.kp_history = collections.deque(
                    list(self.kp_history)[-3:],
                    maxlen=self.swing_window,
                )
                self.swing_scores = {}
                self.state = self.SETUP
        else:
            self.setup_frame_count = max(0, self.setup_frame_count - 1)

    def _update_setup(self, frame_idx, ball_pos, prev_ball):
        in_address, angle  = self._check_address()
        self.last_spine_angle = angle
        swing_type, scores = self._score_swing()
        self.swing_scores  = scores

        if self.verbose and frame_idx % 10 == 0:
            print(f"    [SM f{frame_idx}] SETUP  "
                  f"spine:{angle:.1f}°  "
                  f"wrist:{scores.get('wrist_motion',0):.1f}  "
                  f"hip:{scores.get('hip_change',0):.1f}°  "
                  f"addr:{in_address}")

        if swing_type is not None:
            self._enter_swing_state(frame_idx, swing_type, ball_pos, prev_ball)
            return

        if ball_pos is not None and prev_ball is not None:
            dist = _dist(ball_pos, prev_ball)
            if dist > self.ball_move_threshold:
                self.rejection_reason = f"ball moved {dist:.1f}px before swing"
                self.state = self.IDLE
                self._reset()
                return

        if not in_address and not self.feet_stable:
            self.setup_frame_count = max(0, self.setup_frame_count - 3)
            if self.setup_frame_count == 0:
                self.rejection_reason = "player left address"
                self.state = self.IDLE

    def _update_swing(self, frame_idx, ball_pos, prev_ball):
        _, angle = self._check_address()
        self.last_spine_angle = angle
        self.ball_wait_countdown -= 1

        if self.verbose and self.ball_wait_countdown % 15 == 0:
            print(f"    [SM f{frame_idx}] SWING  "
                  f"wait:{self.ball_wait_countdown}  "
                  f"ball:{ball_pos}  prev:{prev_ball}")

        if self.shot_type == "PUTT":
            if self.save_putts:
                confirmed, dist = self._check_putt_ball_confirmation(ball_pos, prev_ball)
                if confirmed:
                    print(f"    [SM f{frame_idx}] ★ PUTT BALL MOVED {dist:.1f}px → SHOT CONFIRMED")
                    self.state           = self.BALL_MOVED
                    self.shot_detected   = True
                    self.shot_frame_idx  = frame_idx
                    self._ball_confirmed = True
                    self.last_ball_move_dist = dist
                    return
        elif ball_pos is not None and prev_ball is not None:
            dist = _dist(ball_pos, prev_ball)
            if dist >= self.ball_move_threshold:
                print(f"    [SM f{frame_idx}] ★ BALL MOVED {dist:.1f}px → SHOT CONFIRMED")
                self.state           = self.BALL_MOVED
                self.shot_detected   = True
                self.shot_frame_idx  = frame_idx
                self._ball_confirmed = True
                self.last_ball_move_dist = dist
                return

        _, live_scores = self._score_swing()
        self.swing_scores = live_scores
        if live_scores:
            if (self.shot_type == "PUTT"
                    and live_scores.get("wrist_motion", 0.0) >= self.wrist_swing_threshold
                    and not self._scene_strong_putt_like()
                    and not self._scene_prefers_putt()
                    and self._is_clear_full_swing(live_scores)):
                self.shot_type = "SWING"
            low_motion = (
                live_scores.get("wrist_motion", 0.0) < self.wrist_putt_threshold * 1.2
                and live_scores.get("wrist_speed", 0.0) < self.wrist_speed_swing_threshold * 0.75
                and live_scores.get("elbow_motion", 0.0) < self.wrist_swing_threshold * 0.35
            )
            if low_motion:
                self.low_motion_frames += 1
            else:
                self.low_motion_frames = 0
            if self.low_motion_frames >= max(8, int(round(self.fps * 0.35))):
                self.rejection_reason = "swing motion faded"
                self._swing_faded_out = True
                self.state = self.IDLE
                return

        if self.ball_wait_countdown <= 0:
            self.rejection_reason = "swing detected but ball did not move in time"
            self._swing_timed_out = True

    def _check_address(self):
        spine_angle         = self._compute_spine_lean()
        self.last_spine_angle = spine_angle
        self.spine_in_range = self.spine_lean_min <= spine_angle <= self.spine_lean_max
        ankle_gap = self._current_ankle_gap()
        self.last_ankle_gap = ankle_gap
        ankle_motion        = self._kp_max_displacement_in(
                                  [KP_LEFT_ANKLE, KP_RIGHT_ANKLE],
                                  list(self.kp_history)[-6:])
        self.feet_stable    = ankle_motion < self.setup_ankle_max
        return self.feet_stable and self.spine_in_range, spine_angle

    def _current_ankle_gap(self):
        if not self.kp_history:
            return None
        frame = self.kp_history[-1]
        if KP_LEFT_ANKLE in frame and KP_RIGHT_ANKLE in frame:
            return float(abs(frame[KP_LEFT_ANKLE][0] - frame[KP_RIGHT_ANKLE][0]))
        return None

    def _compute_spine_lean(self):
        if not self.kp_history:
            return 0.0
        frame = self.kp_history[-1]
        has_s = KP_LEFT_SHOULDER in frame and KP_RIGHT_SHOULDER in frame
        has_h = KP_LEFT_HIP in frame and KP_RIGHT_HIP in frame
        if has_s and has_h:
            smid = (frame[KP_LEFT_SHOULDER] + frame[KP_RIGHT_SHOULDER]) / 2
            hmid = (frame[KP_LEFT_HIP]      + frame[KP_RIGHT_HIP])      / 2
            dx   = float(smid[0] - hmid[0])
            dy   = float(smid[1] - hmid[1])
            return math.degrees(math.atan2(abs(dx), abs(dy)))
        return 0.0

    def _score_swing(self):
        if len(self.kp_history) < max(5, self.swing_window // 3):
            return None, {}
        scores = {
            "wrist_motion":    self._kp_max_displacement([KP_LEFT_WRIST,    KP_RIGHT_WRIST]),
            "wrist_speed":     self._kp_max_step_displacement([KP_LEFT_WRIST, KP_RIGHT_WRIST]),
            "shoulder_change": self._kp_angle_change(KP_LEFT_SHOULDER, KP_RIGHT_SHOULDER),
            "hip_change":      self._kp_angle_change(KP_LEFT_HIP,      KP_RIGHT_HIP),
            "elbow_motion":    self._kp_max_displacement([KP_LEFT_ELBOW,    KP_RIGHT_ELBOW]),
        }
        wrist    = scores["wrist_motion"]
        wrist_speed = scores["wrist_speed"]
        shoulder = scores["shoulder_change"]
        hip      = scores["hip_change"]
        elbow    = scores["elbow_motion"]
        scene_putt_like = self._scene_prefers_putt()
        strong_scene_putt_like = self._scene_strong_putt_like()
        scores["scene_putt_score"] = self._scene_putt_score_effective()
        scores["scene_green_ratio"] = self.scene_green_ratio
        scores["scene_pose_height_ratio"] = self.scene_pose_height_ratio
        putt_hip_cap = max(self.hip_putt_max + 2.0, self.hip_putt_max * 1.5)
        putt_shoulder_cap = self.shoulder_swing_threshold * 0.80
        putt_elbow_cap = self.wrist_swing_threshold * 0.70
        full_swing_like = (
            wrist_speed >= self.wrist_speed_swing_threshold
            and (
                hip >= self.hip_swing_threshold * 1.15
                or shoulder >= self.shoulder_swing_threshold * 1.10
                or elbow >= self.wrist_swing_threshold * 0.80
            )
        )
        putt_like = (
            wrist >= self.wrist_putt_threshold
            and wrist_speed <= self.wrist_speed_swing_threshold * 0.95
            and hip <= putt_hip_cap
            and shoulder <= putt_shoulder_cap
            and elbow <= putt_elbow_cap
        )
        relaxed_scene_putt_like = (
            scene_putt_like
            and shoulder <= self.putt_shoulder_relaxed_max
            and hip <= self.putt_hip_relaxed_max
            and wrist_speed <= self.putt_wrist_speed_relaxed_max
            and elbow <= self.putt_elbow_relaxed_max
            and not self._is_clear_full_swing(scores)
        )
        if strong_scene_putt_like and wrist >= self.wrist_putt_threshold and not self._is_clear_full_swing(scores):
            return "PUTT", scores
        if relaxed_scene_putt_like and wrist >= self.wrist_putt_threshold:
            return "PUTT", scores
        if putt_like:
            return "PUTT", scores
        if wrist >= self.wrist_swing_threshold:
            if full_swing_like:
                return "SWING", scores
            if hip <= putt_hip_cap and shoulder <= self.shoulder_swing_threshold and elbow <= putt_elbow_cap:
                return "PUTT", scores
            if wrist_speed < self.wrist_speed_swing_threshold:
                return None, scores
            if (hip >= self.hip_swing_threshold
                    or shoulder >= self.shoulder_swing_threshold
                    or elbow >= self.wrist_swing_threshold * 0.70):
                return "SWING", scores
            return "PUTT", scores
        if wrist >= self.wrist_putt_threshold:
            if (hip <= self.hip_putt_max
                    and shoulder <= self.shoulder_swing_threshold * 0.90
                    and elbow < self.wrist_swing_threshold * 0.55):
                return "PUTT", scores
            if full_swing_like and wrist >= self.wrist_swing_threshold * 0.80:
                return "SWING", scores
            if hip <= putt_hip_cap and shoulder <= self.shoulder_swing_threshold and elbow <= putt_elbow_cap:
                return "PUTT", scores
            if (wrist_speed >= self.wrist_speed_swing_threshold
                    and (hip >= self.hip_swing_threshold
                         or shoulder >= self.shoulder_swing_threshold
                         or elbow >= self.wrist_swing_threshold * 0.70)):
                return "SWING", scores
        return None, scores

    def _is_ball_still(self, ball_pos, prev_ball):
        if ball_pos is None or prev_ball is None:
            return True
        return _dist(ball_pos, prev_ball) < self.setup_ball_max

    def _check_putt_ball_confirmation(self, ball_pos, prev_ball):
        ref_ball = self.putt_reference_ball_pos
        if ref_ball is None:
            if ball_pos is not None:
                self.putt_reference_ball_pos = ball_pos
            return False, 0.0

        departure = 0.0
        step = 0.0
        if ball_pos is not None:
            departure = _dist(ball_pos, ref_ball)
            if prev_ball is not None:
                step = _dist(ball_pos, prev_ball)
        elif prev_ball is not None:
            departure = _dist(prev_ball, ref_ball)

        moved_enough = departure >= self.putt_ball_move_threshold
        stepped_enough = step >= max(1.0, self.putt_ball_move_threshold * 0.25)
        if moved_enough and (stepped_enough or ball_pos is None):
            self.putt_move_frames += 1
            self.putt_max_departure = max(self.putt_max_departure, departure)
        elif departure < self.putt_ball_move_threshold * 0.70:
            self.putt_move_frames = 0
            self.putt_max_departure = 0.0

        if self.putt_move_frames >= self.putt_confirm_frames:
            return True, max(self.putt_max_departure, departure)
        if (ball_pos is None and self.putt_move_frames >= 1
                and self.putt_max_departure >= self.putt_ball_move_threshold):
            return True, self.putt_max_departure
        return False, max(self.putt_max_departure, departure)

    def _resolve_ball(self, ball_pos):
        if ball_pos is None:
            self.disappeared_frames += 1
            if (self.disappeared_frames <= self.max_disappear_frames
                    and self.last_known_ball_pos is not None):
                return self.last_known_ball_pos
            self.disappeared_frames  = 0
            self.last_known_ball_pos = None
            return None
        self.disappeared_frames  = 0
        self.last_known_ball_pos = ball_pos
        self.ball_trail.append(ball_pos)
        return ball_pos

    def _extract_kp(self, keypoints, confidences):
        kp = {}
        for idx in [KP_LEFT_WRIST, KP_RIGHT_WRIST,
                    KP_LEFT_SHOULDER, KP_RIGHT_SHOULDER,
                    KP_LEFT_HIP, KP_RIGHT_HIP,
                    KP_LEFT_ELBOW, KP_RIGHT_ELBOW,
                    KP_LEFT_ANKLE, KP_RIGHT_ANKLE,
                    KP_LEFT_KNEE, KP_RIGHT_KNEE]:
            if idx < len(confidences) and confidences[idx] >= self.min_keypoint_conf:
                kp[idx] = np.array(keypoints[idx], dtype=float)
        return kp

    def _kp_max_displacement(self, indices):
        motions = []
        history = list(self.kp_history)
        for idx in indices:
            pts = [f[idx] for f in history if idx in f]
            if len(pts) >= 3:
                pts = np.array(pts)
                window = max(2, len(pts) // 3)
                early = np.mean(pts[:window], axis=0)
                late = np.mean(pts[-window:], axis=0)
                motions.append(float(np.linalg.norm(late - early)))
            elif len(pts) >= 2:
                motions.append(float(np.linalg.norm(pts[-1] - pts[0])))
        return max(motions) if motions else 0.0

    def _kp_max_step_displacement(self, indices):
        motions = []
        history = list(self.kp_history)
        for idx in indices:
            pts = [f[idx] for f in history if idx in f]
            if len(pts) >= 2:
                pts = np.array(pts)
                recent_len = max(3, len(pts) // 3)
                recent_pts = pts[-recent_len:]
                motions.append(max(float(np.linalg.norm(recent_pts[i] - recent_pts[i - 1]))
                                   for i in range(1, len(recent_pts))))
        return max(motions) if motions else 0.0

    def _kp_max_displacement_in(self, indices, history):
        motions = []
        for idx in indices:
            pts = [f[idx] for f in history if idx in f]
            if len(pts) >= 2:
                pts   = np.array(pts)
                dists = [np.linalg.norm(pts[i]-pts[j])
                         for i in range(len(pts)) for j in range(i+1, len(pts))]
                if dists:
                    motions.append(max(dists))
        return max(motions) if motions else 0.0

    def _kp_angle_change(self, kp_a, kp_b):
        angles = []
        for frame in self.kp_history:
            if kp_a in frame and kp_b in frame:
                dx = frame[kp_b][0] - frame[kp_a][0]
                dy = frame[kp_b][1] - frame[kp_a][1]
                angles.append(math.degrees(math.atan2(dy, dx)))
        if len(angles) < 3:
            return 0.0

        window = max(2, len(angles) // 3)

        def mean_angle(values):
            radians = np.radians(values)
            return math.degrees(math.atan2(np.mean(np.sin(radians)), np.mean(np.cos(radians))))

        early = mean_angle(angles[:window])
        late = mean_angle(angles[-window:])
        return abs(((late - early + 180.0) % 360.0) - 180.0)

    def _reset(self):
        self.setup_frame_count   = 0
        self.ball_wait_countdown = 0
        self.shot_type           = None
        self.swing_entry_frame   = None
        self.kp_history.clear()
        self._audio_confirmed    = False
        self._audio_info         = None
        self._ball_confirmed     = False
        self.low_motion_frames   = 0
        self.putt_reference_ball_pos = None
        self.putt_move_frames        = 0
        self.putt_max_departure      = 0.0
        self.last_ball_move_dist     = None

    def start_cooldown(self):
        self.cooldown_remaining = self.post_shot_cooldown_frames

    @property
    def setup_progress(self):
        return min(1.0, self.setup_frame_count / max(1, self.setup_frames))


# ════════════════════════════════════════════════════════════════
# Shot Merger
# ════════════════════════════════════════════════════════════════

def merge_shots(shots):
    """
    Merge overlapping shot windows.
    shots: list of dicts with keys: start_sec, end_sec, shot_type, confirm_tag, trail
    Returns merged list — overlapping shots become one entry tagged _merged.
    """
    if not shots:
        return []
    shots = sorted(shots, key=lambda x: x["start_sec"])
    merged = [shots[0].copy()]
    for s in shots[1:]:
        last = merged[-1]
        if s["start_sec"] <= last["end_sec"]:
            last["end_sec"]     = max(last["end_sec"], s["end_sec"])
            last["trail"]       = last["trail"] + s["trail"]
            last["merged"]      = True
            last["confirm_tag"] = (last["confirm_tag"]
                                   if last["confirm_tag"] == s["confirm_tag"]
                                   else "merged")
        else:
            merged.append(s.copy())
    return merged


# ════════════════════════════════════════════════════════════════
# Drawing — right sidebar, frame stays clear
# ════════════════════════════════════════════════════════════════

def _scale(frame, base=1080):
    h, w = frame.shape[:2]
    return max(w, h) / base


def draw_pose(frame, keypoints, confidences, state, min_conf=0.25):
    if keypoints is None: return
    s     = _scale(frame)
    color = STATE_COLOR.get(state, (180, 180, 180))
    kv    = {}
    for idx in range(17):
        if confidences[idx] >= min_conf:
            kv[idx] = (int(keypoints[idx][0]), int(keypoints[idx][1]))
    for a, b in POSE_CONNECTIONS:
        if a in kv and b in kv:
            cv2.line(frame, kv[a], kv[b], color, max(2, int(3*s)))
    highlight = {KP_LEFT_WRIST, KP_RIGHT_WRIST,
                 KP_LEFT_SHOULDER, KP_RIGHT_SHOULDER,
                 KP_LEFT_HIP, KP_RIGHT_HIP}
    for idx, pt in kv.items():
        r = max(5, int(9*s)) if idx in highlight else max(3, int(5*s))
        cv2.circle(frame, pt, r, color, -1)


def draw_ball_trail(frame, trail_points, fade=True, color=(0, 255, 255), thickness=2):
    if len(trail_points) < 2: return
    s = _scale(frame)
    for i in range(1, len(trail_points)):
        a   = i / (len(trail_points)-1) if fade else 1.0
        t   = max(2, int(thickness * s * a))
        col = (int(color[0]*a), int(color[1]*a), int(color[2]*a))
        cv2.line(frame, trail_points[i-1], trail_points[i], col, t)


def draw_spine_line(frame, sm):
    s   = _scale(frame)
    kph = list(sm.kp_history)
    if not kph:
        return
    last = kph[-1]
    if not (KP_LEFT_SHOULDER in last and KP_RIGHT_SHOULDER in last
            and KP_LEFT_HIP in last and KP_RIGHT_HIP in last):
        return
    smid = ((last[KP_LEFT_SHOULDER]+last[KP_RIGHT_SHOULDER])/2).astype(int)
    hmid = ((last[KP_LEFT_HIP]     +last[KP_RIGHT_HIP])     /2).astype(int)
    lc   = (0, 220, 0) if sm.spine_in_range else (60, 60, 200)
    cv2.line(frame, tuple(hmid), tuple(smid), lc, max(2, int(3*s)))
    cv2.putText(frame, f"{sm.last_spine_angle:.0f}",
                (smid[0] + int(8*s), smid[1] - int(4*s)),
                cv2.FONT_HERSHEY_SIMPLEX,
                max(0.4, 0.6*s), lc, max(1, int(2*s)))


def draw_sidebar(frame, sm, ball_pos, ball_conf, frame_idx, total_frames,
                 fps_display, audio_enabled=False, audio_info=None,
                 setup_info=None, vision_info=None):
    h, w  = frame.shape[:2]
    s     = _scale(frame)
    state = sm.state
    sc    = STATE_COLOR.get(state, (180, 180, 180))

    sb_w  = int(260 * s)
    sb_x  = w - sb_w
    lpad  = int(10 * s)
    fs    = max(0.38, 0.52 * s)
    th    = max(1, int(1 * s))
    lh    = int(20 * s)

    ov = frame.copy()
    cv2.rectangle(ov, (sb_x, 0), (w, h), (10, 10, 10), -1)
    frame = cv2.addWeighted(ov, 0.72, frame, 0.28, 0)
    cv2.rectangle(frame, (sb_x, 0), (sb_x + int(4*s), h), sc, -1)

    y = int(18 * s)

    def put(text, col=(210, 210, 210), bold=False):
        nonlocal y
        t_ = max(1, int(2*s)) if bold else th
        cv2.putText(frame, text, (sb_x + lpad, y),
                    cv2.FONT_HERSHEY_SIMPLEX, fs, col, t_)
        y += lh

    def divider(label=""):
        nonlocal y
        cv2.line(frame, (sb_x + lpad, y - int(4*s)),
                 (w - lpad, y - int(4*s)), (70, 70, 70), 1)
        if label:
            cv2.putText(frame, label, (sb_x + lpad, y + int(4*s)),
                        cv2.FONT_HERSHEY_SIMPLEX, max(0.3, 0.42*s),
                        (120, 120, 120), th)
            y += lh

    put(f"{state}", sc, bold=True)
    put(f"F:{frame_idx}/{total_frames}", (180, 180, 180))
    put(f"FPS:{fps_display:.1f}", (180, 180, 180))

    divider("ADDRESS")
    bx   = sb_x + lpad
    bw   = sb_w - lpad * 2
    by_  = y
    prog = sm.setup_progress
    cv2.rectangle(frame, (bx, by_), (bx+bw, by_+int(12*s)), (50, 50, 50), -1)
    cv2.rectangle(frame, (bx, by_),
                  (bx+int(bw*prog), by_+int(12*s)), (0, 220, 220), -1)
    cv2.putText(frame, f"{sm.setup_frame_count}/{sm.setup_frames}",
                (bx + bw//2 - int(18*s), by_ + int(10*s)),
                cv2.FONT_HERSHEY_SIMPLEX, max(0.3, 0.4*s), (0, 0, 0), th)
    y += int(18*s)

    spinec = (0, 220, 0) if sm.spine_in_range else (80, 80, 200)
    feetc  = (0, 220, 0) if sm.feet_stable    else (80, 80, 200)
    put(f"Spine:{sm.last_spine_angle:.1f} "
        f"({sm.spine_lean_min:.0f}-{sm.spine_lean_max:.0f})", spinec)
    put(f"Feet: {'OK' if sm.feet_stable else 'NO'} "
        f"(move<{sm.setup_ankle_max:.0f}px)", feetc)
    if setup_info:
        span_col = (0, 220, 220) if setup_info.get("active") else (140, 140, 140)
        put(f"Span:{setup_info.get('frames', 0)}f  "
            f"conf:{setup_info.get('confidence', 0.0):.2f}", span_col)

    divider("SWING SCORES")
    if sm.swing_scores:
        for k, v in sm.swing_scores.items():
            short = k.replace("_motion","").replace("_change","")[:9]
            numeric = isinstance(v, (int, float, np.floating)) and v is not None
            vc = (200, 200, 200)
            if numeric and "wrist" in k and float(v) >= sm.wrist_putt_threshold:
                vc = (0, 200, 100)
            if numeric:
                put(f"{short:<9}: {float(v):5.1f}", vc)
            else:
                put(f"{short:<9}: {'n/a':>5}", (140, 140, 140))
    else:
        put("(waiting...)", (100, 100, 100))

    if vision_info and vision_info.get("enabled"):
        divider("VISION")
        current_col = (
            (0, 255, 100)
            if vision_info.get("current_score", 0.0) >= vision_info.get("threshold", 0.0)
            else (180, 180, 180)
        )
        put(f"Now:{vision_info.get('current_score', 0.0):.2f}", current_col)
        put(f"Best:{vision_info.get('best_score', 0.0):.2f}")
        put(f"Thr:{vision_info.get('threshold', 0.0):.2f}")
        if vision_info.get("candidate_frame"):
            put(f"Impact:f{vision_info['candidate_frame']}")
        window_col = (0, 255, 100) if vision_info.get("in_window") else (120, 120, 120)
        put(f"Window:{'ON' if vision_info.get('in_window') else 'off'}", window_col)
        if vision_info.get("shot_type"):
            put(f"Type:{vision_info['shot_type']}")

    divider("BALL")
    if ball_conf:
        put(f"Conf: {ball_conf:.2f}", (200, 200, 200))
    else:
        put("Not detected", (100, 100, 100))
    put(f"Gone:{sm.disappeared_frames}/{sm.max_disappear_frames}f")

    if state == "SWING":
        wc = (0, 165, 255) if sm.ball_wait_countdown > 30 else (0, 60, 200)
        put(f"Wait:{sm.ball_wait_countdown}f", wc, bold=True)

    if audio_enabled:
        divider("AUDIO")
        if audio_info:
            put(f"HIT {audio_info['strength']}", (0, 255, 100), bold=True)
            put(f"amp:{audio_info['amplitude']:.3f}")
            if "transient_score" in audio_info:
                put(f"trn:{audio_info['transient_score']:.2f}")
        else:
            put("no hit", (100, 100, 100))

    if sm.rejection_reason:
        divider()
        put(f"REJ:{sm.rejection_reason[:22]}", (80, 80, 200))

    if ball_pos:
        cx, cy = ball_pos
        r      = max(10, int(14*s))
        cv2.circle(frame, ball_pos, r, sc, max(2, int(3*s)))
        cv2.circle(frame, ball_pos, max(3, int(4*s)), (255, 255, 255), -1)

    bh  = int(28 * s)
    ov2 = frame.copy()
    cv2.rectangle(ov2, (0, 0), (sb_x, bh), (0, 0, 0), -1)
    frame = cv2.addWeighted(ov2, 0.5, frame, 0.5, 0)
    cv2.putText(frame,
                f"STATE:{state}  "
                f"Spine:{sm.last_spine_angle:.0f}  "
                f"Feet:{'OK' if sm.feet_stable else 'NO'}  "
                f"Lean:{'OK' if sm.spine_in_range else 'NO'}",
                (int(8*s), int(20*s)),
                cv2.FONT_HERSHEY_SIMPLEX,
                max(0.35, 0.5*s), sc, th)

    ph_h    = int(28 * s)
    phases  = ["IDLE", "SETUP", "SWING", "BALL_MOVED"]
    pseg_w  = sb_x // len(phases)
    for i, ph in enumerate(phases):
        x1   = i * pseg_w
        fill = STATE_COLOR[ph] if ph == state else (30, 30, 30)
        cv2.rectangle(frame, (x1, h-ph_h), (x1+pseg_w-2, h-2), fill, -1)
        cv2.putText(frame, ph, (x1 + int(4*s), h - int(8*s)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    max(0.28, 0.38*s), (255, 255, 255), th)

    return frame


# ════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════

def _dist(p1, p2):
    return math.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2)

def get_center(box):
    x1, y1, x2, y2 = box
    return int((x1+x2)/2), int((y1+y2)/2)

def format_time(s):
    s = max(0, s)
    return f"{int(s//3600):02d}:{int((s%3600)//60):02d}:{int(s%60):02d}"

def _compute_arm_swing_score(scores, wrist_threshold, wrist_speed_threshold,
                             shoulder_threshold, hip_threshold):
    if not scores:
        return 0.0
    elbow_threshold = max(18.0, wrist_threshold * 0.45)
    wrist_ratio = min(2.0, scores.get("wrist_motion", 0.0) / max(wrist_threshold, 1e-6))
    speed_ratio = min(2.0, scores.get("wrist_speed", 0.0) / max(wrist_speed_threshold, 1e-6))
    elbow_ratio = min(2.0, scores.get("elbow_motion", 0.0) / max(elbow_threshold, 1e-6))
    shoulder_ratio = min(1.8, scores.get("shoulder_change", 0.0) / max(shoulder_threshold, 1e-6))
    hip_ratio = min(1.4, scores.get("hip_change", 0.0) / max(hip_threshold, 1e-6))
    return (
        0.34 * wrist_ratio
        + 0.28 * speed_ratio
        + 0.20 * elbow_ratio
        + 0.14 * shoulder_ratio
        + 0.04 * hip_ratio
    )

def _ball_is_plausible_full_swing(ball_pos, keypoints, confidences, min_conf=0.25):
    if ball_pos is None or keypoints is None or confidences is None:
        return ball_pos is not None

    required = [KP_LEFT_ANKLE, KP_RIGHT_ANKLE, KP_LEFT_KNEE, KP_RIGHT_KNEE]
    if any(idx >= len(confidences) or confidences[idx] < min_conf for idx in required):
        return True

    ankles = np.array([keypoints[KP_LEFT_ANKLE], keypoints[KP_RIGHT_ANKLE]], dtype=float)
    knees = np.array([keypoints[KP_LEFT_KNEE], keypoints[KP_RIGHT_KNEE]], dtype=float)
    stance_mid_x = float(np.mean(ankles[:, 0]))
    ankle_span = float(abs(ankles[0, 0] - ankles[1, 0]))
    knee_y = float(np.mean(knees[:, 1]))
    ankle_y = float(np.mean(ankles[:, 1]))
    body_scale = max(60.0, float(np.linalg.norm(np.mean(knees, axis=0) - np.mean(ankles, axis=0))) * 2.2)

    max_dx = max(90.0, ankle_span * 0.95, body_scale * 0.45)
    min_y = knee_y
    max_y = ankle_y + max(55.0, body_scale * 0.18)

    return (abs(ball_pos[0] - stance_mid_x) <= max_dx
            and min_y <= ball_pos[1] <= max_y)


def _estimate_putt_scene(frame, keypoints, confidences, min_conf=0.25):
    h, w = frame.shape[:2]
    y0 = int(h * 0.35)
    region = frame[y0:, :]
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    hch, sch, vch = cv2.split(hsv)
    green_mask = (
        (hch >= 25) & (hch <= 95)
        & (sch >= 20)
        & (vch >= 35)
    )
    green_ratio = float(np.mean(green_mask))
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    pose_height_ratio = None
    if keypoints is not None and confidences is not None:
        valid = []
        for idx in range(min(len(confidences), len(keypoints))):
            if confidences[idx] >= min_conf:
                valid.append(keypoints[idx])
        if valid:
            valid = np.asarray(valid, dtype=float)
            pose_height_ratio = float(
                (np.max(valid[:, 1]) - np.min(valid[:, 1])) / max(float(h), 1.0)
            )

    score = 0.0
    if green_ratio >= 0.60:
        score += 0.55
    elif green_ratio >= 0.54:
        score += 0.35

    if pose_height_ratio is None:
        score += 0.35
    elif pose_height_ratio <= 0.18:
        score += 0.40
    elif pose_height_ratio <= 0.23:
        score += 0.30
    elif pose_height_ratio <= 0.27:
        score += 0.15

    if lap_var <= 900.0:
        score += 0.15
    elif lap_var <= 1800.0:
        score += 0.07

    return {
        "score": min(1.0, score),
        "green_ratio": green_ratio,
        "pose_height_ratio": pose_height_ratio,
        "laplacian_var": lap_var,
    }


def _swing_context_looks_like_putt(swing_ctx, ball_move_dist=None):
    if not swing_ctx:
        return False
    metrics = swing_ctx.get("metrics", [])
    if not metrics:
        return False

    def _percentile(metric_name, pct):
        values = [metric.get(metric_name, 0.0) for metric in metrics]
        if not values:
            return 0.0
        return float(np.percentile(values, pct))

    scene_peak = max(metric.get("scene_putt_score", 0.0) for metric in metrics)
    pose_heights = [
        metric.get("scene_pose_height_ratio")
        for metric in metrics
        if metric.get("scene_pose_height_ratio") is not None
    ]
    pose_height = min(pose_heights) if pose_heights else None
    max_shoulder = max(metric.get("shoulder_change", 0.0) for metric in metrics)
    max_hip = max(metric.get("hip_change", 0.0) for metric in metrics)
    max_wrist_motion = max(metric.get("wrist_motion", 0.0) for metric in metrics)
    max_wrist_speed = max(metric.get("wrist_speed", 0.0) for metric in metrics)
    max_elbow = max(metric.get("elbow_motion", 0.0) for metric in metrics)
    p90_shoulder = _percentile("shoulder_change", 90)
    p90_hip = _percentile("hip_change", 90)
    p90_wrist_speed = _percentile("wrist_speed", 90)
    p75_wrist_motion = _percentile("wrist_motion", 75)
    p75_wrist_speed = _percentile("wrist_speed", 75)
    p75_shoulder = _percentile("shoulder_change", 75)
    p75_hip = _percentile("hip_change", 75)
    scene_green_peak = max(metric.get("scene_green_ratio", 0.0) for metric in metrics)

    trail = swing_ctx.get("ball_trail") or []
    setup_span = swing_ctx.get("setup_span") or {}
    rolling_putt_like = _ball_trail_looks_like_putt_roll(trail)
    recent_metrics = metrics[-8:]
    valid_spine_angles = [
        metric.get("spine_angle")
        for metric in recent_metrics
        if metric.get("spine_angle") is not None and metric.get("spine_angle") > 0.0
    ]
    stable_green_spine_frames = 0
    if valid_spine_angles:
        spine_median = float(np.median(valid_spine_angles))
        for angle in reversed(valid_spine_angles):
            if angle < 15.0 or angle > 60.0 or abs(angle - spine_median) > 10.0:
                break
            stable_green_spine_frames += 1

    # Very large ball displacement indicates a struck ball, not a putt roll
    if ball_move_dist is not None and ball_move_dist >= 150.0:
        return False
    strong_full_swing_burst = (
        max_wrist_motion >= 110.0
        and max_wrist_speed >= 25.0
        and (
            max_elbow >= 70.0
            or max_shoulder >= 40.0
            or max_hip >= 25.0
        )
    )
    if strong_full_swing_burst:
        return False
    if any(_live_scores_look_like_full_swing(metric) for metric in recent_metrics):
        return False
    if rolling_putt_like and scene_green_peak >= 0.60:
        if (
            pose_height is None
            or pose_height <= 0.24
            or scene_peak >= 0.55
        ):
            return True
    if (rolling_putt_like
            and (
                scene_peak >= 0.82
                or (
                    scene_green_peak >= 0.72
                    and pose_height is not None
                    and pose_height <= 0.22
                )
                or (
                    max_wrist_motion <= 75.0
                    and max_wrist_speed <= 28.0
                    and max_elbow <= 50.0
                    and max_shoulder <= 22.0
                    and max_hip <= 12.0
                )
            )):
        return True

    far_green_putt_like = (
        scene_green_peak >= 0.55
        and scene_peak >= 0.60
        and pose_height is not None
        and pose_height <= 0.18
        and stable_green_spine_frames < 6
        and max_wrist_motion <= 120.0
        and max_wrist_speed <= 48.0
        and max_elbow <= 110.0
        and max_shoulder <= 42.0
        and max_hip <= 22.0
    )
    if far_green_putt_like:
        return True
    weak_setup = (
        setup_span.get("frame_count", 0) < 10
        or setup_span.get("avg_confidence", setup_span.get("confidence", 0.0)) < 0.60
    )
    far_no_setup_putt_like = (
        scene_green_peak >= 0.60
        and scene_peak >= 0.72
        and pose_height is not None
        and pose_height <= 0.18
        and weak_setup
        and p75_wrist_motion <= 95.0
        and p75_wrist_speed <= 45.0
        and p90_shoulder <= 48.0
        and p90_hip <= 28.0
        and max_elbow <= 120.0
    )
    if far_no_setup_putt_like:
        return True
    if scene_peak < 0.72:
        if not (rolling_putt_like and scene_green_peak >= 0.66):
            return False
    if pose_height is not None and pose_height > 0.27:
        return False
    if (rolling_putt_like
            and scene_green_peak >= 0.66
            and p75_wrist_motion <= 65.0
            and p75_wrist_speed <= 28.0
            and p75_shoulder <= 18.0
            and p75_hip <= 10.0):
        return True
    if (ball_move_dist is not None
            and ball_move_dist <= 40.0
            and scene_green_peak >= 0.68
            and p75_wrist_motion <= 80.0
            and p75_wrist_speed <= 38.0
            and p75_shoulder <= 22.0
            and p75_hip <= 12.0):
        return True
    strong_scene_putt_like = scene_peak >= 0.90 and (pose_height is None or pose_height <= 0.24)
    if strong_scene_putt_like:
        if p90_shoulder <= 42.0 and p90_hip <= 20.0:
            return True
        if (ball_move_dist is None
                and p90_shoulder <= 55.0
                and p90_hip <= 25.0
                and p90_wrist_speed <= 75.0):
            return True
        if ball_move_dist is not None and ball_move_dist <= 250.0:
            return True
    if ball_move_dist is not None and ball_move_dist <= 90.0:
        return True
    if max_shoulder > 36.0 or max_hip > 14.0:
        return False
    if max_wrist_speed > 60.0 and max_elbow > 180.0 and p90_wrist_speed > 45.0:
        return False
    return True


def _live_scores_look_like_putt(scores, scene_green_ratio, scene_putt_score, ball_move_dist=None):
    if ball_move_dist is None or ball_move_dist > 160.0:
        return False
    if not scores:
        return (
            scene_green_ratio >= 0.72
            and scene_putt_score >= 0.60
        )
    wrist_motion = scores.get("wrist_motion", 0.0)
    wrist_speed = scores.get("wrist_speed", 0.0)
    shoulder = scores.get("shoulder_change", 0.0)
    hip = scores.get("hip_change", 0.0)
    elbow = scores.get("elbow_motion", 0.0)
    if scene_green_ratio < 0.62:
        return False
    if scene_putt_score < 0.45:
        return False
    if ball_move_dist <= 70.0:
        wrist_cap = 25.0
        speed_cap = 15.0
        shoulder_cap = 12.0
        hip_cap = 8.0
        elbow_cap = 20.0
    else:
        wrist_cap = 35.0
        speed_cap = 22.0
        shoulder_cap = 16.0
        hip_cap = 10.0
        elbow_cap = 30.0
    return (
        wrist_motion <= wrist_cap
        and wrist_speed <= speed_cap
        and shoulder <= shoulder_cap
        and hip <= hip_cap
        and elbow <= elbow_cap
    )


def _live_scores_look_like_full_swing(scores):
    if not scores:
        return False
    wrist_motion = scores.get("wrist_motion", 0.0)
    wrist_speed = scores.get("wrist_speed", 0.0)
    shoulder = scores.get("shoulder_change", 0.0)
    hip = scores.get("hip_change", 0.0)
    elbow = scores.get("elbow_motion", 0.0)
    torso = max(shoulder, hip)
    return (
        wrist_motion >= 80.0
        and (
            (wrist_speed >= 25.0 and torso >= 15.0)
            or elbow >= 70.0
            or torso >= 28.0
        )
    )


def _ball_trail_looks_like_putt_roll(ball_trail):
    if not ball_trail:
        return False
    pts = [pt for pt in ball_trail if pt is not None]
    if len(pts) < 4:
        return False

    steps = [_dist(pts[i - 1], pts[i]) for i in range(1, len(pts))]
    if not steps:
        return False

    longest_run = 0
    current_run = 0
    rolling_steps = []
    total_path = 0.0
    for step in steps:
        if 0.5 <= step <= 45.0:
            current_run += 1
            longest_run = max(longest_run, current_run)
            rolling_steps.append(step)
            total_path += step
        else:
            current_run = 0

    if len(rolling_steps) < 3:
        return False
    median_step = float(np.median(rolling_steps))
    p90_step = float(np.percentile(rolling_steps, 90))
    return (
        longest_run >= 3
        and total_path >= 10.0
        and median_step <= 20.0
        and p90_step <= 38.0
    )


def _find_supportive_anchor_metric(swing_ctx, wrist_threshold, torso_threshold, recent_frames=18):
    if not swing_ctx:
        return None
    metrics = swing_ctx.get("metrics", [])
    if not metrics:
        return None

    best = None
    for metric in metrics[-max(6, recent_frames):]:
        spine_angle = metric.get("spine_angle")
        if spine_angle is not None and spine_angle > 60.0:
            continue

        support_count, support_score = _swing_support_stats(
            metric,
            wrist_threshold,
            torso_threshold,
        )
        if support_count < 2:
            continue

        wrist_motion = metric.get("wrist_motion", 0.0)
        elbow_motion = metric.get("elbow_motion", 0.0)
        torso_motion = max(
            metric.get("shoulder_change", 0.0),
            metric.get("hip_change", 0.0),
        )
        if not (
            wrist_motion >= wrist_threshold * 0.55
            or elbow_motion >= max(35.0, wrist_threshold * 0.65)
            or torso_motion >= max(28.0, torso_threshold * 2.5)
        ):
            continue

        score = wrist_motion / max(wrist_threshold, 1e-6)
        score += 0.22 * support_score
        score += 0.18 * (torso_motion / max(torso_threshold, 1e-6))
        if elbow_motion >= max(35.0, wrist_threshold * 0.65):
            score += 0.35
        if metric.get("spine_in_range", False):
            score += 0.15

        candidate = {
            "frame_idx": metric["frame_idx"],
            "score": score,
        }
        if (best is None
                or candidate["score"] > best["score"]
                or (
                    abs(candidate["score"] - best["score"]) <= 0.10
                    and candidate["frame_idx"] > best["frame_idx"]
                )):
            best = candidate
    return best


def _select_ball_candidate(candidates, keypoints, confidences, previous_ball=None):
    if not candidates:
        return None, None

    plausible = []
    for confidence, center in candidates:
        if not _ball_is_plausible_full_swing(center, keypoints, confidences):
            continue
        score = confidence * 100.0
        if previous_ball is not None:
            score -= 0.04 * min(_dist(center, previous_ball), 250.0)
        plausible.append((score, confidence, center))

    if not plausible:
        confidence, center = max(candidates, key=lambda item: item[0])
        return confidence, center

    _, confidence, center = max(plausible, key=lambda item: item[0])
    return confidence, center

def collect_clips(clips_dir):
    """Return sorted list of .mp4 and .mov files in clips_dir (case-insensitive)."""
    clips_dir = Path(clips_dir)
    clips = []
    for ext in VIDEO_EXTENSIONS:
        clips.extend(clips_dir.glob(ext))
    seen, unique = set(), []
    for c in sorted(clips):
        key = c.resolve()
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique

def _ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def _ffprobe_duration(path):
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def _extract_audio_wav(src_path, wav_path, sample_rate):
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src_path),
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        str(wav_path),
    ]
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0


def _classify_impact_strength(score, max_score):
    rel = score / max(max_score, 1e-6)
    if score >= 18 or rel >= 0.85:
        return "strong"
    if score >= 12 or rel >= 0.60:
        return "medium"
    if score >= 8 or rel >= 0.35:
        return "weak"
    return "very_weak"


def _detect_clip_impacts(clip_path, clip_start_sec, sample_rate, highpass_hz,
                         peak_rel_threshold=0.4, peak_min_separation_sec=0.75,
                         transient_min_score=0.65,
                         wind_reject_max_duration=0.12):
    if not _ffmpeg_available():
        return []

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = tf.name

    try:
        if not _extract_audio_wav(clip_path, wav_path, sample_rate):
            return []

        y, sr = librosa.load(wav_path, sr=None, mono=True)
        if y.size == 0 or np.max(np.abs(y)) < 1e-5:
            return []

        try:
            sos = signal.butter(4, highpass_hz, btype="highpass", fs=sr, output="sos")
            y = signal.sosfiltfilt(sos, y).astype(np.float32)
        except ValueError:
            y = y.astype(np.float32)

        hop_length = max(256, int(sr * 0.01))
        onset_env = librosa.onset.onset_strength(
            y=y, sr=sr, hop_length=hop_length, aggregate=np.median)
        if onset_env.size == 0:
            return []

        onset_env = np.nan_to_num(onset_env, nan=0.0, posinf=0.0, neginf=0.0)
        stft_mag = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop_length))
        stft_mag = np.nan_to_num(stft_mag, nan=0.0, posinf=0.0, neginf=0.0)
        centroid = librosa.feature.spectral_centroid(
            S=stft_mag + 1e-6, sr=sr).reshape(-1)
        rolloff = librosa.feature.spectral_rolloff(
            S=stft_mag + 1e-6, sr=sr, roll_percent=0.85).reshape(-1)
        baseline = float(np.median(onset_env))
        spread = float(np.median(np.abs(onset_env - baseline))) + 1e-6
        scores = (onset_env - baseline) / spread

        min_distance = max(1, int(0.18 / (hop_length / sr)))
        height = max(6.0, float(np.percentile(scores, 97)))
        prominence = max(2.0, height * 0.25)
        peaks, props = signal.find_peaks(
            scores,
            height=height,
            prominence=prominence,
            distance=min_distance,
        )
        if len(peaks) == 0:
            return []

        peak_scores = props.get("peak_heights", scores[peaks])
        prominences = props.get("prominences", np.ones_like(peak_scores))
        widths, _, left_ips, right_ips = signal.peak_widths(scores, peaks, rel_height=0.6)
        max_score = float(max(peak_scores)) if len(peak_scores) else 1.0
        max_prominence = float(max(prominences)) if len(prominences) else 1.0
        centroid_ref = max(2500.0, float(np.percentile(centroid, 95)) if centroid.size else 2500.0)
        rolloff_ref = max(4500.0, float(np.percentile(rolloff, 95)) if rolloff.size else 4500.0)
        peak_candidates = sorted(
            [
                candidate
                for candidate in (
                    {
                        "clip_time_sec": float(librosa.frames_to_time(peak, sr=sr, hop_length=hop_length)),
                        "score": float(score),
                        "duration_sec": float(max(hop_length / sr, (right_ip - left_ip) * hop_length / sr)),
                        "centroid_hz": float(centroid[min(len(centroid) - 1, int(round(peak)))])
                                       if centroid.size else 0.0,
                        "rolloff_hz": float(rolloff[min(len(rolloff) - 1, int(round(peak)))])
                                      if rolloff.size else 0.0,
                        "prominence": float(prominence_value),
                    }
                    for peak, score, prominence_value, left_ip, right_ip in zip(
                        peaks, peak_scores, prominences, left_ips, right_ips
                    )
                )
                if candidate["score"] >= max_score * peak_rel_threshold
            ],
            key=lambda item: item["score"],
            reverse=True,
        )

        for candidate in peak_candidates:
            rel_score = candidate["score"] / max(max_score, 1e-6)
            rel_prominence = candidate["prominence"] / max(max_prominence, 1e-6)
            centroid_norm = min(1.0, candidate["centroid_hz"] / centroid_ref)
            rolloff_norm = min(1.0, candidate["rolloff_hz"] / rolloff_ref)
            duration_penalty = 0.0
            if candidate["duration_sec"] > wind_reject_max_duration:
                overflow = ((candidate["duration_sec"] - wind_reject_max_duration)
                            / max(wind_reject_max_duration, 1e-6))
                duration_penalty = min(0.55, overflow * 0.35)
            candidate["transient_score"] = max(
                0.0,
                (0.42 * rel_score)
                + (0.28 * rel_prominence)
                + (0.15 * centroid_norm)
                + (0.15 * rolloff_norm)
                - duration_penalty,
            )

        selected = []
        for candidate in sorted(
            peak_candidates,
            key=lambda item: (item["transient_score"], item["score"]),
            reverse=True,
        ):
            if candidate["duration_sec"] > wind_reject_max_duration:
                continue
            if candidate["transient_score"] < transient_min_score:
                continue
            if any(abs(candidate["clip_time_sec"] - prev["clip_time_sec"]) < peak_min_separation_sec
                   for prev in selected):
                continue
            selected.append(candidate)

        impacts = []
        for candidate in sorted(selected, key=lambda item: item["clip_time_sec"]):
            score = float(candidate["score"])
            clip_time_sec = float(candidate["clip_time_sec"])
            impacts.append({
                "clip_name": Path(clip_path).name,
                "clip_time_sec": round(clip_time_sec, 3),
                "timestamp_sec": round(clip_start_sec + clip_time_sec, 3),
                "amplitude": round(score, 4),
                "strength": _classify_impact_strength(score, max_score),
                "transient_score": round(candidate["transient_score"], 4),
                "duration_sec": round(candidate["duration_sec"], 4),
                "centroid_hz": round(candidate["centroid_hz"], 1),
            })
        return impacts
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def _audio_sidecars_current(clips_dir, clips, impacts_csv, timestamps_csv):
    if not impacts_csv.exists() or not timestamps_csv.exists():
        return False

    latest_clip_mtime = max((clip.stat().st_mtime for clip in clips), default=0)
    if impacts_csv.stat().st_mtime < latest_clip_mtime:
        return False
    if timestamps_csv.stat().st_mtime < latest_clip_mtime:
        return False

    try:
        with open(timestamps_csv) as f:
            timestamp_rows = list(csv.DictReader(f))
    except Exception:
        return False

    try:
        with open(impacts_csv) as f:
            impact_reader = csv.DictReader(f)
            impact_fields = set(impact_reader.fieldnames or [])
    except Exception:
        return False

    required_impact_fields = {
        "clip_name", "clip_time_sec", "timestamp_sec",
        "amplitude", "strength", "transient_score",
        "duration_sec", "centroid_hz",
    }
    if not required_impact_fields.issubset(impact_fields):
        return False

    clip_names = {clip.name for clip in clips}
    indexed_names = {row.get("clip_name") for row in timestamp_rows}
    if clip_names - indexed_names:
        return False
    return True


def ensure_audio_sidecars(clips_dir, clips, sample_rate=44100, highpass_hz=1200.0,
                          peak_rel_threshold=0.4, peak_min_separation_sec=0.75,
                          transient_min_score=0.65,
                          wind_reject_max_duration=0.12,
                          verbose=True):
    clips_dir = Path(clips_dir)
    impacts_csv = clips_dir / "impact_sounds.csv"
    timestamps_csv = clips_dir / "clips_timestamps.csv"

    if not clips:
        return False
    if not _ffmpeg_available():
        print("[AudioPrep] ffmpeg not found — audio metadata generation disabled")
        return False
    if _audio_sidecars_current(clips_dir, clips, impacts_csv, timestamps_csv):
        if verbose:
            print(f"[AudioPrep] Reusing existing audio sidecars in '{clips_dir}'")
        return True

    impacts = []
    timestamps = []
    clip_start_sec = 0.0

    for clip in clips:
        duration = _ffprobe_duration(clip)
        if duration is None:
            cap = cv2.VideoCapture(str(clip))
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
            duration = frames / fps if fps else 0.0
            cap.release()

        timestamps.append({
            "clip_name": clip.name,
            "start_sec": round(clip_start_sec, 3),
            "duration_sec": round(duration, 3),
        })

        clip_impacts = _detect_clip_impacts(
            clip,
            clip_start_sec,
            sample_rate=sample_rate,
            highpass_hz=highpass_hz,
            peak_rel_threshold=peak_rel_threshold,
            peak_min_separation_sec=peak_min_separation_sec,
            transient_min_score=transient_min_score,
            wind_reject_max_duration=wind_reject_max_duration,
        )
        impacts.extend(clip_impacts)
        if verbose:
            print(f"[AudioPrep] {clip.name}: {len(clip_impacts)} impact(s) detected")

        clip_start_sec += duration

    with open(impacts_csv, "w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["clip_name", "clip_time_sec", "timestamp_sec",
                           "amplitude", "strength", "transient_score",
                           "duration_sec", "centroid_hz"])
        writer.writeheader()
        writer.writerows(impacts)

    with open(timestamps_csv, "w", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["clip_name", "start_sec", "duration_sec"])
        writer.writeheader()
        writer.writerows(timestamps)

    print(f"[AudioPrep] Wrote {impacts_csv.name} ({len(impacts)} hits) and "
          f"{timestamps_csv.name} ({len(timestamps)} clips)")
    return True


def _setup_confidence(sm, ball_anchor):
    return ((0.45 if sm.feet_stable else 0.0)
            + (0.35 if sm.spine_in_range else 0.0)
            + (0.20 if ball_anchor else 0.0))


def _finalize_setup_span(span):
    if not span or span.get("frame_count", 0) <= 0:
        return None
    finalized = span.copy()
    finalized["avg_confidence"] = (
        finalized["confidence_sum"] / max(1, finalized["frame_count"])
    )
    return finalized


def _select_setup_span(setup_spans, swing_entry_frame, max_gap_frames=12):
    candidates = [
        span for span in setup_spans
        if span and span["end_frame"] <= swing_entry_frame
        and (swing_entry_frame - span["end_frame"]) <= max_gap_frames
    ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda span: (
            -(swing_entry_frame - span["end_frame"]),
            span.get("frame_count", 0),
            span.get("avg_confidence", 0.0),
        ),
    ).copy()


def _compute_vision_score(scores, wrist_threshold, torso_threshold):
    return _compute_arm_swing_score(
        scores,
        wrist_threshold,
        max(8.0, torso_threshold),
        max(4.0, torso_threshold * 0.70),
        max(3.0, torso_threshold * 0.45),
    )


def _swing_support_stats(metric, wrist_threshold, torso_threshold):
    wrist_speed = metric.get("wrist_speed", 0.0)
    elbow_motion = metric.get("elbow_motion", 0.0)
    torso_motion = max(
        metric.get("shoulder_change", 0.0),
        metric.get("hip_change", 0.0),
    )

    wrist_speed_floor = max(8.0, wrist_threshold * 0.20)
    elbow_floor = max(12.0, wrist_threshold * 0.30)
    torso_floor = max(5.0, torso_threshold * 0.55)

    support_count = int(wrist_speed >= wrist_speed_floor)
    support_count += int(elbow_motion >= elbow_floor)
    support_count += int(torso_motion >= torso_floor)

    support_score = min(2.0, wrist_speed / max(wrist_speed_floor, 1e-6))
    support_score += min(2.0, elbow_motion / max(elbow_floor, 1e-6))
    support_score += min(2.0, torso_motion / max(torso_floor, 1e-6))
    return support_count, support_score


def _evaluate_vision_candidate(
    swing_ctx,
    wrist_threshold,
    torso_threshold,
    followthrough_frames,
    setup_min_frames,
    setup_confidence_min,
    fps,
):
    if not swing_ctx or swing_ctx.get("shot_type") != "SWING":
        return None

    metrics = swing_ctx.get("metrics", [])
    if len(metrics) < max(3, followthrough_frames + 1):
        return None

    setup_span = swing_ctx.get("setup_span")
    if setup_span and (
        setup_span.get("frame_count", 0) < setup_min_frames
        or setup_span.get("avg_confidence", 0.0) < setup_confidence_min
    ):
        setup_span = None

    enriched = []
    for metric in metrics:
        support_count, support_score = _swing_support_stats(
            metric,
            wrist_threshold,
            torso_threshold,
        )
        enriched_metric = metric.copy()
        enriched_metric["support_count"] = support_count
        enriched_metric["support_score"] = support_score
        enriched.append(enriched_metric)

    clusters = []
    current_cluster = []
    gap_tolerance = 1
    inactive_gap = 0

    for metric in enriched:
        wrist_motion = metric.get("wrist_motion", 0.0)
        active = (
            wrist_motion >= wrist_threshold * 0.65
            or (
                wrist_motion >= wrist_threshold * 0.50
                and metric.get("support_count", 0) >= 1
            )
        )
        if active:
            if inactive_gap > gap_tolerance and current_cluster:
                clusters.append(current_cluster)
                current_cluster = []
            current_cluster.append(metric)
            inactive_gap = 0
        elif current_cluster:
            inactive_gap += 1

    if current_cluster:
        clusters.append(current_cluster)

    candidates = []
    setup_end_frame = setup_span.get("end_frame") if setup_span else None

    for cluster in clusters:
        peak_metric = max(
            cluster,
            key=lambda item: (
                item.get("wrist_motion", 0.0),
                item.get("support_score", 0.0),
                -item["frame_idx"],
            ),
        )
        if peak_metric.get("wrist_motion", 0.0) < wrist_threshold:
            continue
        if peak_metric.get("support_count", 0) < 1:
            continue

        peak_idx = next(
            idx for idx, item in enumerate(enriched)
            if item["frame_idx"] == peak_metric["frame_idx"]
        )
        follow = enriched[peak_idx + 1: peak_idx + 1 + followthrough_frames]
        follow_support = sum(
            1 for item in follow
            if item.get("wrist_motion", 0.0) >= wrist_threshold * 0.45
            or item.get("support_count", 0) >= 1
            or item.get("vision_score", item.get("arm_swing_score", 0.0)) >= 0.60
        )

        peak_wrist = peak_metric.get("wrist_motion", 0.0)
        peak_frame = peak_metric["frame_idx"]
        lead_frames = max(3, int(round(0.75 * max(fps, 1.0))))
        anchor_threshold = max(wrist_threshold, peak_wrist * 0.90)
        anchor_metric = next(
            (
                item for item in cluster
                if item["frame_idx"] >= peak_frame - lead_frames
                and item["frame_idx"] <= peak_frame
                if item.get("wrist_motion", 0.0) >= anchor_threshold
                and item.get("support_count", 0) >= 1
            ),
            None,
        )
        if anchor_metric is None:
            relaxed_threshold = max(wrist_threshold, peak_wrist * 0.84)
            anchor_metric = next(
                (
                    item for item in cluster
                    if item["frame_idx"] >= peak_frame - max(4, int(round(1.0 * max(fps, 1.0))))
                    and item["frame_idx"] <= peak_frame
                    if item.get("wrist_motion", 0.0) >= relaxed_threshold
                    and item.get("support_count", 0) >= 1
                ),
                peak_metric,
            )

        anchor_spine = anchor_metric.get("spine_angle")
        if anchor_spine is not None and anchor_spine > 60.0:
            continue

        cluster_anchor_idx = next(
            idx for idx, item in enumerate(cluster)
            if item["frame_idx"] == anchor_metric["frame_idx"]
        )
        anchor_global_idx = next(
            idx for idx, item in enumerate(enriched)
            if item["frame_idx"] == anchor_metric["frame_idx"]
        )
        pre_anchor_window = cluster[max(0, cluster_anchor_idx - 8): cluster_anchor_idx + 1]
        spine_angles = [
            item.get("spine_angle")
            for item in pre_anchor_window
            if item.get("spine_angle") is not None and item.get("spine_angle") > 0.0
        ]
        spine_instability = 0.0
        stable_fraction = 1.0
        spine_median = anchor_spine if anchor_spine is not None else 0.0
        if len(spine_angles) >= 4:
            spine_median = float(np.median(spine_angles))
            deviations = [abs(angle - spine_median) for angle in spine_angles]
            spine_instability = max(deviations)
            stable_fraction = sum(dev <= 10.0 for dev in deviations) / len(deviations)
            if spine_median < 15.0 or spine_median > 60.0:
                continue
            if stable_fraction < 0.75 or spine_instability > 12.0:
                continue

        green_spine_run = 0
        if spine_median and spine_median > 0.0:
            for item in reversed(cluster[:cluster_anchor_idx + 1]):
                angle = item.get("spine_angle")
                if angle is None or angle <= 0.0 or angle > 60.0:
                    break
                if angle < 15.0:
                    break
                if abs(angle - spine_median) > 10.0:
                    break
                green_spine_run += 1

        stable_pre_anchor_run = 0
        if spine_median and spine_median > 0.0:
            for item in reversed(enriched[:anchor_global_idx + 1]):
                angle = item.get("spine_angle")
                if angle is None or angle <= 0.0 or angle > 60.0:
                    break
                if angle < 15.0:
                    break
                if abs(angle - spine_median) > 10.0:
                    break
                stable_pre_anchor_run += 1

        post_anchor_frames = max(followthrough_frames, int(round(2.0 * max(fps, 1.0))))
        immediate_post_frames = max(4, int(round(1.0 * max(fps, 1.0))))
        post_anchor_window = enriched[anchor_global_idx + 1: anchor_global_idx + 1 + post_anchor_frames]
        immediate_post_window = enriched[anchor_global_idx + 1: anchor_global_idx + 1 + immediate_post_frames]
        post_spine_angles = [
            item.get("spine_angle")
            for item in post_anchor_window
            if item.get("spine_angle") is not None and item.get("spine_angle") > 0.0
        ]
        immediate_post_angles = [
            item.get("spine_angle")
            for item in immediate_post_window
            if item.get("spine_angle") is not None and item.get("spine_angle") > 0.0
        ]
        post_anchor_break = False
        immediate_post_break = False
        post_anchor_break_count = 0
        post_anchor_stable_fraction = 1.0
        if post_spine_angles:
            post_anchor_break_count = sum(angle > 60.0 for angle in post_spine_angles)
            post_deviations = [abs(angle - spine_median) for angle in post_spine_angles]
            post_anchor_stable_fraction = (
                sum(dev <= 10.0 for dev in post_deviations) / len(post_deviations)
            )
            post_anchor_break = post_anchor_break_count > 0
        if immediate_post_angles:
            immediate_post_break = any(angle > 60.0 for angle in immediate_post_angles)

        anchor_spine_valid = anchor_spine is not None and 15.0 <= anchor_spine <= 60.0
        fallback_spine_ok = anchor_spine is None or anchor_spine <= 60.0
        posture_backed = (
            anchor_spine_valid
            and stable_pre_anchor_run >= max(6, int(round(0.75 * max(fps, 1.0))))
            and green_spine_run >= max(4, int(round(0.40 * max(fps, 1.0))))
            and stable_fraction >= 0.75
        )
        setup_aligned = False
        setup_bonus = 0.0
        setup_gap_frames = None
        setup_gap_penalty = 0.0
        if setup_span:
            gap_from_setup = max(0, cluster[0]["frame_idx"] - setup_end_frame)
            setup_gap_frames = max(0, anchor_metric["frame_idx"] - setup_end_frame)
            setup_bonus = max(0.0, 0.42 - (0.02 * min(gap_from_setup, 16)))
            setup_aligned = gap_from_setup <= max(18, followthrough_frames * 4)
            gap_sec = setup_gap_frames / max(fps, 1.0)
            if gap_sec > 2.0:
                setup_gap_penalty = min(4.5, 0.28 * ((gap_sec - 2.0) ** 2))
        if posture_backed:
            setup_aligned = True
            setup_bonus = max(setup_bonus, 0.30)
            setup_gap_penalty *= 0.15
        spine_penalty = 0.0 if anchor_metric.get("spine_in_range", False) else 0.55
        if immediate_post_break:
            post_break_penalty = 0.75 if posture_backed else 5.0
        elif post_anchor_break:
            post_break_penalty = 0.35 if posture_backed else 2.0
        else:
            post_break_penalty = 0.0
        setup_support_score = (
            (1.55 if setup_aligned else 0.0)
            + min(2.10, 0.12 * stable_pre_anchor_run)
            + min(1.10, 0.07 * green_spine_run)
            + (0.55 if anchor_spine_valid else 0.0)
            + (0.35 if stable_fraction >= 0.85 else 0.0)
        )

        cluster_score = peak_wrist / max(wrist_threshold, 1e-6)
        cluster_score += 0.18 * peak_metric.get("support_score", 0.0)
        cluster_score += 0.05 * follow_support
        cluster_score += setup_bonus
        cluster_score += setup_support_score
        cluster_score -= setup_gap_penalty
        cluster_score -= spine_penalty
        cluster_score -= post_break_penalty
        if spine_instability > 0.0:
            cluster_score -= 0.03 * spine_instability
        cluster_score += 0.45 * stable_fraction
        cluster_score += 0.05 * post_anchor_stable_fraction

        if setup_aligned and anchor_spine_valid and stable_pre_anchor_run >= 8 and stable_fraction >= 0.85 and not immediate_post_break:
            validation_tier = 0
        elif setup_aligned and anchor_spine_valid and stable_pre_anchor_run >= 5 and stable_fraction >= 0.75 and not immediate_post_break:
            validation_tier = 1
        elif posture_backed and anchor_spine_valid and stable_pre_anchor_run >= 8 and stable_fraction >= 0.75:
            validation_tier = 2
        elif anchor_spine_valid and stable_pre_anchor_run >= 5 and stable_fraction >= 0.75 and not immediate_post_break:
            validation_tier = 2
        elif fallback_spine_ok and not immediate_post_break and not post_anchor_break:
            validation_tier = 3
        else:
            validation_tier = 4

        candidates.append({
            "impact_frame": anchor_metric["frame_idx"],
            "score": cluster_score,
            "wrist_motion": anchor_metric.get("wrist_motion", 0.0),
            "peak_wrist_motion": peak_wrist,
            "threshold": wrist_threshold,
            "followthrough_count": follow_support,
            "setup_span": setup_span,
            "candidate_end_frame": cluster[-1]["frame_idx"],
            "cluster_start_frame": cluster[0]["frame_idx"],
            "peak_frame": peak_metric["frame_idx"],
            "setup_aligned": setup_aligned,
            "setup_gap_frames": setup_gap_frames,
            "setup_gap_penalty": setup_gap_penalty,
            "spine_instability": spine_instability,
            "spine_stable_fraction": stable_fraction,
            "anchor_spine_angle": anchor_spine,
            "posture_backed": posture_backed,
            "green_spine_run": green_spine_run,
            "stable_pre_anchor_run": stable_pre_anchor_run,
            "immediate_post_break": immediate_post_break,
            "post_anchor_break": post_anchor_break,
            "post_anchor_break_count": post_anchor_break_count,
            "post_anchor_stable_fraction": post_anchor_stable_fraction,
            "setup_support_score": setup_support_score,
            "validation_tier": validation_tier,
        })

    if not candidates:
        return None

    best_score = max(candidate["score"] for candidate in candidates)
    tier_margins = {
        0: 0.60,
        1: 0.72,
        2: 0.88,
        3: 0.94,
        4: 1.00,
    }
    candidate_pool = None
    for tier in (0, 1, 2, 3, 4):
        tier_candidates = [c for c in candidates if c.get("validation_tier", 3) == tier]
        if not tier_candidates:
            continue
        tier_best_score = max(c["score"] for c in tier_candidates)
        if tier_best_score >= best_score * tier_margins[tier]:
            candidate_pool = tier_candidates
            break
    if candidate_pool is None:
        candidate_pool = [
            candidate for candidate in candidates
            if candidate["score"] >= best_score * 0.75
        ]

    tied_candidates = list(candidate_pool)
    tied_candidates.sort(
        key=lambda candidate: (
            candidate.get("validation_tier", 3),
            0 if candidate.get("setup_aligned") else 1,
            0 if not candidate.get("immediate_post_break") else 1,
            0 if not candidate.get("post_anchor_break") else 1,
            -candidate.get("setup_support_score", 0.0),
            -candidate.get("stable_pre_anchor_run", 0),
            -candidate.get("green_spine_run", 0),
            -candidate.get("spine_stable_fraction", 0.0),
            -candidate["score"],
            candidate["impact_frame"],
        )
    )
    return tied_candidates[0]


def _find_posture_break_frame(frame_records, impact_frame, min_break_frames=4):
    if impact_frame is None:
        return None
    last_frame = len(frame_records) - 1
    if last_frame <= impact_frame:
        return None
    for frame_idx in range(max(impact_frame + 1, 1), last_frame - min_break_frames + 2):
        window = frame_records[frame_idx: frame_idx + min_break_frames]
        if len(window) < min_break_frames:
            break
        if all(record and not record.get("posture_ok", False) for record in window):
            return frame_idx
    return None


def _resolve_shot_window(
    shot,
    frame_records,
    total_frames,
    fps,
    pre_roll_sec,
    post_roll_sec,
    setup_min_frames,
    setup_confidence_min,
    posture_break_grace_sec,
):
    event_frame = shot.get("impact_frame")
    vision_anchor_frame = shot.get("vision_anchor_frame")
    event_sec = shot.get("event_sec")
    if event_sec is None and event_frame is not None:
        event_sec = event_frame / fps
    event_sec = float(event_sec or 0.0)
    fallback_start = max(0.0, event_sec - pre_roll_sec)
    fallback_end = min(total_frames / fps, event_sec + post_roll_sec)
    total_duration_sec = total_frames / fps

    if shot.get("shot_type") != "SWING":
        return fallback_start, fallback_end, "event"

    anchor_frame = vision_anchor_frame if vision_anchor_frame is not None else None
    if anchor_frame is not None:
        anchor_sec = anchor_frame / fps
        start_sec = max(0.0, anchor_sec - pre_roll_sec)
        end_sec = min(total_duration_sec, anchor_sec + post_roll_sec)
        if end_sec <= start_sec + 0.1:
            return fallback_start, fallback_end, "event"
        return start_sec, end_sec, "vision"

    setup_span = shot.get("setup_span")
    if not setup_span or event_frame is None:
        return fallback_start, fallback_end, "event"
    if setup_span.get("frame_count", 0) < setup_min_frames:
        return fallback_start, fallback_end, "event"
    if setup_span.get("avg_confidence", 0.0) < setup_confidence_min:
        return fallback_start, fallback_end, "event"

    start_sec = max(0.0, (setup_span["start_frame"] - 1) / fps)
    end_sec = min(total_duration_sec, event_sec + post_roll_sec)
    if end_sec <= start_sec + 0.1:
        return fallback_start, fallback_end, "event"
    return start_sec, end_sec, "setup"


def _revalidate_pending_shot(shot, frame_records, fps):
    resolved = shot.copy()
    if resolved.get("shot_type") != "SWING":
        return resolved

    anchor_frame = (
        resolved.get("selection_anchor_frame")
        if resolved.get("selection_anchor_frame") is not None
        else resolved.get("vision_anchor_frame")
        if resolved.get("vision_anchor_frame") is not None
        else resolved.get("impact_frame")
    )
    if anchor_frame is None or anchor_frame <= 0 or anchor_frame >= len(frame_records):
        return resolved

    def _angle_at(idx):
        if idx <= 0 or idx >= len(frame_records):
            return None
        record = frame_records[idx]
        if not record:
            return None
        angle = record.get("spine_angle")
        return angle if angle is not None and angle > 0.0 else None

    def _setup_aligned(setup_span, anchor_idx):
        if not setup_span:
            return False
        end_frame = setup_span.get("end_frame")
        if end_frame is None:
            return False
        return (
            setup_span.get("frame_count", 0) >= 10
            and setup_span.get("avg_confidence", setup_span.get("confidence", 0.0)) >= 0.60
            and anchor_idx <= end_frame + max(18, int(round(1.25 * max(fps, 1.0))))
        )

    pre_window_frames = max(8, int(round(1.25 * max(fps, 1.0))))
    post_window_frames = max(10, int(round(2.0 * max(fps, 1.0))))
    immediate_post_frames = max(4, int(round(1.0 * max(fps, 1.0))))

    anchor_angle = _angle_at(anchor_frame)
    pre_angles = [
        angle for angle in (
            _angle_at(idx) for idx in range(max(1, anchor_frame - pre_window_frames), anchor_frame + 1)
        )
        if angle is not None
    ]
    in_range_pre = [angle for angle in pre_angles if 15.0 <= angle <= 60.0]
    if in_range_pre:
        spine_median = float(np.median(in_range_pre))
    elif anchor_angle is not None:
        spine_median = float(anchor_angle)
    elif pre_angles:
        spine_median = float(np.median(pre_angles))
    else:
        spine_median = 0.0

    stable_fraction = 0.0
    spine_instability = 99.0
    if pre_angles:
        deviations = [abs(angle - spine_median) for angle in pre_angles]
        stable_fraction = sum(dev <= 10.0 for dev in deviations) / len(deviations)
        spine_instability = max(deviations)

    green_spine_run = 0
    stable_pre_anchor_run = 0
    if spine_median > 0.0:
        for idx in range(anchor_frame, 0, -1):
            angle = _angle_at(idx)
            if angle is None or angle > 60.0 or angle < 15.0 or abs(angle - spine_median) > 10.0:
                break
            green_spine_run += 1
        for idx in range(anchor_frame, 0, -1):
            angle = _angle_at(idx)
            if angle is None or angle > 60.0 or angle < 15.0 or abs(angle - spine_median) > 10.0:
                break
            stable_pre_anchor_run += 1

    post_angles = [
        angle for angle in (
            _angle_at(idx) for idx in range(anchor_frame + 1, min(len(frame_records), anchor_frame + 1 + post_window_frames))
        )
        if angle is not None
    ]
    immediate_post_angles = [
        angle for angle in (
            _angle_at(idx) for idx in range(anchor_frame + 1, min(len(frame_records), anchor_frame + 1 + immediate_post_frames))
        )
        if angle is not None
    ]
    post_anchor_break_count = 0
    post_anchor_stable_fraction = 1.0
    post_anchor_break = False
    immediate_post_break = False
    trailing_frames_available = max(0, len(frame_records) - anchor_frame - 1)
    if post_angles:
        post_anchor_break_count = sum(angle > 60.0 for angle in post_angles)
        post_deviations = [abs(angle - spine_median) for angle in post_angles]
        post_anchor_stable_fraction = sum(dev <= 10.0 for dev in post_deviations) / len(post_deviations)
        post_anchor_break = post_anchor_break_count > 0
    if immediate_post_angles:
        immediate_post_break = any(angle > 60.0 for angle in immediate_post_angles)
    incomplete_trailing_context = trailing_frames_available < max(6, int(round(1.0 * max(fps, 1.0))))

    anchor_spine_valid = anchor_angle is not None and 15.0 <= anchor_angle <= 60.0
    fallback_spine_ok = anchor_angle is None or anchor_angle <= 60.0
    posture_backed = (
        anchor_spine_valid
        and stable_pre_anchor_run >= max(6, int(round(0.75 * max(fps, 1.0))))
        and green_spine_run >= max(4, int(round(0.40 * max(fps, 1.0))))
        and stable_fraction >= 0.75
    )
    computed_setup_aligned = _setup_aligned(resolved.get("setup_span"), anchor_frame)
    setup_aligned = bool(resolved.get("setup_aligned")) or computed_setup_aligned or posture_backed
    setup_gap_frames = None
    setup_gap_penalty = 0.0
    setup_span = resolved.get("setup_span") or {}
    setup_end_frame = setup_span.get("end_frame")
    if setup_end_frame is not None:
        setup_gap_frames = max(0, anchor_frame - setup_end_frame)
        gap_sec = setup_gap_frames / max(fps, 1.0)
        if gap_sec > 2.0:
            setup_gap_penalty = min(4.5, 0.28 * ((gap_sec - 2.0) ** 2))
    if posture_backed:
        setup_gap_penalty *= 0.15

    if setup_aligned and anchor_spine_valid and stable_pre_anchor_run >= 8 and stable_fraction >= 0.85 and not immediate_post_break:
        validation_tier = 0
    elif setup_aligned and anchor_spine_valid and stable_pre_anchor_run >= 5 and stable_fraction >= 0.75 and not immediate_post_break:
        validation_tier = 1
    elif posture_backed and anchor_spine_valid and stable_pre_anchor_run >= 8 and stable_fraction >= 0.75:
        validation_tier = 2
    elif anchor_spine_valid and stable_pre_anchor_run >= 5 and stable_fraction >= 0.75 and not immediate_post_break:
        validation_tier = 2
    elif fallback_spine_ok and stable_fraction >= 0.50 and not immediate_post_break and not post_anchor_break:
        validation_tier = 3
    else:
        validation_tier = 4

    selection_score = float(resolved.get("selection_score", 0.0) or 0.0)
    selection_score += min(1.35, 0.07 * stable_pre_anchor_run)
    selection_score += min(0.75, 0.04 * green_spine_run)
    selection_score += 0.45 * stable_fraction
    selection_score -= setup_gap_penalty
    if setup_aligned and stable_pre_anchor_run >= 12:
        selection_score += 1.10
    elif setup_aligned and stable_pre_anchor_run >= 6:
        selection_score += 0.75
    elif setup_aligned and stable_pre_anchor_run >= 4:
        selection_score += 0.40
    if anchor_angle is not None and anchor_angle > 60.0:
        selection_score = min(selection_score, 0.01)
    elif anchor_angle is not None and anchor_angle < 15.0 and not setup_aligned:
        selection_score = min(selection_score, 0.08)
    elif immediate_post_break:
        selection_score = min(selection_score, 0.35 if posture_backed else 0.02)
    elif post_anchor_break:
        selection_score = min(selection_score, 0.45 if posture_backed else 0.06)
    elif incomplete_trailing_context and resolved.get("confirm_tag") in {"vision", "audio"}:
        selection_score = min(selection_score, 0.18)

    if resolved.get("weak_ball_only_anchor"):
        selection_score = min(selection_score, 0.05)
        validation_tier = 4
        setup_aligned = False
        green_spine_run = 0
        stable_pre_anchor_run = 0
        post_anchor_break = True

    resolved["selection_score"] = selection_score
    if incomplete_trailing_context and resolved.get("confirm_tag") in {"vision", "audio"}:
        validation_tier = max(validation_tier, 4)
    resolved["anchor_validation_tier"] = validation_tier
    resolved["setup_aligned"] = setup_aligned
    resolved["setup_gap_frames"] = setup_gap_frames
    resolved["setup_gap_penalty"] = setup_gap_penalty
    resolved["posture_backed"] = posture_backed
    resolved["green_spine_run"] = green_spine_run
    resolved["stable_pre_anchor_run"] = stable_pre_anchor_run
    resolved["anchor_spine_angle"] = anchor_angle
    resolved["spine_stable_fraction"] = stable_fraction
    resolved["post_anchor_break"] = post_anchor_break
    resolved["post_anchor_break_count"] = post_anchor_break_count
    resolved["post_anchor_stable_fraction"] = post_anchor_stable_fraction
    resolved["immediate_post_break"] = immediate_post_break
    resolved["incomplete_trailing_context"] = incomplete_trailing_context
    return resolved


def _select_primary_shot(resolved_shots):
    if not resolved_shots:
        return []

    def anchor_frame(shot):
        return (
            shot.get("selection_anchor_frame")
            if shot.get("selection_anchor_frame") is not None
            else shot.get("vision_anchor_frame")
            if shot.get("vision_anchor_frame") is not None
            else shot.get("impact_frame")
            if shot.get("impact_frame") is not None
            else 10 ** 9
        )

    def confirm_priority(shot):
        return {
            "ball+audio": 5,
            "ball": 4,
            "vision+audio": 3,
            "vision": 2,
            "audio": 1,
        }.get(shot.get("confirm_tag"), 0)

    def has_valid_setup(shot):
        if shot.get("setup_aligned") is not None:
            return bool(shot.get("setup_aligned"))
        if shot.get("posture_backed") is not None:
            return bool(shot.get("posture_backed"))
        setup = shot.get("setup_span") or {}
        anchor_frame = (
            shot.get("selection_anchor_frame")
            if shot.get("selection_anchor_frame") is not None
            else shot.get("vision_anchor_frame")
            if shot.get("vision_anchor_frame") is not None
            else shot.get("impact_frame")
        )
        end_frame = setup.get("end_frame")
        close_to_setup = (
            anchor_frame is not None
            and end_frame is not None
            and anchor_frame <= end_frame + 24
        )
        return (
            setup.get("frame_count", 0) >= 10
            and setup.get("avg_confidence", setup.get("confidence", 0.0)) >= 0.60
            and close_to_setup
        )

    def shot_validation_tier(shot):
        return int(shot.get("anchor_validation_tier", 3))

    candidate_pool = list(resolved_shots)
    best_overall_score = max((shot.get("selection_score", 0.0) for shot in candidate_pool), default=0.0)
    preferred_setup_pool = [
        shot for shot in candidate_pool
        if has_valid_setup(shot)
        and shot_validation_tier(shot) <= 2
        and not shot.get("immediate_post_break", False)
    ]
    if preferred_setup_pool:
        best_setup_score = max(shot.get("selection_score", 0.0) for shot in preferred_setup_pool)
        if best_setup_score >= best_overall_score * 0.55:
            candidate_pool = preferred_setup_pool
    valid_posture_pool = [
        shot for shot in candidate_pool
        if not shot.get("immediate_post_break", False)
        and not shot.get("weak_ball_only_anchor", False)
    ]
    if valid_posture_pool:
        candidate_pool = valid_posture_pool
    highest_priority = max((confirm_priority(shot) for shot in candidate_pool), default=0)
    if highest_priority >= 3:
        strict_top_priority_pool = [
            shot for shot in candidate_pool
            if confirm_priority(shot) == highest_priority
            and shot_validation_tier(shot) <= 2
            and shot.get("selection_score", 0.0) >= 0.10
        ]
        if strict_top_priority_pool:
            candidate_pool = strict_top_priority_pool
        top_priority_pool = [
            shot for shot in candidate_pool
            if confirm_priority(shot) == highest_priority
            and shot.get("selection_score", 0.0) >= 0.15
        ]
        if top_priority_pool:
            candidate_pool = top_priority_pool
    preferred_audio = [
        shot for shot in candidate_pool
        if confirm_priority(shot) >= 3
        and shot_validation_tier(shot) <= 2
        and not shot.get("post_anchor_break", False)
    ]
    if preferred_audio:
        candidate_pool = preferred_audio
    audio_backed = [
        shot for shot in candidate_pool
        if confirm_priority(shot) >= 3
        and not shot.get("post_anchor_break", False)
    ]
    if audio_backed:
        filtered_pool = [
            shot for shot in candidate_pool
            if not (
                shot.get("confirm_tag") in {"vision", "audio"}
                and shot.get("incomplete_trailing_context", False)
            )
        ]
        if filtered_pool:
            candidate_pool = filtered_pool
    best_score = max(shot.get("selection_score", 0.0) for shot in candidate_pool)
    setup_backed = [
        shot for shot in candidate_pool
        if has_valid_setup(shot)
        and shot_validation_tier(shot) <= 3
        and not shot.get("immediate_post_break", False)
    ]
    if setup_backed:
        best_setup_score = max(shot.get("selection_score", 0.0) for shot in setup_backed)
        if best_setup_score >= best_score * 0.70:
            candidate_pool = setup_backed
            best_score = best_setup_score

    tier_margins = {
        0: 0.45,
        1: 0.58,
        2: 0.88,
        3: 0.94,
        4: 1.00,
    }
    for tier in (0, 1, 2, 3, 4):
        tier_candidates = [shot for shot in candidate_pool if shot_validation_tier(shot) == tier]
        if not tier_candidates:
            continue
        tier_best_score = max(shot.get("selection_score", 0.0) for shot in tier_candidates)
        if tier_best_score >= best_score * tier_margins[tier]:
            candidate_pool = tier_candidates
            best_score = tier_best_score
            break

    best_score = max(shot.get("selection_score", 0.0) for shot in candidate_pool)
    tied = [
        shot for shot in candidate_pool
        if shot.get("selection_score", 0.0) >= best_score * 0.75
    ]
    tied.sort(
        key=lambda shot: (
            shot_validation_tier(shot),
            0 if has_valid_setup(shot) else 1,
            0 if not shot.get("immediate_post_break", False) else 1,
            0 if not shot.get("post_anchor_break", False) else 1,
            shot.get("setup_gap_frames", 10 ** 6) if shot.get("setup_gap_frames") is not None else 10 ** 6,
            -(1.25 if has_valid_setup(shot) else 0.0),
            -shot.get("stable_pre_anchor_run", 0),
            -shot.get("green_spine_run", 0),
            -shot.get("spine_stable_fraction", 0.0),
            -confirm_priority(shot),
            -shot.get("selection_score", 0.0),
            anchor_frame(shot),
        )
    )
    return tied[:1]


def _mux_audio(video_path, silent_video_path, output_path, start_sec, end_sec):
    """
    Combine the silent OpenCV-written video with the audio slice from the
    original source clip.  Re-encodes video to H.264 so the output is
    compatible regardless of the OpenCV fourcc used for the temp file.
    Container format (.mp4 / .mov) is determined by output_path's extension.
    """
    duration = end_sec - start_sec
    cmd = [
        "ffmpeg", "-y",
        "-i", str(silent_video_path),          # video track (OpenCV output)
        "-ss", str(start_sec),                 # seek source for audio
        "-t",  str(duration),
        "-i", str(video_path),                 # original (audio source)
        "-map", "0:v:0",                       # video from silent file
        "-map", "1:a:0?",                      # audio from original (? = optional)
        "-c:v", "libx264",                     # re-encode to H.264 (universally compatible)
        "-preset", "fast",
        "-crf", "18",
        "-c:a", "aac",
        "-shortest",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        shutil.copy2(str(silent_video_path), str(output_path))
        print(f"    [ffmpeg] audio mux failed, saved silent clip. "
              f"stderr: {result.stderr[-200:].decode(errors='replace')}")
    else:
        print(f"    [ffmpeg] audio muxed OK → {Path(output_path).name}")


def save_shot_clip(video_path, start_sec, end_sec, output_path, fps,
                   shot_type="SHOT"):
    """
    Save a trimmed clip matching the source container format, with original audio.
    output_path extension must already match the source clip extension —
    set by process_clip using clip_path.suffix.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened(): return
    fw, fh = int(cap.get(3)), int(cap.get(4))

    use_ffmpeg = _ffmpeg_available()

    # Temp file uses same extension as output so ffmpeg writes the right container
    out_ext = Path(output_path).suffix.lower()
    with tempfile.NamedTemporaryFile(suffix=out_ext, delete=False) as tf:
        tmp_path = tf.name

    try:
        fourcc = cv2.VideoWriter_fourcc(*FOURCC_FOR_EXT.get(out_ext, "mp4v"))
        writer = cv2.VideoWriter(tmp_path, fourcc, fps, (fw, fh))
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(max(0, start_sec * fps)))
        max_f, count = int((end_sec - start_sec) * fps) + 1, 0
        while count < max_f:
            ret, frame = cap.read()
            if not ret: break
            writer.write(frame)
            count += 1
        writer.release()
        cap.release()

        if use_ffmpeg:
            _mux_audio(video_path, tmp_path, output_path, start_sec, end_sec)
        else:
            shutil.copy2(tmp_path, str(output_path))
            print(f"    [ffmpeg] not found — saved without audio")

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    duration_str = f"{count / fps:.1f}s" if fps else "?s"
    audio_tag    = "audio+video" if use_ffmpeg else "video only"
    print(f"  Saved: {Path(output_path).name}  "
          f"({duration_str})  [{shot_type}]  [{audio_tag}]")


def copy_clip_with_audio(src_path, output_path):
    """
    Copy the entire source clip to output_path preserving the original
    container and codec via ffmpeg stream-copy (no re-encode, no quality loss).
    Falls back to a plain file copy if ffmpeg is unavailable.
    """
    use_ffmpeg = _ffmpeg_available()
    if use_ffmpeg:
        cmd = [
            "ffmpeg", "-y",
            "-i", str(src_path),
            "-c", "copy",          # stream-copy: no re-encode, no quality loss
            str(output_path),
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            shutil.copy2(str(src_path), str(output_path))
            print(f"    [ffmpeg] copy failed, used plain copy. "
                  f"stderr: {result.stderr[-200:].decode(errors='replace')}")
        else:
            print(f"    [ffmpeg] stream-copied → {Path(output_path).name}")
    else:
        shutil.copy2(str(src_path), str(output_path))
        print(f"    [copy] {Path(output_path).name}")


# ════════════════════════════════════════════════════════════════
# Core Detection
# ════════════════════════════════════════════════════════════════

def process_clip(
    clip_path, pose_model, ball_model, output_dir, clip_index,
    ball_confidence=0.15,
    setup_frames=20, setup_ankle_max=50.0, feet_gap_max_px=50.0, setup_ball_max=4.0,
    spine_lean_min=15.0, spine_lean_max=60.0,
    swing_window=25,
    wrist_swing_threshold=50.0, wrist_putt_threshold=10.0,
    wrist_speed_swing_threshold=13.0,
    shoulder_swing_threshold=8.0, hip_swing_threshold=5.0,
    ball_move_threshold=8.0, putt_ball_move_threshold=4.5,
    putt_confirm_frames=2, save_putts=False, max_shots_per_clip=1, ball_wait_frames=360,
    max_disappear_frames=15, ema_alpha=0.5,
    pre_roll_sec=3.0, post_roll_sec=2.0,
    clips_dir=None,
    audio_min_strength="weak",
    audio_overlay_sec=1.5,
    audio_impact_window_sec=0.75,
    audio_transient_min_score=0.65,
    audio_wind_reject_max_duration=0.12,
    vision_fallback_enabled=True,
    vision_wrist_confirm_threshold=65.0,
    vision_torso_confirm_threshold=12.0,
    vision_followthrough_frames=6,
    vision_setup_min_frames=20,
    vision_setup_confidence_min=0.75,
    vision_posture_break_grace_sec=3.0,
    display=False, save_annotated=True, verbose=True,
    device="cpu", inference_imgsz=640, frame_stride=1,
):
    cap = cv2.VideoCapture(str(clip_path))
    if not cap.isOpened():
        print(f"[ShotDetector] Cannot open: {clip_path}")
        return 0

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps          = cap.get(cv2.CAP_PROP_FPS) or 30
    clip_name    = Path(clip_path).stem
    # ── Preserve original extension so all outputs stay consistent ──
    src_ext      = Path(clip_path).suffix.lower()   # e.g. ".mov" or ".mp4"
    fw, fh       = int(cap.get(3)), int(cap.get(4))

    print(f"\n[ShotDetector] {clip_name}  "
          f"({total_frames} frames @ {fps:.1f}fps  ~{total_frames/fps:.1f}s)  "
          f"[{src_ext.upper()}]")

    sm = ShotStateMachine(
        fps=fps,
        setup_frames=setup_frames, setup_ankle_max=setup_ankle_max,
        feet_gap_max_px=feet_gap_max_px,
        setup_ball_max=setup_ball_max,
        spine_lean_min=spine_lean_min, spine_lean_max=spine_lean_max,
        swing_window=swing_window,
        wrist_swing_threshold=wrist_swing_threshold,
        wrist_putt_threshold=wrist_putt_threshold,
        wrist_speed_swing_threshold=wrist_speed_swing_threshold,
        shoulder_swing_threshold=shoulder_swing_threshold,
        hip_swing_threshold=hip_swing_threshold,
        ball_move_threshold=ball_move_threshold,
        putt_ball_move_threshold=putt_ball_move_threshold,
        putt_confirm_frames=putt_confirm_frames,
        save_putts=save_putts,
        max_shots_per_clip=max_shots_per_clip,
        ball_wait_frames=ball_wait_frames,
        max_disappear_frames=max_disappear_frames,
        verbose=verbose,
    )
    smoother = SkeletonSmoother(alpha=ema_alpha)

    audio = AudioValidator(
        clips_dir=clips_dir if clips_dir else Path(clip_path).parent,
        clip_name=Path(clip_path).name,
        audio_tolerance_sec=audio_impact_window_sec,
        min_strength=audio_min_strength,
        min_transient_score=audio_transient_min_score,
        max_duration_sec=audio_wind_reject_max_duration,
    )

    ann_writer = None
    if save_annotated:
        ann_path   = output_dir / f"clip{clip_index:03d}_{clip_name}_annotated{src_ext}"
        ann_writer = cv2.VideoWriter(
            str(ann_path),
            cv2.VideoWriter_fourcc(*FOURCC_FOR_EXT.get(src_ext, "mp4v")),
            fps, (fw, fh))
        print(f"  Annotated: {ann_path.name}")

    pending_shots = []
    putt_full_clip = False  # set True when PuttVeto detects a putt and save_putts is on
    frame_records = [None]
    setup_spans = []
    active_setup_span = None
    active_swing = None
    frame_idx = 0
    prev_state = ShotStateMachine.IDLE
    fps_timer = time.time()
    fps_display = 0.0
    last_audio_info = None
    audio_info_until_frame = -1

    def hold_audio_info(frame_no, info):
        nonlocal last_audio_info, audio_info_until_frame
        last_audio_info = info
        audio_info_until_frame = frame_no + max(1, int(audio_overlay_sec * fps))

    def finalize_swing_fallback(frame_no, swing_ctx, swing_entry_frame, shot_type, reason):
        nonlocal putt_full_clip
        saved_timeout_shot = False
        motion_faded = reason == "motion-faded"
        min_motion_fade_vision_score = 1.35
        effective_shot_type = shot_type
        vision_swing_ctx = swing_ctx

        if (
            shot_type != "SWING"
            and swing_ctx
            and not save_putts
            and audio.enabled
            and not _swing_context_looks_like_putt(
                swing_ctx,
                ball_move_dist=getattr(sm, "last_ball_move_dist", None),
            )
        ):
            metrics = swing_ctx.get("metrics", [])
            max_wrist = max((metric.get("wrist_motion", 0.0) for metric in metrics), default=0.0)
            max_speed = max((metric.get("wrist_speed", 0.0) for metric in metrics), default=0.0)
            max_elbow = max((metric.get("elbow_motion", 0.0) for metric in metrics), default=0.0)
            max_shoulder = max((metric.get("shoulder_change", 0.0) for metric in metrics), default=0.0)
            max_hip = max((metric.get("hip_change", 0.0) for metric in metrics), default=0.0)
            audio_hit, reclass_audio = audio.check_window(swing_entry_frame, frame_no, fps)
            strong_reclass_burst = (
                max_wrist >= wrist_swing_threshold * 0.95
                and (
                    max_speed >= wrist_speed_swing_threshold * 0.70
                    or max_elbow >= wrist_swing_threshold * 0.65
                    or max_shoulder >= shoulder_swing_threshold * 1.35
                    or max_hip >= hip_swing_threshold * 1.60
                )
            )
            if audio_hit and strong_reclass_burst:
                effective_shot_type = "SWING"
                if swing_ctx:
                    vision_swing_ctx = swing_ctx.copy()
                    vision_swing_ctx["shot_type"] = "SWING"
                hold_audio_info(frame_no, reclass_audio)
                print(
                    f"    [Promote f{frame_no}] Reclassified {shot_type} window as SWING "
                    f"(audio + burst support)"
                )

        if (vision_fallback_enabled and effective_shot_type == "SWING" and vision_swing_ctx):
            if motion_faded:
                metrics = vision_swing_ctx.get("metrics", [])
                scene_peak = max((metric.get("scene_putt_score", 0.0) for metric in metrics), default=0.0)
                pose_heights = [
                    metric.get("scene_pose_height_ratio")
                    for metric in metrics
                    if metric.get("scene_pose_height_ratio") is not None
                ]
                pose_height = min(pose_heights) if pose_heights else None
                if scene_peak >= 0.90 and (pose_height is None or pose_height <= 0.24):
                    if save_putts:
                        print(f"    [PuttVeto f{frame_no}] Strong putt-like scene on faded vision fallback — will save full clip")
                        putt_full_clip = True
                    else:
                        print(f"    [PuttVeto f{frame_no}] Strong putt-like scene on faded vision fallback — leaving clip unchanged")
                    return False
            if _swing_context_looks_like_putt(
                vision_swing_ctx,
                ball_move_dist=getattr(sm, "last_ball_move_dist", None),
            ):
                if save_putts:
                    print(f"    [PuttVeto f{frame_no}] Reclassified swing-like motion as PUTT — will save full clip")
                    putt_full_clip = True
                else:
                    print(f"    [PuttVeto f{frame_no}] Reclassified swing-like motion as PUTT — leaving clip unchanged")
                return False
            metrics = vision_swing_ctx.get("metrics", [])
            scene_peak = max((metric.get("scene_putt_score", 0.0) for metric in metrics), default=0.0)
            pose_heights = [
                metric.get("scene_pose_height_ratio")
                for metric in metrics
                if metric.get("scene_pose_height_ratio") is not None
            ]
            pose_height = min(pose_heights) if pose_heights else None
            setup_span = vision_swing_ctx.get("setup_span") or {}
            vision_candidate = (
                vision_swing_ctx.get("confirmed_candidate")
                or _evaluate_vision_candidate(
                    vision_swing_ctx,
                    wrist_swing_threshold,
                    vision_torso_confirm_threshold,
                    vision_followthrough_frames,
                    vision_setup_min_frames,
                    vision_setup_confidence_min,
                    fps,
                )
            )
            if vision_candidate:
                weak_far_green_scene = (
                    scene_peak >= 0.72
                    and pose_height is not None
                    and pose_height <= 0.18
                    and (
                        setup_span.get("frame_count", 0) < 10
                        or setup_span.get("avg_confidence", setup_span.get("confidence", 0.0)) < 0.60
                    )
                    and vision_candidate.get("validation_tier", 3) >= 3
                )
                if weak_far_green_scene:
                    if save_putts:
                        print(f"    [PuttVeto f{frame_no}] Far weak-setup green scene on vision fallback — will save full clip")
                        putt_full_clip = True
                    else:
                        print(f"    [PuttVeto f{frame_no}] Far weak-setup green scene on vision fallback — leaving clip unchanged")
                    return False
                audio_info = None
                if audio.enabled:
                    audio_start = max(
                        swing_entry_frame,
                        vision_candidate["impact_frame"] - max(1, int(0.12 * fps)),
                    )
                    audio_hit, audio_info = audio.check_window(
                        audio_start,
                        vision_candidate["impact_frame"],
                        fps,
                    )
                    if audio_hit:
                        hold_audio_info(frame_no, audio_info)
                # For motion-faded vision-only (no audio, no ball): require
                # a valid setup span to avoid false triggers on walking
                has_ball = vision_swing_ctx.get("ball_confirm_frame") is not None
                vision_setup = vision_candidate.get("setup_span") or {}
                has_setup = (
                    vision_setup.get("frame_count", 0) >= vision_setup_min_frames
                    and vision_setup.get("avg_confidence", vision_setup.get("confidence", 0.0)) >= 0.50
                )
                if motion_faded and not audio_info and not has_ball and not has_setup:
                    print(f"    [VisionReject f{frame_no}] Motion-faded vision-only without setup — skipped")
                elif (not motion_faded
                        or audio_info
                        or vision_candidate["score"] >= min_motion_fade_vision_score):
                    provisional_ball_only = (
                        vision_swing_ctx.get("ball_confirm_frame") is not None
                        and audio_info is None
                    )
                    weak_ball_only_anchor = (
                        provisional_ball_only
                        and (
                            motion_faded
                            or vision_candidate.get("validation_tier", 3) >= 3
                            or not vision_candidate.get("setup_aligned")
                            or vision_candidate.get("stable_pre_anchor_run", 0) < 4
                        )
                    )
                    confirm_tag = "vision+audio" if audio_info else "vision"
                    if vision_swing_ctx.get("ball_confirm_frame") is not None:
                        confirm_tag = "ball+audio" if audio_info else "ball"
                    impact_frame = vision_candidate["impact_frame"]
                    selection_score = vision_candidate.get("score", 0.0)
                    if weak_ball_only_anchor:
                        selection_score = min(selection_score, 0.05)
                    pending_shots.append({
                        "shot_type": "SWING",
                        "confirm_tag": confirm_tag,
                        "trail": list(sm.ball_trail),
                        "merged": False,
                        "event_sec": impact_frame / fps,
            "impact_frame": impact_frame,
            "vision_anchor_frame": impact_frame,
            "setup_span": vision_candidate.get("setup_span"),
            "selection_score": selection_score,
            "selection_anchor_frame": impact_frame,
            "weak_ball_only_anchor": weak_ball_only_anchor,
            "anchor_validation_tier": vision_candidate.get("validation_tier", 3),
            "setup_aligned": vision_candidate.get("setup_aligned"),
            "green_spine_run": vision_candidate.get("green_spine_run", 0),
                        "stable_pre_anchor_run": vision_candidate.get("stable_pre_anchor_run", 0),
                        "anchor_spine_angle": vision_candidate.get("anchor_spine_angle"),
                        "spine_stable_fraction": vision_candidate.get("spine_stable_fraction", 0.0),
                        "post_anchor_break": vision_candidate.get("post_anchor_break", False),
                        "ball_move_dist": getattr(sm, "last_ball_move_dist", None),
                    })
                    print(f"\n  ★ SWING detected at {format_time(impact_frame / fps)}  "
                          f"[{confirm_tag}]  "
                          f"(vision score {vision_candidate['score']:.2f}; {reason})")
                    saved_timeout_shot = True

        if (not saved_timeout_shot and shot_type != "SWING" and save_putts
                and audio.enabled and not motion_faded):
            audio_hit, audio_info = audio.check_window(swing_entry_frame, frame_no, fps)
            if audio_hit:
                hold_audio_info(frame_no, audio_info)
                impact_frame = int(round(audio_info["clip_time_sec"] * fps))
                pending_shots.append({
                    "shot_type": shot_type,
                    "confirm_tag": "audio",
                    "trail": list(sm.ball_trail),
                    "merged": False,
                    "event_sec": audio_info["clip_time_sec"],
                    "impact_frame": impact_frame,
                    "vision_anchor_frame": None,
                    "setup_span": swing_ctx.get("setup_span") if swing_ctx else None,
                    "selection_score": 0.0,
                    "selection_anchor_frame": impact_frame,
                    "weak_ball_only_anchor": False,
                    "ball_move_dist": getattr(sm, "last_ball_move_dist", None),
                })
                print(f"\n  ★ {shot_type} detected at {format_time(audio_info['clip_time_sec'])}  "
                      f"[audio]  "
                      f"(transient {audio_info.get('transient_score', 0.0):.2f}; {reason})")
                saved_timeout_shot = True

        if not saved_timeout_shot:
            print(f"    [Audio/Vision f{frame_no}] No confirmation in swing window — {reason}")

        return saved_timeout_shot

    _stride = max(1, int(frame_stride))
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1

        # Skip frames in fast mode — only run inference on every Nth frame
        if _stride > 1 and frame_idx % _stride != 1:
            continue

        if frame_idx % 30 == 0:
            elapsed     = time.time() - fps_timer
            fps_display = 30/elapsed if elapsed > 0 else 0
            fps_timer   = time.time()

        # ── Pose ──
        pose_res = pose_model.predict(
            source=frame, conf=0.4, verbose=False,
            device=device, imgsz=inference_imgsz)
        raw_kp = raw_cf = None
        if (pose_res[0].keypoints is not None
                and len(pose_res[0].keypoints) > 0):
            raw_kp = pose_res[0].keypoints[0].xy[0].cpu().numpy()
            raw_cf = pose_res[0].keypoints[0].conf[0].cpu().numpy()
        kp, cf = smoother.update(raw_kp, raw_cf)

        # ── Putt scene ──
        scene_info = _estimate_putt_scene(frame, kp, cf, min_conf=0.25)
        sm.scene_putt_score = scene_info["score"]
        sm.scene_putt_peak = max(sm.scene_putt_peak * 0.995, scene_info["score"])
        sm.scene_green_ratio = scene_info["green_ratio"]
        sm.scene_pose_height_ratio = scene_info["pose_height_ratio"]
        sm.scene_texture_laplacian = scene_info["laplacian_var"]

        # ── Ball (always run at native resolution for small-object accuracy) ──
        ball_pos  = None
        ball_conf = None
        ball_candidates = []
        if True:
            ball_res = ball_model.predict(
                source=frame, conf=ball_confidence, verbose=False,
                device=device)
            if ball_res[0].boxes:
                boxes = ball_res[0].boxes.xyxy.cpu().numpy()
                confs = ball_res[0].boxes.conf.cpu().numpy()
                for box, conf in zip(boxes, confs):
                    center = get_center(np.asarray(box, dtype=int))
                    ball_candidates.append((float(conf), center))
                ball_conf, ball_pos = _select_ball_candidate(
                    ball_candidates,
                    kp,
                    cf,
                    previous_ball=sm.last_known_ball_pos,
                )

        # ── State machine ──
        prev_state = sm.state
        new_state = sm.update(frame_idx, kp, cf, ball_pos)
        resolved_ball = sm.last_known_ball_pos if ball_pos is None else ball_pos
        if active_swing and sm.shot_type and active_swing.get("shot_type") != sm.shot_type:
            active_swing["shot_type"] = sm.shot_type
        current_scores = sm.swing_scores or {}
        current_arm_score = _compute_arm_swing_score(
            current_scores,
            wrist_swing_threshold,
            wrist_speed_swing_threshold,
            shoulder_swing_threshold,
            hip_swing_threshold,
        )

        ball_anchor = resolved_ball is not None or sm.setup_progress >= 0.5
        setup_confidence = _setup_confidence(sm, ball_anchor)
        posture_ok = sm.feet_stable and sm.spine_in_range
        frame_records.append({
            "frame_idx": frame_idx,
            "feet_stable": sm.feet_stable,
            "spine_in_range": sm.spine_in_range,
            "spine_angle": sm.last_spine_angle,
            "setup_confidence": setup_confidence,
            "posture_ok": posture_ok,
            "state": new_state,
        })

        just_closed_setup_span = None
        if new_state in (ShotStateMachine.IDLE, ShotStateMachine.SETUP) and posture_ok and ball_anchor:
            if active_setup_span is None:
                active_setup_span = {
                    "start_frame": frame_idx,
                    "end_frame": frame_idx,
                    "frame_count": 1,
                    "confidence_sum": setup_confidence,
                }
            else:
                active_setup_span["end_frame"] = frame_idx
                active_setup_span["frame_count"] += 1
                active_setup_span["confidence_sum"] += setup_confidence
        else:
            just_closed_setup_span = _finalize_setup_span(active_setup_span)
            if just_closed_setup_span:
                setup_spans.append(just_closed_setup_span)
            active_setup_span = None

        if prev_state != ShotStateMachine.SWING and new_state == ShotStateMachine.SWING:
            bound_setup = (just_closed_setup_span.copy() if just_closed_setup_span
                           else _select_setup_span(setup_spans, sm.swing_entry_frame or frame_idx))
            active_swing = {
                "entry_frame": sm.swing_entry_frame or frame_idx,
                "shot_type": sm.shot_type or "SWING",
                "setup_span": bound_setup.copy() if bound_setup else None,
                "metrics": [],
                "best_raw_candidate": None,
                "confirmed_candidate": None,
                "ball_confirm_frame": None,
                "ball_confirm_dist": None,
            }
            if active_swing.get("shot_type") == "SWING":
                entry_metric = {
                    "frame_idx": frame_idx,
                    "wrist_motion": current_scores.get("wrist_motion", 0.0),
                    "shoulder_change": current_scores.get("shoulder_change", 0.0),
                    "hip_change": current_scores.get("hip_change", 0.0),
                    "elbow_motion": current_scores.get("elbow_motion", 0.0),
                    "wrist_speed": current_scores.get("wrist_speed", 0.0),
                    "feet_stable": sm.feet_stable,
                    "ankle_gap_px": sm.last_ankle_gap,
                    "spine_in_range": sm.spine_in_range,
                    "spine_angle": sm.last_spine_angle,
                }
                if vision_fallback_enabled:
                    entry_metric["arm_swing_score"] = _compute_vision_score(
                        current_scores,
                        wrist_swing_threshold,
                        vision_torso_confirm_threshold,
                    )
                else:
                    entry_metric["arm_swing_score"] = 0.0
                entry_metric["vision_score"] = entry_metric["arm_swing_score"]
                entry_metric["scene_putt_score"] = sm.scene_putt_score
                entry_metric["scene_green_ratio"] = sm.scene_green_ratio
                entry_metric["scene_pose_height_ratio"] = sm.scene_pose_height_ratio
                active_swing["metrics"].append(entry_metric)
                active_swing["ball_trail"] = list(sm.ball_trail)
                if entry_metric["wrist_motion"] >= wrist_swing_threshold:
                    active_swing["best_raw_candidate"] = {
                        "frame_idx": frame_idx,
                        "vision_score": entry_metric["wrist_motion"],
                        "threshold": wrist_swing_threshold,
                    }

        current_vision_score = 0.0
        if active_swing and prev_state == ShotStateMachine.SWING:
            _, live_scores = sm._score_swing()
            if live_scores:
                sm.swing_scores = live_scores
            metric = {
                "frame_idx": frame_idx,
                "wrist_motion": live_scores.get("wrist_motion", 0.0),
                "shoulder_change": live_scores.get("shoulder_change", 0.0),
                "hip_change": live_scores.get("hip_change", 0.0),
                "elbow_motion": live_scores.get("elbow_motion", 0.0),
                "wrist_speed": live_scores.get("wrist_speed", 0.0),
                "feet_stable": sm.feet_stable,
                "ankle_gap_px": sm.last_ankle_gap,
                "spine_in_range": sm.spine_in_range,
                "spine_angle": sm.last_spine_angle,
            }
            if vision_fallback_enabled and active_swing.get("shot_type") == "SWING":
                metric["arm_swing_score"] = _compute_vision_score(
                    live_scores,
                    vision_wrist_confirm_threshold,
                    vision_torso_confirm_threshold,
                )
            else:
                metric["arm_swing_score"] = 0.0
            metric["vision_score"] = metric["arm_swing_score"]
            metric["scene_putt_score"] = sm.scene_putt_score
            metric["scene_green_ratio"] = sm.scene_green_ratio
            metric["scene_pose_height_ratio"] = sm.scene_pose_height_ratio
            current_vision_score = metric["arm_swing_score"]
            active_swing["metrics"].append(metric)
            active_swing["ball_trail"] = list(sm.ball_trail)

            if (active_swing.get("shot_type") == "SWING"
                    and metric["wrist_motion"] >= wrist_swing_threshold):
                raw_candidate = active_swing.get("best_raw_candidate")
                raw_score = metric["wrist_motion"]
                if (raw_candidate is None
                        or raw_score > raw_candidate.get("vision_score", 0.0) * 1.07):
                    active_swing["best_raw_candidate"] = {
                        "frame_idx": frame_idx,
                        "vision_score": raw_score,
                        "threshold": wrist_swing_threshold,
                    }

            if (vision_fallback_enabled
                    and active_swing.get("shot_type") == "SWING"):
                active_swing["confirmed_candidate"] = _evaluate_vision_candidate(
                    active_swing,
                    wrist_swing_threshold,
                    vision_torso_confirm_threshold,
                    vision_followthrough_frames,
                    vision_setup_min_frames,
                    vision_setup_confidence_min,
                    fps,
                )

        # ── Resolve timeout / fade fallbacks in priority order ──
        if sm._swing_timed_out or sm._swing_faded_out:
            resolve_reason = "timeout" if sm._swing_timed_out else "motion-faded"
            sm._swing_timed_out = False
            sm._swing_faded_out = False
            swing_ctx = active_swing
            swing_entry_frame = 0
            shot_type = sm.shot_type or (swing_ctx.get("shot_type") if swing_ctx else None) or "SWING"
            if swing_ctx:
                swing_entry_frame = swing_ctx.get("entry_frame", 0) or 0
            elif sm.swing_entry_frame is not None:
                swing_entry_frame = sm.swing_entry_frame

            saved_timeout_shot = finalize_swing_fallback(
                frame_idx,
                swing_ctx,
                swing_entry_frame,
                shot_type,
                resolve_reason,
            )

            sm.state = ShotStateMachine.IDLE
            sm._reset()
            if saved_timeout_shot:
                sm.start_cooldown()
            active_swing = None

        # ── Collect ball-confirmed shots ──
        if sm.shot_detected:
            shot_type = sm.shot_type or (active_swing.get("shot_type") if active_swing else None) or "SHOT"
            ball_conf_shot = bool(getattr(sm, "_ball_confirmed", False))
            audio_info = None
            confirmed_candidate = None
            raw_candidate = None
            last_ball_move_dist = getattr(sm, "last_ball_move_dist", None)

            # ── Audio check BEFORE PuttVeto ──
            # If audio confirms the swing, PuttVeto should not override it.
            # Use a tight window around the ball movement frame (±1s) rather
            # than the full swing window, so distant audio can't falsely confirm.
            if shot_type == "SWING" and ball_conf_shot and audio.enabled and active_swing:
                audio_ball_window_sec = 1.0  # ±1s around ball movement
                ball_window_start = max(0, int(frame_idx - audio_ball_window_sec * fps))
                audio_hit, confirm_audio = audio.check_window(
                    ball_window_start,
                    frame_idx,
                    fps,
                )
                if audio_hit:
                    audio_info = confirm_audio
                    hold_audio_info(frame_idx, confirm_audio)
                    print(f"    [Audio f{frame_idx}] ALSO CONFIRMED  "
                          f"t={confirm_audio['timestamp_sec']:.2f}s  "
                          f"amp={confirm_audio['amplitude']:.3f}  "
                          f"strength={confirm_audio['strength']}  "
                          f"transient={confirm_audio.get('transient_score', 0.0):.2f}")

            # ── PuttVeto — skip if audio already confirmed this as a real swing ──
            if not audio_info:
                if (shot_type == "SWING"
                        and _live_scores_look_like_putt(
                            sm.swing_scores or {},
                            sm.scene_green_ratio,
                            sm.scene_putt_score,
                            ball_move_dist=last_ball_move_dist,
                        )):
                    if save_putts:
                        print(f"    [PuttVeto f{frame_idx}] Live motion + rolling ball looked like PUTT — will save full clip")
                        putt_full_clip = True
                    else:
                        print(f"    [PuttVeto f{frame_idx}] Live motion + rolling ball looked like PUTT — leaving clip unchanged")
                    sm._audio_confirmed = False
                    sm._audio_info = None
                    sm._ball_confirmed = False
                    sm.start_cooldown()
                    active_swing = None
                    continue

                if (shot_type == "SWING"
                        and active_swing
                        and _swing_context_looks_like_putt(
                            active_swing,
                            ball_move_dist=last_ball_move_dist,
                        )):
                    if save_putts:
                        print(f"    [PuttVeto f{frame_idx}] Reclassified swing-like motion as PUTT — will save full clip")
                        putt_full_clip = True
                    else:
                        print(f"    [PuttVeto f{frame_idx}] Reclassified swing-like motion as PUTT — leaving clip unchanged")
                    sm._audio_confirmed = False
                    sm._audio_info = None
                    sm._ball_confirmed = False
                    sm.start_cooldown()
                    active_swing = None
                    continue

            vision_anchor_frame = None
            if shot_type == "SWING" and active_swing:
                confirmed_candidate = active_swing.get("confirmed_candidate")
                raw_candidate = active_swing.get("best_raw_candidate")
                if confirmed_candidate:
                    vision_anchor_frame = confirmed_candidate["impact_frame"]
                elif raw_candidate:
                    vision_anchor_frame = raw_candidate["frame_idx"]
                else:
                    supportive_anchor = _find_supportive_anchor_metric(
                        active_swing,
                        wrist_swing_threshold,
                        vision_torso_confirm_threshold,
                    )
                    if supportive_anchor:
                        raw_candidate = {
                            "frame_idx": supportive_anchor["frame_idx"],
                            "vision_score": supportive_anchor["score"],
                            "threshold": wrist_swing_threshold,
                        }
                        vision_anchor_frame = supportive_anchor["frame_idx"]
                if vision_anchor_frame is None:
                    print(f"    [Vision f{frame_idx}] Ignored {shot_type.lower()} without a valid swing anchor")
                    sm._audio_confirmed = False
                    sm._audio_info = None
                    sm._ball_confirmed = False
                    sm.start_cooldown()
                    active_swing = None
                    continue

            provisional_ball_only = (
                shot_type == "SWING"
                and ball_conf_shot
                and audio_info is None
                and active_swing is not None
            )
            weak_ball_only_anchor = (
                provisional_ball_only
                and (
                    confirmed_candidate is None
                    or confirmed_candidate.get("validation_tier", 3) >= 3
                    or confirmed_candidate.get("stable_pre_anchor_run", 0) < 4
                )
            )
            if provisional_ball_only and active_swing:
                active_swing["ball_confirm_frame"] = frame_idx
                active_swing["ball_confirm_dist"] = last_ball_move_dist
                print(
                    f"    [BallHold f{frame_idx}] Provisional ball-only anchor "
                    f"(tier={confirmed_candidate.get('validation_tier', 3) if confirmed_candidate else 'raw'}) "
                    f"— continuing swing window"
                )
                sm.state = ShotStateMachine.SWING
                sm.shot_detected = False
                sm.shot_frame_idx = None
                sm._ball_confirmed = False
                sm._audio_confirmed = False
                sm._audio_info = None
                sm.last_ball_move_dist = None
                continue

            confirm_tag = "ball+audio" if (ball_conf_shot and audio_info) else "ball"
            selection_score = (
                confirmed_candidate.get("score", 0.0)
                if confirmed_candidate else
                raw_candidate.get("vision_score", 0.0) / max(wrist_swing_threshold, 1e-6)
                if raw_candidate else 0.0
            )
            anchor_validation_tier = (
                confirmed_candidate.get("validation_tier", 3)
                if confirmed_candidate else 3
            )
            setup_aligned = (
                confirmed_candidate.get("setup_aligned")
                if confirmed_candidate else None
            )
            green_spine_run = (
                confirmed_candidate.get("green_spine_run", 0)
                if confirmed_candidate else 0
            )
            stable_pre_anchor_run = (
                confirmed_candidate.get("stable_pre_anchor_run", 0)
                if confirmed_candidate else 0
            )
            anchor_spine_angle = (
                confirmed_candidate.get("anchor_spine_angle")
                if confirmed_candidate else None
            )
            spine_stable_fraction = (
                confirmed_candidate.get("spine_stable_fraction", 0.0)
                if confirmed_candidate else 0.0
            )
            post_anchor_break = (
                confirmed_candidate.get("post_anchor_break", False)
                if confirmed_candidate else False
            )
            if weak_ball_only_anchor:
                selection_score = min(selection_score, 0.05)
                anchor_validation_tier = 4
                setup_aligned = False
                green_spine_run = 0
                stable_pre_anchor_run = 0
                post_anchor_break = True
            pending_shots.append({
                "shot_type": shot_type,
                "confirm_tag": confirm_tag,
                "trail": list(sm.ball_trail),
                "merged": False,
                "event_sec": frame_idx / fps,
                "impact_frame": frame_idx,
                "vision_anchor_frame": vision_anchor_frame,
                "setup_span": active_swing.get("setup_span") if active_swing else None,
                "selection_score": selection_score,
                "selection_anchor_frame": vision_anchor_frame,
                "weak_ball_only_anchor": weak_ball_only_anchor,
                "anchor_validation_tier": anchor_validation_tier,
                "setup_aligned": setup_aligned,
                "green_spine_run": green_spine_run,
                "stable_pre_anchor_run": stable_pre_anchor_run,
                "anchor_spine_angle": anchor_spine_angle,
                "spine_stable_fraction": spine_stable_fraction,
                "post_anchor_break": post_anchor_break,
                "ball_move_dist": last_ball_move_dist,
            })
            print(f"\n  ★ {shot_type} detected at {format_time(frame_idx / fps)}  "
                  f"[{confirm_tag}]")
            sm._audio_confirmed = False
            sm._audio_info = None
            sm._ball_confirmed = False
            sm.start_cooldown()
            active_swing = None

        # ── Early exit after high-confidence shot ──
        if (max_shots_per_clip == 1
                and len(pending_shots) >= 1
                and sm.state == ShotStateMachine.IDLE):
            best_tag = pending_shots[-1].get("confirm_tag", "")
            # Only early-exit for strongest confirmation — weaker tags may be
            # superseded by a better detection later in the clip
            if best_tag == "ball+audio":
                last_event_sec = pending_shots[-1].get("event_sec", 0)
                current_sec = frame_idx / fps
                if current_sec >= last_event_sec + post_roll_sec + 0.5:
                    if verbose:
                        print(f"    [EarlyExit f{frame_idx}] {best_tag} confirmed + post-roll complete — skipping remaining frames")
                    break

        # ── Draw ──
        resolved = resolved_ball
        if display or save_annotated:
            draw_pose(frame, kp, cf, sm.state)
            draw_ball_trail(frame, list(sm.ball_trail))
            draw_spine_line(frame, sm)
            audio_sidebar_info = (last_audio_info
                                  if frame_idx <= audio_info_until_frame
                                  else None)
            setup_debug = {
                "active": active_setup_span is not None,
                "frames": active_setup_span["frame_count"] if active_setup_span
                          else (active_swing.get("setup_span", {}).get("frame_count", 0)
                                if active_swing and active_swing.get("setup_span") else 0),
                "confidence": (
                    active_setup_span["confidence_sum"] / max(1, active_setup_span["frame_count"])
                    if active_setup_span else
                    (active_swing.get("setup_span", {}).get("avg_confidence", 0.0)
                     if active_swing and active_swing.get("setup_span") else 0.0)
                ),
            }
            confirmed_candidate = active_swing.get("confirmed_candidate") if active_swing else None
            raw_candidate = active_swing.get("best_raw_candidate") if active_swing else None
            candidate_frame = None
            candidate_end_frame = None
            best_score = 0.0
            if confirmed_candidate:
                candidate_frame = confirmed_candidate["impact_frame"]
                candidate_end_frame = confirmed_candidate.get("candidate_end_frame", candidate_frame)
                best_score = confirmed_candidate.get("wrist_motion", confirmed_candidate.get("score", 0.0))
            elif raw_candidate:
                candidate_frame = raw_candidate["frame_idx"]
                candidate_end_frame = raw_candidate["frame_idx"]
                best_score = raw_candidate.get("vision_score", 0.0)
            vision_debug = {
                "enabled": bool(vision_fallback_enabled and active_swing
                                and active_swing.get("shot_type") == "SWING"),
                "current_score": current_scores.get("wrist_motion", 0.0),
                "best_score": best_score,
                "threshold": wrist_swing_threshold,
                "candidate_frame": candidate_frame,
                "in_window": bool(candidate_frame is not None
                                  and candidate_end_frame is not None
                                  and candidate_frame <= frame_idx <= candidate_end_frame),
                "shot_type": active_swing.get("shot_type") if active_swing else None,
            }
            frame = draw_sidebar(
                frame, sm, resolved, ball_conf,
                frame_idx, total_frames, fps_display,
                audio_enabled=audio.enabled,
                audio_info=audio_sidebar_info,
                setup_info=setup_debug,
                vision_info=vision_debug,
            )
            if ann_writer: ann_writer.write(frame)
            if display:
                cv2.imshow("Shot Detector", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    cap.release()
                    if ann_writer: ann_writer.release()
                    cv2.destroyAllWindows()
                    break

    cap.release()
    if ann_writer: ann_writer.release()

    final_setup_span = _finalize_setup_span(active_setup_span)
    if final_setup_span:
        setup_spans.append(final_setup_span)

    if active_swing and sm.state == ShotStateMachine.SWING:
        shot_type = sm.shot_type or active_swing.get("shot_type") or "SWING"
        swing_entry_frame = active_swing.get("entry_frame", 0) or 0
        saved_timeout_shot = finalize_swing_fallback(
            frame_idx,
            active_swing,
            swing_entry_frame,
            shot_type,
            "end-of-clip",
        )
        if saved_timeout_shot:
            sm.start_cooldown()
        sm.state = ShotStateMachine.IDLE
        sm._reset()
        active_swing = None

    resolved_shots = []
    for shot in pending_shots:
        revalidated_shot = _revalidate_pending_shot(shot, frame_records, fps)
        start_sec, end_sec, trim_source = _resolve_shot_window(
            revalidated_shot,
            frame_records,
            total_frames,
            fps,
            pre_roll_sec,
            post_roll_sec,
            vision_setup_min_frames,
            vision_setup_confidence_min,
            vision_posture_break_grace_sec,
        )
        resolved = revalidated_shot.copy()
        resolved["start_sec"] = start_sec
        resolved["end_sec"] = end_sec
        resolved["trim_source"] = trim_source
        resolved_shots.append(resolved)

    if verbose and resolved_shots:
        print("    [ResolvedShots]")
        for idx, shot in enumerate(resolved_shots, start=1):
            print(
                "      "
                f"{idx}. tag={shot.get('confirm_tag')} "
                f"anchor={shot.get('selection_anchor_frame') or shot.get('vision_anchor_frame') or shot.get('impact_frame')} "
                f"score={shot.get('selection_score', 0.0):.2f} "
                f"tier={shot.get('anchor_validation_tier', 3)} "
                f"setup={bool(shot.get('setup_aligned'))} "
                f"gap={shot.get('setup_gap_frames')} "
                f"pre={shot.get('stable_pre_anchor_run', 0)} "
                f"green={shot.get('green_spine_run', 0)} "
                f"post_break={shot.get('post_anchor_break', False)} "
                f"imm_break={shot.get('immediate_post_break', False)}"
            )

    # ── Limit to a single saved clip when requested, otherwise merge overlaps ──
    if max_shots_per_clip == 1:
        merged = _select_primary_shot(resolved_shots)
    else:
        merged = merge_shots(resolved_shots)
        if max_shots_per_clip > 0:
            merged = merged[:max_shots_per_clip]
    shot_idx = 0
    for shot in merged:
        shot_idx += 1
        merged_tag = "_merged" if shot.get("merged") and shot.get("confirm_tag") != "merged" else ""
        # Output extension matches source clip — consistent for merge script
        out_name   = (f"clip{clip_index:03d}_{clip_name}"
                      f"_{shot['shot_type'].lower()}{shot_idx:02d}"
                      f"_{shot['confirm_tag']}{merged_tag}{src_ext}")
        save_shot_clip(
            clip_path, shot["start_sec"], shot["end_sec"],
            output_dir / out_name, fps,
            shot_type=f"{shot['shot_type']} [{shot['confirm_tag']}]"
                      + (" MERGED" if shot.get("merged") else ""),
        )
        print(f"    [Trim] {shot['confirm_tag']} saved via {shot.get('trim_source', 'event')}-anchored window  "
              f"{shot['start_sec']:.2f}s → {shot['end_sec']:.2f}s")

    # ── Putt full-clip save ──
    # When putt is detected (via PuttVeto or normal SM putt path), save full
    # clip untrimmed — BUT only if there's no strong swing confirmation
    # (ball+audio or ball). A real swing takes priority over a putt.
    has_putt_detection = any(s.get("shot_type") == "PUTT" for s in pending_shots)
    has_strong_swing = any(
        s.get("shot_type") == "SWING" and s.get("confirm_tag") in ("ball+audio", "ball")
        for s in pending_shots
    )
    # A ball+audio swing with tiny ball movement shouldn't override a PuttVeto —
    # it's likely a putt roll that coincided with ambient audio.
    if putt_full_clip and has_strong_swing:
        max_swing_ball_dist = max(
            (s.get("ball_move_dist") or 0)
            for s in pending_shots
            if s.get("shot_type") == "SWING" and s.get("confirm_tag") in ("ball+audio", "ball")
        )
        if max_swing_ball_dist < 15.0:
            has_strong_swing = False
    if save_putts and (putt_full_clip or has_putt_detection) and not has_strong_swing:
        # Remove any trimmed clips already saved (putt full clip takes priority)
        for shot in merged:
            trimmed_name = (f"clip{clip_index:03d}_{clip_name}"
                           f"_{shot['shot_type'].lower()}01"
                           f"_{shot['confirm_tag']}{src_ext}")
            trimmed_path = output_dir / trimmed_name
            if trimmed_path.exists():
                trimmed_path.unlink()
        merged = []  # clear — we'll save full clip instead
        out_name = f"clip{clip_index:03d}_{clip_name}_putt{src_ext}"
        out_path = output_dir / out_name
        print(f"\n  ★ Putt detected in '{clip_name}' — saving full clip → {out_name}")
        copy_clip_with_audio(clip_path, out_path)
        merged = [{"shot_type": "PUTT", "confirm_tag": "putt_full"}]

    # ── No-detection fallback — preserve the whole clip as-is ──
    if not merged:
        # Extension matches source — no format mismatch for merge script
        out_name = f"clip{clip_index:03d}_{clip_name}_no_detection{src_ext}"
        out_path = output_dir / out_name
        print(f"\n  ⚠  No shots detected in '{clip_name}' — "
              f"saving full clip as-is → {out_name}")
        copy_clip_with_audio(clip_path, out_path)

    print(f"  Done — {len(merged)} shot(s) saved "
          f"(from {len(pending_shots)} detection(s)) in {clip_name}")
    return len(merged)


def _build_clip_kwargs(cfg, clips_dir, output_dir):
    """Build the keyword arguments dict for process_clip from config."""
    return dict(
        ball_confidence=cfg["ball_confidence"],
        setup_frames=cfg["setup_frames"],
        setup_ankle_max=cfg["setup_ankle_max"],
        feet_gap_max_px=cfg["feet_gap_max_px"],
        setup_ball_max=cfg["setup_ball_max"],
        spine_lean_min=cfg["spine_lean_min"],
        spine_lean_max=cfg["spine_lean_max"],
        swing_window=cfg["swing_window"],
        wrist_swing_threshold=cfg["wrist_swing_threshold"],
        wrist_putt_threshold=cfg["wrist_putt_threshold"],
        wrist_speed_swing_threshold=cfg["wrist_speed_swing_threshold"],
        shoulder_swing_threshold=cfg["shoulder_swing_threshold"],
        hip_swing_threshold=cfg["hip_swing_threshold"],
        ball_move_threshold=cfg["ball_move_threshold"],
        putt_ball_move_threshold=cfg["putt_ball_move_threshold"],
        putt_confirm_frames=cfg["putt_confirm_frames"],
        save_putts=cfg["save_putts"],
        max_shots_per_clip=cfg["max_shots_per_clip"],
        ball_wait_frames=cfg["ball_wait_frames"],
        max_disappear_frames=cfg["max_disappear_frames"],
        ema_alpha=cfg["ema_alpha"],
        pre_roll_sec=cfg["pre_roll_sec"],
        post_roll_sec=cfg["post_roll_sec"],
        clips_dir=clips_dir,
        audio_min_strength=cfg["audio_min_strength"],
        audio_overlay_sec=cfg["audio_overlay_sec"],
        audio_impact_window_sec=cfg["audio_impact_window_sec"],
        audio_transient_min_score=cfg["audio_transient_min_score"],
        audio_wind_reject_max_duration=cfg["audio_wind_reject_max_duration"],
        vision_fallback_enabled=cfg["vision_fallback_enabled"],
        vision_wrist_confirm_threshold=cfg["vision_wrist_confirm_threshold"],
        vision_torso_confirm_threshold=cfg["vision_torso_confirm_threshold"],
        vision_followthrough_frames=cfg["vision_followthrough_frames"],
        vision_setup_min_frames=cfg["vision_setup_min_frames"],
        vision_setup_confidence_min=cfg["vision_setup_confidence_min"],
        vision_posture_break_grace_sec=cfg["vision_posture_break_grace_sec"],
        display=cfg["display"],
        save_annotated=cfg["save_annotated"],
        verbose=cfg["verbose"],
        device=cfg["device"],
        inference_imgsz=cfg["inference_imgsz"],
        frame_stride=cfg.get("frame_stride", 1),
    )


def _process_clip_worker(args):
    """Worker for parallel clip processing — loads models per-process."""
    clip_path, clip_index, output_dir, cfg_kwargs, pose_model_path, ball_model_path = args
    pose_model = YOLO(pose_model_path)
    ball_model = YOLO(ball_model_path)
    shots = process_clip(
        clip_path=clip_path,
        pose_model=pose_model,
        ball_model=ball_model,
        output_dir=output_dir,
        clip_index=clip_index,
        **cfg_kwargs,
    )
    return (Path(clip_path).name, shots)


def detect_shots(cfg, on_clip_done=None):
    """Run detection over all clips using a config dict.
    on_clip_done(clip_index, total_clips, shots_found) is called after each clip.
    """
    # ── fast_mode overrides ──
    if cfg.get("fast_mode"):
        cfg["save_annotated"] = False
        cfg["verbose"] = False
        cfg["display"] = False
        # Smaller inference size for CPU — 3-4x faster with minimal accuracy loss
        if cfg.get("device", "cpu") == "cpu" or cfg.get("device") == "auto":
            cfg.setdefault("inference_imgsz", 320)
        # Process every 3rd frame on CPU to cut time by ~3x
        cfg.setdefault("frame_stride", 3)

    # ── Resolve device ──
    dev = cfg.get("device", "auto")
    if dev == "auto":
        cfg["device"] = _detect_device()
    print(f"[ShotDetector] Inference device: {cfg['device']}")

    clips_dir  = Path(cfg["clips_dir"])
    output_dir = Path(cfg["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    clips = collect_clips(clips_dir)
    if not clips:
        print(f"[ShotDetector] No .mp4 or .mov files found in {clips_dir}")
        return

    print(f"\n[ShotDetector] {len(clips)} clip(s) found in '{clips_dir}'")
    for c in clips:
        print(f"  {c.name}")
    print(f"  pose : {cfg['pose_model_path']}")
    print(f"  ball : {cfg['ball_model_path']}")

    ensure_audio_sidecars(
        clips_dir=clips_dir,
        clips=clips,
        sample_rate=cfg["audio_sample_rate"],
        highpass_hz=cfg["audio_highpass_hz"],
        peak_rel_threshold=cfg["audio_peak_rel_threshold"],
        peak_min_separation_sec=cfg["audio_peak_min_separation_sec"],
        transient_min_score=cfg["audio_transient_min_score"],
        wind_reject_max_duration=cfg["audio_wind_reject_max_duration"],
        verbose=cfg["verbose"],
    )

    if not Path(cfg["ball_model_path"]).exists():
        print(f"ERROR: Ball model not found: {cfg['ball_model_path']}")
        return

    overall_start = time.time()
    total_shots, shot_counts = 0, {}

    clip_kwargs = _build_clip_kwargs(cfg, clips_dir, output_dir)
    parallel_workers = cfg.get("parallel_workers", 0)

    if parallel_workers >= 2:
        # ── Parallel processing ──
        print(f"[ShotDetector] Parallel mode: {parallel_workers} workers")
        worker_args = [
            (clip_path, i, output_dir, clip_kwargs,
             cfg["pose_model_path"], cfg["ball_model_path"])
            for i, clip_path in enumerate(clips, start=1)
        ]
        with multiprocessing.Pool(processes=parallel_workers) as pool:
            results = pool.map(_process_clip_worker, worker_args)
        for name, shots in results:
            total_shots += shots
            shot_counts[name] = shots
    else:
        # ── Sequential processing (default) ──
        pose_model = YOLO(cfg["pose_model_path"])
        ball_model = YOLO(cfg["ball_model_path"])
        for i, clip_path in enumerate(clips, start=1):
            shots = process_clip(
                clip_path=clip_path, pose_model=pose_model,
                ball_model=ball_model, output_dir=output_dir, clip_index=i,
                **clip_kwargs,
            )
            total_shots += shots
            shot_counts[clip_path.name] = shots
            if on_clip_done:
                on_clip_done(i, len(clips), shots)

    if cfg["display"]:
        cv2.destroyAllWindows()

    total_time   = time.time() - overall_start
    no_detection = [n for n, c in shot_counts.items() if c == 0]
    print(f"\n{'='*52}")
    print(f"  SHOT DETECTION SUMMARY")
    print(f"{'='*52}")
    for name, count in shot_counts.items():
        tag = "  ← no detection, full clip saved" if count == 0 else ""
        print(f"  {name:<42}  {count} shot(s){tag}")
    print(f"{'─'*52}")
    print(f"  Total shots : {total_shots}")
    if no_detection:
        print(f"  No-detection clips saved as-is : {len(no_detection)}")
    print(f"  Processing time : {total_time:.1f}s")
    print(f"{'='*52}\n")


# ════════════════════════════════════════════════════════════════
# Entry point
# ════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    cfg = load_config("config.yaml")
    detect_shots(cfg)	
