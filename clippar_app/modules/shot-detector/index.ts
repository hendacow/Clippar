import { config } from "../../constants/config";

export type ShotTypeClassification = 'swing' | 'putt';

/**
 * Swing-detection strategy. Chosen at runtime via `config.detection.strategy`
 * and forwarded to native, which dispatches accordingly. 'baseline' (and the
 * native 'default' case) call the unchanged historical detector.
 */
export type DetectionStrategy =
  | 'baseline'
  | 'aboveShoulderGate'
  | 'velocityPeak'
  | 'audioFused';

export type SwingDetectionResult = {
  found: boolean;
  impactTimeMs: number;
  trimStartMs: number;
  trimEndMs: number;
  confidence: number;
  shotType: ShotTypeClassification;
};

export type DetectAndTrimResult = SwingDetectionResult & {
  trimmedUri: string | null;
  // --- A/B harness keys (optional; absent on older native builds / tests) ---
  /** Strategy native actually ran (echoes back the dispatched case). */
  chosenStrategy?: string;
  /** Number of candidate swing episodes the strategy considered. */
  episodeCount?: number;
  /** Pose frames extracted during detection. */
  poseFrameCount?: number;
  /** Whether the strategy's gate (e.g. above-shoulder) passed. */
  gatePassed?: boolean;
  /** Source video had an audio track at all. */
  hadAudioTrack?: boolean;
  /** A qualifying audio onset existed in the pose window (honest A/B denominator). */
  audioUsable?: boolean;
  /** An audio onset was actually snapped to. */
  audioOnsetMatched?: boolean;
  /** Any baseline transient or spectral-flux onset existed. */
  hadAnyTransient?: boolean;
};

/**
 * Per-frame pose timeline returned by `extractPoseTimeline`, used for the
 * LIVE SVG pose-overlay toggle in the editor (never baked into exports).
 *
 * Coords are Vision-normalized 0..1 with Y=0 at the BOTTOM, already
 * display-oriented (the asset's preferredTransform has been applied to x/y),
 * so `width`/`height` are the display-oriented pixel dimensions. Joint keys
 * are present only for frames where that joint was detected.
 */
export type PoseJoint = {
  x: number;
  y: number;
  confidence: number;
};

export type PoseJointName =
  | 'leftWrist'
  | 'rightWrist'
  | 'leftElbow'
  | 'rightElbow'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftHip'
  | 'rightHip'
  | 'nose';

export type PoseFrame = {
  timeMs: number;
  confidence: number;
  joints: Partial<Record<PoseJointName, PoseJoint>>;
};

export type PoseTimeline = {
  width: number;
  height: number;
  frames: PoseFrame[];
};

export type TrimResult = {
  trimmedUri: string;
};

export type StitchResult = {
  stitchedUri: string;
  durationMs: number;
  clipCount: number;
};

export type ComposeReelResult = {
  reelUri: string;
  durationMs: number;
  clipCount: number;
  hasOverlay: boolean;
  hasMusic: boolean;
};

/**
 * One clip's worth of input to `composeReel`. The native side uses
 * `trimStartMs` / `trimEndMs` to call AVMutableComposition.insertTimeRange
 * with a sub-range of the source asset, so user trim edits are honoured at
 * compose time. `trimEndMs = -1` (or omitted) means "use full duration".
 */
export type ComposeClipInput = {
  uri: string;
  trimStartMs?: number;
  trimEndMs?: number;
};

export type StitchProgressEvent = {
  phase: 'composing' | 'exporting';
  current: number;
  total: number;
  percent: number;
};

export type ClearTrimCacheResult = {
  deletedCount: number;
};

export type DeleteFileResult = {
  deleted: boolean;
  error?: string;
};

export type MemoryStats = {
  availableMemoryMB: number;
  usedMemoryMB: number;
  freeDiskMB: number;
  cachesDirMB: number;
};

export type ScorecardHole = {
  holeNumber: number;
  par: number;
  strokes: number;
  startMs: number;
  endMs: number;
};

export type ScorecardData = {
  courseName: string;
  totalPar: number;
  totalStrokes: number;
  holes: ScorecardHole[];
};

// ─── Shot-tracer types (config.tracer; iOS-only, additive) ───

/**
 * Tuning knobs forwarded to native `detectBallLaunch` as optionsJson.
 * Defaults come from `config.tracer` — see the wrapper below.
 */
