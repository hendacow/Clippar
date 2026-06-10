import { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import {
  extractPoseTimeline,
  type PoseTimeline,
  type PoseFrame,
  type PoseJoint,
  type PoseJointName,
} from 'shot-detector';
import { theme } from '@/constants/theme';

// How often we sample the player clock and re-render the skeleton.
// 50ms (~20fps overlay) matches PreviewPlayer's LOOP_POLL_MS so the two
// timers stay in lock-step and the overlay never lags the video by more
// than one poll tick.
const POLL_MS = 50;

// Native pose extraction runs at ~5fps, so adjacent frames can be ~200ms
// apart. We interpolate between the two bracketing frames to smooth motion.
// If the nearest frame is further than this from the playhead we treat the
// pose as "absent" (e.g. player walked out of frame) and draw nothing.
const MAX_FRAME_GAP_MS = 250;

// Skeleton connections (bone segments). Each pair is drawn as a line only
// when BOTH endpoints are present in the interpolated frame.
const BONES: Array<[PoseJointName, PoseJointName]> = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['nose', 'leftShoulder'],
  ['nose', 'rightShoulder'],
];

const ALL_JOINTS: PoseJointName[] = [
  'nose',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'leftHip',
  'rightHip',
];

// A joint must clear this confidence to be drawn at all.
const MIN_JOINT_CONFIDENCE = 0.2;

// ---- Module-level timeline cache (per video uri) ----
//
// extractPoseTimeline runs a full Vision pass over the asset, so it is
// relatively expensive. We cache the resolved promise per uri so flipping
// the overlay toggle on/off — or revisiting the same clip — never re-runs
// it. Promises (not values) are cached so concurrent mounts share one pass.
const timelineCache = new Map<string, Promise<PoseTimeline>>();

function getTimeline(uri: string): Promise<PoseTimeline> {
  let cached = timelineCache.get(uri);
  if (!cached) {
    // Mirror PreviewPlayer's defensive style: never let a native rejection
    // bubble into an unhandled promise — fall back to an empty timeline.
    cached = extractPoseTimeline(uri).catch((err) => {
      console.log('[PoseOverlay] extractPoseTimeline failed:', err);
      // Drop the failed promise so a later mount can retry.
      timelineCache.delete(uri);
      return { width: 0, height: 0, frames: [] } as PoseTimeline;
    });
    timelineCache.set(uri, cached);
  }
  return cached;
}

type DisplayJoint = { x: number; y: number };

interface PoseOverlayProps {
  /** Source video uri — used as the pose-timeline cache key. */
  uri: string;
  /**
   * Returns the player's current playback position in SECONDS, or null when
   * the player has been disposed / is not ready. PreviewPlayer supplies this
   * by reading `player.currentTime` inside its own try/catch, so the
   * disposed-player race is handled at the source.
   */
  getCurrentTimeSec: () => number | null;
}

/**
 * LIVE SVG pose-overlay drawn on top of the video. Render-time only — this is
 * NEVER baked into an exported clip.
 *
 * Native returns Vision-normalized coords (0..1, Y=0 at BOTTOM) that are
 * already display-oriented (preferredTransform applied), alongside the
 * display-oriented width/height. We therefore only need a contain-fit map
 * (matching the VideoView's `contentFit="contain"`) plus a Y flip — no
 * transform/orientation handling here.
 */
