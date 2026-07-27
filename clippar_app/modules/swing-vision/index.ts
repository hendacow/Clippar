/**
 * swing-vision — EXPERIMENTAL on-device swing LOCALIZER.
 *
 * Answers "at what second did the golfer swing?", which is what trimming needs.
 * It does NOT classify shot type: that framing needed absolute, cross-clip
 * thresholds which drift with lighting, distance and angle, and it failed
 * (see experiments/vision-swing-classifier/FINDINGS_V2.md).
 *
 * Standalone Expo module — does NOT touch shot-detector. Availability is
 * runtime-gated: on a build without the model bundled, `isAvailable()` is false
 * and callers no-op. Nothing in the app depends on this yet.
 *
 * How it works, because it is not what you'd guess:
 *  - MOTION finds the instant. Per-frame energy dips where the club reverses at
 *    the top of the backswing, then spikes ~0.20s later on the downswing. This
 *    runs on EVERY frame and is a pixel subtraction on 160x90 grayscale.
 *  - CORE ML only judges ~6 candidate moments, against image prototypes averaged
 *    from verified frames. It cannot find the instant itself — asked for "top of
 *    the backswing" it returns the held finish pose ~0.3s later.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface SwingCandidate {
  /** Top of the backswing — the club's direction reversal. */
  tTop: number;
  /** Downswing peak, ~0.20s after tTop. */
  tImpact: number;
  /** Valley depth normalised by the clip's motion scale (comparable across clips). */
  norm: number;
  /** Image-prototype evidence: max(swing, putt) - negative. */
  proto: number;
}

export interface LocalizeResult {
  decision: 'SWING' | 'NO_SWING';
  /** Which prototype won at the chosen moment. A 'putt' is left UNTRIMMED —
   *  the whole clip is the highlight. Undefined when decision is NO_SWING. */
  strokeType?: 'swing' | 'putt';
  /** Seconds into the clip. Undefined when decision is NO_SWING. */
  tTop?: number;
  tImpact?: number;
  /** Full clip length, so callers can clamp a trim window to it. */
  durationSec: number;
  /** The winning candidate's prototype score. Small by nature (~0.0-0.1): every
   *  frame is a golf course, so the three prototypes sit at cosine ~0.95 to each
   *  other and discrimination lives in small consistent differences. */
  confidence?: number;
  norm?: number;
  /** Every candidate considered, for debugging why a clip was called wrong. */
  candidates: SwingCandidate[];
  /** Wall-clock for the whole localization — real device latency. */
  elapsedMs: number;
  /** Frames per second the motion pass actually achieved. */
  motionFps: number;
}

// Optional: absent if the module isn't in this build (e.g. Expo Go, web).
const native = requireOptionalNativeModule('SwingVision');

/** True when the native module itself linked into this build (regardless of
 *  whether its model loaded). Lets the UI distinguish "module missing" from
 *  "model failed to load". */
export function isNativeModulePresent(): boolean {
  return !!native;
}

/** True when the native module AND its model/prototypes are present. */
export function isAvailable(): boolean {
  try {
    return !!native && native.isAvailable();
  } catch {
    return false;
  }
}

/** The last native resource-load error, for the test screen. */
export function lastError(): string | null {
  try {
    return native?.lastError() ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate the swing in a clip. Rejects if the module/model is unavailable —
 * callers should check isAvailable() first.
 */
export async function localizeSwing(videoUri: string): Promise<LocalizeResult> {
  if (!native) throw new Error('SwingVision native module not present in this build');
  return native.localizeSwing(videoUri);
}

// Trim policy lives in a pure module so it is testable without expo-modules-core.
export {
  planHighlightTrim,
  HIGHLIGHT_SECONDS,
  LEAD_IN_SECONDS,
  type TrimPlan,
  type HighlightInput,
} from './highlightTrim';