export type BallLaunchOptions = {
  trajectoryLength?: number;
  minTrajectoryConfidence?: number;
  detectWindowPreMs?: number;
  detectWindowPostMs?: number;
  fallback?: 'frameDiff' | 'none';
};

export type TracerPoint = { x: number; y: number };

/**
 * Result of the Vision trajectory pass over the launch window. All coords
 * are normalized 0..1, display-oriented, BOTTOM-LEFT origin (same convention
 * as PoseTimeline). `points[].tMs` is on the ORIGINAL file's timeline.
 */
export type BallLaunchResult = {
  found: boolean;
  method: 'vision' | 'none';
  launchPoint: TracerPoint | null;
  /** Unit launch direction from the first 3-6 trajectory points (null if degenerate). */
  direction: { dx: number; dy: number } | null;
  /** Full accumulated winner trajectory, capped at 60 points. */
  points: Array<{ x: number; y: number; tMs: number }>;
  /** v2 (ADDITIVE): Vision's parabola-smoothed (projected) track for the same
   *  winner, capped at 60 points, same bottom-left convention and `tMs` as
   *  `points`. The denoised series JS fits its quadratic against. May be shorter
   *  than `points` or empty (Vision reported no projectedPoints, or an older
   *  native build predating this field — hence optional for graceful degrade). */
  projectedPoints?: Array<{ x: number; y: number; tMs: number }>;
  /** F8a: a blob WAS seen in the launch ROI but failed the upward-displacement
   *  filter (grounded/topped roll) — JS must skip with reason 'grounded'. */
  groundedEvidence: boolean;
  /** (mean ankle x, min ankle y + 0.01) at the frame nearest impact. */
  poseAnchor: TracerPoint | null;
  confidence: number;
  /** Display-oriented pixel dims of the analyzed video (e.g. 1080 x 1920). */
  width: number;
  height: number;
};

/**
 * Final arc + animation spec handed to native `renderTracerOnClip`. All
 * control points normalized, bottom-left origin, display-oriented. Times are
 * on the TRIMMED clip's timeline. Built entirely in lib/tracerMath.ts —
 * Swift does zero golf math.
 */
export type TracerRenderSpec = {
  p0: TracerPoint;
  c1: TracerPoint;
  a: TracerPoint;
  c2: TracerPoint;
  p3: TracerPoint;
  animStartSec: number;
  animDurationSec: number;
  color?: string;
  coreColor?: string;
  /** Stroke widths are at-1080-wide-render pixels; native scales them. */
  lineWidthPx?: number;
  midWidthPx?: number;
  glowWidthPx?: number;
  cometHead?: boolean;
  /** Pill label drawn near the apex once the arc peaks (e.g. "82m"). */
  labelText?: string;
};

/**
 * v2 render spec: ONE time-sampled polyline (no visual seam at the two-segment
 * handoff), rendered natively as a strokeEnd keyframe animation paced by real
 * flight timing. Superset of the v1 spec's styling. Built in lib/tracerV2.ts.
 *
 * Coords normalized, bottom-left origin, display-oriented (same convention as
 * TracerRenderSpec). Invariants the native side ENFORCES (I11b, rejects with
 * ERR_TRACER_SPEC otherwise): `samples` has >=2 entries, `tSec` strictly
 * increasing, first `tSec` is 0, last `tSec` equals `animDurationSec` (so its
 * keyTime is exactly 1.0), all coords finite, non-degenerate polyline.
 */
export type TracerRenderSpecV2 = {
  samples: Array<{ x: number; y: number; tSec: number }>;
  animStartSec: number;
  animDurationSec: number;
  /** Same fields as the v1 TracerRenderSpec styling; all optional. */
  styling?: {
    color?: string;
    coreColor?: string;
    lineWidthPx?: number;
    midWidthPx?: number;
    glowWidthPx?: number;
    cometHead?: boolean;
  };
  /** Pill label drawn at the apex (highest sample) once the arc peaks. */
  labelText?: string;
  /** Crash-bisect ladder flags (tracer-sim only), same semantics as v1. */
  debugBareExport?: boolean;
  debugNoShadow?: boolean;
};

export type TracerRenderResult = {
  /** file:///...caches/tracer_<UUID>.mp4, or null when native is unavailable. */
  tracerUri: string | null;
  durationMs: number;
};

type ShotDetectorEvents = {
  onStitchProgress: (event: StitchProgressEvent) => void;
};