export function PoseOverlay({ uri, getCurrentTimeSec }: PoseOverlayProps) {
  const [timeline, setTimeline] = useState<PoseTimeline | null>(null);
  // Bumped every poll tick to drive a re-render; the actual playhead is read
  // imperatively so we never hold a stale closure over the player.
  const [, setTick] = useState(0);
  const [layout, setLayout] = useState<{ width: number; height: number } | null>(
    null,
  );

  // Fetch (cached) timeline for this uri.
  useEffect(() => {
    let cancelled = false;
    setTimeline(null);
    getTimeline(uri)
      .then((tl) => {
        if (!cancelled) setTimeline(tl);
      })
      .catch(() => {
        // getTimeline already swallows errors, but guard anyway.
        if (!cancelled) setTimeline({ width: 0, height: 0, frames: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  // Poll the player clock. Re-renders at POLL_MS so the skeleton tracks
  // playback. The getter is read fresh each tick (no stale closure).
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => (t + 1) % 1_000_000);
    }, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout((prev) =>
      prev && prev.width === width && prev.height === height
        ? prev
        : { width, height },
    );
  };

  // Nothing to draw until we have a timeline with frames AND a measured box.
  const frames = timeline?.frames ?? [];
  const srcW = timeline?.width ?? 0;
  const srcH = timeline?.height ?? 0;

  let joints: Partial<Record<PoseJointName, DisplayJoint>> | null = null;

  if (frames.length > 0 && layout && srcW > 0 && srcH > 0) {
    const nowSec = (() => {
      try {
        return getCurrentTimeSec();
      } catch {
        // Disposed player — treat as "no pose this frame".
        return null;
      }
    })();

    if (nowSec != null && Number.isFinite(nowSec)) {
      const nowMs = nowSec * 1000;
      const interp = interpolatePose(frames, nowMs);
      if (interp) {
        joints = mapJointsToDisplay(interp, srcW, srcH, layout.width, layout.height);
      }
    }
  }

  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={onLayout}
      pointerEvents="none"
    >
      {joints && layout && (
        <Svg width={layout.width} height={layout.height}>
          {/* Bones */}
          {BONES.map(([a, b], i) => {
            const ja = joints![a];
            const jb = joints![b];
            if (!ja || !jb) return null;
            return (
              <Line
                key={`bone-${i}`}
                x1={ja.x}
                y1={ja.y}
                x2={jb.x}
                y2={jb.y}
                stroke={theme.colors.primary}
                strokeWidth={3}
                strokeOpacity={0.85}
                strokeLinecap="round"
              />
            );
          })}
          {/* Joints */}
          {ALL_JOINTS.map((name) => {
            const j = joints![name];
            if (!j) return null;
            return (
              <Circle
                key={`joint-${name}`}
                cx={j.x}
                cy={j.y}
                r={5}
                fill={theme.colors.primaryLight}
                stroke="#000"
                strokeWidth={1}
                fillOpacity={0.95}
              />
            );
          })}
        </Svg>
      )}
    </View>
  );
}

// ---- Pose interpolation ----

/**
 * Find the two frames bracketing `timeMs` and linearly interpolate each
 * joint that is present in BOTH. Joints present in only one bracketing
 * frame are passed through from the nearer frame. Returns null when the
 * nearest frame is further than MAX_FRAME_GAP_MS (pose considered absent).
 *
 * Frames are assumed sorted ascending by timeMs (native emits them in
 * order); we still binary-search defensively rather than trust ordering.
 */
function interpolatePose(
  frames: PoseFrame[],
  timeMs: number,
): Partial<Record<PoseJointName, PoseJoint>> | null {
  if (frames.length === 0) return null;

  // Binary search for the first frame with timeMs >= target.
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }

  const after = frames[lo];
  const before = lo > 0 ? frames[lo - 1] : null;

  // Clamp before the first frame / after the last frame: snap to the single
  // nearest frame, but only if it's within the gap tolerance.
  if (!before) {
    return Math.abs(after.timeMs - timeMs) <= MAX_FRAME_GAP_MS
      ? after.joints
      : null;
  }
  if (after.timeMs < timeMs) {
    return Math.abs(after.timeMs - timeMs) <= MAX_FRAME_GAP_MS
      ? after.joints
      : null;
  }

  const span = after.timeMs - before.timeMs;
  // Degenerate / duplicate timestamps — just use `before`.
  if (span <= 0) {
    return Math.abs(before.timeMs - timeMs) <= MAX_FRAME_GAP_MS
      ? before.joints
      : null;
  }

  // If the playhead sits in a long gap with no nearby frame, draw nothing.
  const nearest = Math.min(
    Math.abs(before.timeMs - timeMs),
    Math.abs(after.timeMs - timeMs),
  );
  if (nearest > MAX_FRAME_GAP_MS) return null;

  const t = (timeMs - before.timeMs) / span;
  const out: Partial<Record<PoseJointName, PoseJoint>> = {};

  for (const name of ALL_JOINTS) {
    const jb = before.joints[name];
    const ja = after.joints[name];
    if (jb && ja) {
      out[name] = {
        x: jb.x + (ja.x - jb.x) * t,
        y: jb.y + (ja.y - jb.y) * t,
        confidence: jb.confidence + (ja.confidence - jb.confidence) * t,
      };
    } else if (jb && t < 0.5) {
      out[name] = jb;
    } else if (ja && t >= 0.5) {
      out[name] = ja;
    }
  }

  return out;
}

// ---- Coordinate mapping ----

/**
 * Map Vision-normalized joints (0..1, Y=0 BOTTOM, display-oriented) to SVG
 * pixel coords inside a contain-fit box (matching VideoView contentFit:
 * "contain"). The video is letter/pillar-boxed inside the layout box; we
 * compute the same fit and offset, then flip Y (native bottom-origin → SVG
 * top-origin).
 */
function mapJointsToDisplay(
  joints: Partial<Record<PoseJointName, PoseJoint>>,
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): Partial<Record<PoseJointName, DisplayJoint>> {
  // contain-fit: scale so the whole source fits, centered.
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const dispW = srcW * scale;
  const dispH = srcH * scale;
  const offsetX = (boxW - dispW) / 2;
  const offsetY = (boxH - dispH) / 2;

  const out: Partial<Record<PoseJointName, DisplayJoint>> = {};
  for (const name of ALL_JOINTS) {
    const j = joints[name];
    if (!j || j.confidence < MIN_JOINT_CONFIDENCE) continue;
    // Normalized x is left→right; y is 0 at BOTTOM, so flip to top-origin.
    const px = offsetX + j.x * dispW;
    const py = offsetY + (1 - j.y) * dispH;
    out[name] = { x: px, y: py };
  }
  return out;
}