type NativeModuleType = {
  detectSwing(videoUri: string): Promise<SwingDetectionResult>;
  trimVideo(videoUri: string, startMs: number, endMs: number): Promise<TrimResult>;
  detectAndTrim(videoUri: string, preRollMs: number, postRollMs: number, recentShotTypes: string[], strategy: string, optionsJson: string): Promise<DetectAndTrimResult>;
  extractPoseTimeline(videoUri: string): Promise<PoseTimeline>;
  stitchClips(clipUris: string[]): Promise<StitchResult>;
  composeReel(clips: ComposeClipInput[], scorecardJson: string, musicUri: string): Promise<ComposeReelResult>;
  clearTrimCache(): Promise<ClearTrimCacheResult>;
  deleteFile(fileUri: string): Promise<DeleteFileResult>;
  getMemoryStats(): Promise<MemoryStats>;
  detectBallLaunch(videoUri: string, impactTimeMs: number, optionsJson: string): Promise<BallLaunchResult>;
  renderTracerOnClip(videoUri: string, specJson: string): Promise<{ tracerUri: string; durationMs: number }>;
  /** Sync capability probe; ABSENT on native builds predating tracer v2. */
  tracerNativeCapabilities?(): { renderV2?: boolean; projectedPoints?: boolean };
  getCameraFovDeg(): Promise<{ hFovLandscapeDeg: number | null }>;
  getDevicePitchDeg(): Promise<{ pitchDownDeg: number | null }>;
  addListener<K extends keyof ShotDetectorEvents>(eventName: K, listener: ShotDetectorEvents[K]): { remove(): void };
  removeListener<K extends keyof ShotDetectorEvents>(eventName: K, listener: ShotDetectorEvents[K]): void;
};

let nativeModule: NativeModuleType | null = null;

try {
  nativeModule = require("./src/ShotDetectorModule").default;
} catch {
  // Native module not available (Expo Go or missing native build)
}

/**
 * Subscribe to stitch/compose progress events from the native module.
 * Returns a subscription with a `remove()` method to unsubscribe.
 *
 * Events fire during `stitchClips` and `composeReel` calls:
 * - phase "composing": clip X of Y being added to composition
 * - phase "exporting": AVAssetExportSession progress (50-100%)
 */
export function addStitchProgressListener(
  callback: (event: StitchProgressEvent) => void
): { remove: () => void } {
  if (!nativeModule) {
    // Return a no-op subscription when native module is unavailable
    return { remove: () => {} };
  }
  return nativeModule.addListener("onStitchProgress", callback);
}

/**
 * Detect a golf swing in a video file using on-device pose estimation
 * and audio transient analysis (iOS only, requires dev client build).
 *
 * Falls back to `{ found: false }` when the native module is unavailable.
 */
export async function detectSwing(
  videoUri: string
): Promise<SwingDetectionResult> {
  if (!nativeModule) {
    console.warn(
      "[ShotDetector] Native module not available. " +
        "This requires an Expo dev client build — returning { found: false }."
    );
    return {
      found: false,
      impactTimeMs: 0,
      trimStartMs: 0,
      trimEndMs: 0,
      confidence: 0,
      shotType: 'swing',
    };
  }

  return nativeModule.detectSwing(videoUri);
}

/**
 * Trim a video using AVAssetExportSession passthrough — zero re-encode.
 * 4K stays 4K, original quality preserved. Completes in <1 second.
 *
 * Falls back to returning the original URI when the native module is unavailable.
 */
export async function trimVideo(
  videoUri: string,
  startMs: number,
  endMs: number
): Promise<TrimResult> {
  if (!nativeModule) {
    console.warn(
      "[ShotDetector] Native module not available for trimVideo — returning original URI."
    );
    return { trimmedUri: videoUri };
  }

  return nativeModule.trimVideo(videoUri, startMs, endMs);
}

/**
 * Detect a golf swing AND passthrough-trim in one call.
 * Uses Apple Vision pose estimation + audio transient detection,
 * then AVAssetExportSession passthrough trim (zero quality loss).
 *
 * @param videoUri - Path to the video file
 * @param preRollMs - Milliseconds before impact to include (default 3000)
 * @param postRollMs - Milliseconds after impact to include (default 2000)
 * @param recentShotTypes - Last few classifications on this hole (inter-clip context
 *   for the 3-tier classifier). Pass [] if no context is available.
 * @param strategy - Detection strategy to dispatch natively. Defaults to
 *   `config.detection.strategy` ('baseline' ships day-zero, byte-identical).
 *   Existing call sites omit this and inherit the config default.
 * @param optionsJson - JSON-encoded strategy tuning knobs (DetectionOptions).
 *   Defaults to `JSON.stringify(config.detection.options)`.
 *
 * Returns detection result + trimmedUri (null if no swing found or trim failed).
 * Falls back gracefully when the native module is unavailable.
 *
 * NOTE: native `detectAndTrim` is a 6-arg AsyncFunction; Expo Modules matches
 * arity exactly, so this wrapper ALWAYS forwards all six positional args.
 */
export async function detectAndTrim(
  videoUri: string,
  preRollMs: number = 3000,
  postRollMs: number = 2000,
  recentShotTypes: ShotTypeClassification[] = [],
  strategy: DetectionStrategy = config.detection.strategy,
  optionsJson: string = JSON.stringify(config.detection.options ?? {})
): Promise<DetectAndTrimResult> {
  if (!nativeModule) {
    console.warn(
      "[ShotDetector] Native module not available for detectAndTrim — returning { found: false }."
    );
    return {
      found: false,
      impactTimeMs: 0,
      trimStartMs: 0,
      trimEndMs: 0,
      confidence: 0,
      shotType: 'swing',
      trimmedUri: null,
    };
  }

  const result = await nativeModule.detectAndTrim(
    videoUri,
    preRollMs,
    postRollMs,
    recentShotTypes,
    strategy,
    optionsJson
  );
  return {
    ...result,
    // NSNull from Swift becomes null in JS, but just be safe
    trimmedUri: result.trimmedUri ?? null,
    shotType: (result.shotType as ShotTypeClassification) ?? 'swing',
  };
}

/**
 * Extract a per-frame pose timeline for the LIVE SVG pose-overlay toggle in
 * the editor. This is render-time only — pose data is NEVER baked into an
 * exported clip.
 *
 * Coords are Vision-normalized 0..1 (Y=0 at BOTTOM), already display-oriented
 * (preferredTransform applied), matching the display-oriented width/height.
 *
 * Falls back to an empty timeline when the native function is unavailable
 * (Expo Go, or a native build predating this function).
 */
export async function extractPoseTimeline(
  videoUri: string
): Promise<PoseTimeline> {
  if (!nativeModule || typeof nativeModule.extractPoseTimeline !== "function") {
    console.warn(
      "[ShotDetector] extractPoseTimeline not available — rebuild native app with: npx expo run:ios --device"
    );
    return { width: 0, height: 0, frames: [] };
  }

  return nativeModule.extractPoseTimeline(videoUri);
}

/**
 * Stitch multiple video clips into a single video on-device.
 * Uses AVMutableComposition — re-encodes to H.264 at highest quality.
 *
 * @param clipUris - Array of file URIs to concatenate in order
 * @returns Object with stitchedUri, durationMs, and clipCount
 */
export async function stitchClips(
  clipUris: string[]
): Promise<StitchResult> {
  if (!nativeModule || typeof nativeModule.stitchClips !== "function") {
    console.warn(
      "[ShotDetector] stitchClips not available — rebuild native app with: npx expo run:ios --device"
    );
    throw new Error(
      "stitchClips requires a native rebuild. Run: npx expo run:ios --device"
    );
  }

  return nativeModule.stitchClips(clipUris);
}

/**
 * Compose a full highlight reel on-device:
 * - Stitches clips in order using AVMutableComposition, honouring per-clip
 *   trimStartMs / trimEndMs so user trim edits are applied at compose time
 * - Adds scorecard overlay (hole/par/score) via AVVideoComposition + CALayer
 * - Mixes background music via AVAudioMix (clip audio 80%, music 30%, fade out)
 *
 * @param clips - Array of clip inputs (uri + optional trim range)
 * @param scorecard - Scorecard data with per-hole timing for overlays
 * @param musicUri - Optional local file URI for background music track
 * @returns Object with reelUri, durationMs, clipCount, hasOverlay, hasMusic
 */
export async function composeReel(
  clips: ComposeClipInput[],
  scorecard: ScorecardData,
  musicUri?: string | null
): Promise<ComposeReelResult> {
  if (!nativeModule || typeof nativeModule.composeReel !== "function") {
    console.warn(
      "[ShotDetector] composeReel not available — rebuild native app with: npx expo run:ios --device"
    );
    throw new Error(
      "composeReel requires a native rebuild. Run: npx expo run:ios --device"
    );
  }

  const scorecardJson = JSON.stringify(scorecard);
  return nativeModule.composeReel(clips, scorecardJson, musicUri ?? "");
}

/**
 * Delete all cached trim files (trim_*.mov, trim_*.mp4) from the iOS caches directory.
 * Useful for freeing disk space after editing is complete.
 *
 * Returns { deletedCount: number }.
 * Falls back gracefully when the native module is unavailable.
 */
export async function clearTrimCache(): Promise<ClearTrimCacheResult> {
  if (!nativeModule || typeof nativeModule.clearTrimCache !== "function") {
    console.warn(
      "[ShotDetector] clearTrimCache not available — rebuild native app with: npx expo run:ios --device"
    );
    return { deletedCount: 0 };
  }

  return nativeModule.clearTrimCache();
}

/**
 * Delete a single file by URI. Useful for cleaning up picker copies
 * after detectAndTrim has produced a trimmed version.
 *
 * Returns { deleted: boolean, error?: string }.
 * Falls back gracefully when the native module is unavailable.
 */
export async function deleteFile(
  fileUri: string
): Promise<DeleteFileResult> {
  if (!nativeModule || typeof nativeModule.deleteFile !== "function") {
    console.warn(
      "[ShotDetector] deleteFile not available — rebuild native app with: npx expo run:ios --device"
    );
    return { deleted: false, error: "Native module not available" };
  }

  return nativeModule.deleteFile(fileUri);
}

/**
 * Get current memory + disk stats for crash diagnostics.
 * Returns availableMemoryMB, usedMemoryMB, freeDiskMB, cachesDirMB.
 */
export async function getMemoryStats(): Promise<MemoryStats> {
  if (!nativeModule || typeof nativeModule.getMemoryStats !== "function") {
    return { availableMemoryMB: -1, usedMemoryMB: -1, freeDiskMB: -1, cachesDirMB: -1 };
  }

  return nativeModule.getMemoryStats();
}

// ─── Shot-tracer wrappers (config.tracer; iOS-only) ───

/**
 * Detect the real ball launch in the frames after impact via Apple Vision
 * VNDetectTrajectoriesRequest (stationary tripod camera). Run on the
 * ORIGINAL (untrimmed) file when available; `impactTimeMs` is on that same
 * file's timeline.
 *
 * Rejects ONLY on file-not-found; every other failure mode resolves
 * `{ found: false, method: 'none' }` so the JS fallback ladder continues.
 *
 * NOTE: native detectBallLaunch is a 3-arg AsyncFunction; Expo Modules
 * matches arity exactly, so this wrapper ALWAYS forwards all three args.
 */
export async function detectBallLaunch(
  videoUri: string,
  impactTimeMs: number,
  optionsJson: string = JSON.stringify({
    trajectoryLength: config.tracer.trajectoryLength,
    minTrajectoryConfidence: config.tracer.minTrajectoryConfidence,
    detectWindowPreMs: config.tracer.detectWindowPreMs,
    detectWindowPostMs: config.tracer.detectWindowPostMs,
    fallback: config.tracer.fallback,
  } satisfies BallLaunchOptions)
): Promise<BallLaunchResult> {
  if (!nativeModule || typeof nativeModule.detectBallLaunch !== "function") {
    console.warn(
      "[ShotDetector] detectBallLaunch not available — rebuild native app with: npx expo run:ios --device"
    );
    return {
      found: false,
      method: 'none',
      launchPoint: null,
      direction: null,
      points: [],
      projectedPoints: [],
      groundedEvidence: false,
      poseAnchor: null,
      confidence: 0,
      width: 0,
      height: 0,
    };
  }

  return nativeModule.detectBallLaunch(videoUri, impactTimeMs, optionsJson);
}

/**
 * Burn a tracer arc onto a clip, producing a NEW tracer_<UUID>.mp4 in caches
 * (the source file is never touched). `specJson` is a JSON-encoded
 * TracerRenderSpec built by lib/tracerMath.ts.
 *
 * Rejects on spec/file/track/export errors (ERR_TRACER_* / ERR_COMPOSITION /
 * ERR_EXPORT_SESSION — callers mark the clip 'failed' and continue). Falls
 * back to `{ tracerUri: null }` when the native function is unavailable.
 */
export async function renderTracer(
  videoUri: string,
  specJson: string
): Promise<TracerRenderResult> {
  if (!nativeModule || typeof nativeModule.renderTracerOnClip !== "function") {
    console.warn(
      "[ShotDetector] renderTracerOnClip not available — rebuild native app with: npx expo run:ios --device"
    );
    return { tracerUri: null, durationMs: 0 };
  }

  const result = await nativeModule.renderTracerOnClip(videoUri, specJson);
  return {
    // NSNull from Swift becomes null in JS, but just be safe
    tracerUri: result.tracerUri ?? null,
    durationMs: result.durationMs ?? 0,
  };
}

/**
 * Whether the loaded native build understands the v2 TracerRenderSpecV2
 * (time-sampled polyline). False on Expo Go and on native builds predating
 * tracer v2 — the `tracerNativeCapabilities` probe is absent there, so a v2
 * spec would be misparsed as an invalid v1 spec and hard-rejected. Callers use
 * this to feature-detect and fall back to the v1 5-point path.
 */
export function nativeSupportsTracerV2(): boolean {
  if (!nativeModule || typeof nativeModule.tracerNativeCapabilities !== "function") {
    return false;
  }
  try {
    return nativeModule.tracerNativeCapabilities().renderV2 === true;
  } catch {
    return false;
  }
}

/**
 * Render a v2 (time-sampled polyline) tracer, gracefully degrading to the v1
 * 5-point Bezier path when the native build lacks v2 parsing.
 *
 * Feature-detect (never trial-and-error): if `nativeSupportsTracerV2()` we send
 * the v2 spec; otherwise, if a `v1FallbackSpec` was supplied, we send that to
 * the unchanged `renderTracerOnClip`; otherwise we return `{ tracerUri: null }`
 * (old build, no fallback available — caller skips the render, never crashes).
 *
 * This never masks a genuinely-invalid v2 spec: on a v2-capable build the native
 * side hard-rejects a malformed spec with ERR_TRACER_SPEC and that error
 * propagates — we only downgrade when native lacks v2 support entirely.
 *
 * @param videoUri Clip to burn the tracer onto.
 * @param v2Spec   The v2 spec (object; serialized here) OR a pre-encoded JSON
 *                 string.
 * @param v1FallbackSpec Optional v1 spec (object or JSON string) used only when
 *                 native lacks v2 support.
 */
export async function renderTracerV2(
  videoUri: string,
  v2Spec: TracerRenderSpecV2 | string,
  v1FallbackSpec?: TracerRenderSpec | string | null
): Promise<TracerRenderResult> {
  if (!nativeModule || typeof nativeModule.renderTracerOnClip !== "function") {
    console.warn(
      "[ShotDetector] renderTracerOnClip not available — rebuild native app with: npx expo run:ios --device"
    );
    return { tracerUri: null, durationMs: 0 };
  }

  const encode = (s: unknown): string => (typeof s === "string" ? s : JSON.stringify(s));

  if (nativeSupportsTracerV2()) {
    return renderTracer(videoUri, encode(v2Spec));
  }

  // Native predates v2: fall back to the v1 5-point spec if the caller gave one.
  if (v1FallbackSpec != null) {
    console.warn(
      "[ShotDetector] native lacks tracer v2 — falling back to the v1 5-point render spec."
    );
    return renderTracer(videoUri, encode(v1FallbackSpec));
  }

  console.warn(
    "[ShotDetector] native lacks tracer v2 and no v1 fallback spec was provided — skipping tracer render."
  );
  return { tracerUri: null, durationMs: 0 };
}

/**
 * Back wide camera's 1920x1080-format videoFieldOfView — the LANDSCAPE
 * (long-axis) horizontal FOV in degrees. tracerMath converts it to the
 * portrait horizontal FOV. Null on simulator / no matching format / older
 * native builds; callers fall back to config.tracer.cameraHFovLandscapeDeg.
 */
export async function getCameraFovDeg(): Promise<number | null> {
  if (!nativeModule || typeof nativeModule.getCameraFovDeg !== "function") {
    return null;
  }

  const result = await nativeModule.getCameraFovDeg();
  return result?.hFovLandscapeDeg ?? null;
}

/**
 * One-shot CoreMotion sample of the camera optical axis's downward tilt in
 * degrees (positive = tilted down). Null after ~1s timeout, junk sample, or
 * older native builds; callers fall back to config.tracer.horizonY.
 */
export async function getDevicePitchDeg(): Promise<number | null> {
  if (!nativeModule || typeof nativeModule.getDevicePitchDeg !== "function") {
    return null;
  }

  const result = await nativeModule.getDevicePitchDeg();
  return result?.pitchDownDeg ?? null;
}
