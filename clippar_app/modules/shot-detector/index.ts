import { config } from "../../constants/config";
// Type-only, so nothing is imported at runtime and there is no cycle: the wire
// shapes for the V3 pair are DEFINED in lib/tracerV3.ts (SHARED CONVENTIONS 2
// and 3) and must not be restated here — two declarations of one wire format is
// exactly how a native bridge drifts from its caller.
import type { TracerDetectResultV3, TracerRenderSpecV3 } from "../../lib/tracerV3";

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

/**
 * Result of `excludeFromBackup`. Deliberately NOT a bare boolean: the caller
 * has to be able to tell "iOS accepted the exclusion" apart from "this build
 * cannot do it", because those two mean opposite things for MEDIA-002.
 */
export type ExcludeFromBackupResult = {
  excluded: boolean;
  /** Why not, when `excluded` is false. */
  reason?: string;
};

export type ReclaimTempExportsResult = {
  deletedCount: number;
  /** Matched a temp-export name but was still referenced by the app. */
  skippedInUse: number;
  /** Matched but younger than maxAgeMs — an export may still be in flight. */
  skippedTooRecent: number;
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

/** Which card the reel burns in. Native draws all of these; the app's preview
 *  mirrors them. 'training' is the practice look: the club name over the shot. */
export type ScorecardTemplate = 'classic' | 'minimal' | 'euro' | 'pga' | 'masters' | 'training';

export type ScorecardHole = {
  holeNumber: number;
  par: number;
  strokes: number;
  /** Practice reels: the club name shown over this segment. */
  label?: string;
  /**
   * True only when the hole was actually ended (a score row exists for it —
   * EditorHoleSection.hasScore). When false, `strokes` is just the clip-count
   * fallback and the reel's card must render an empty score cell, exactly as
   * the in-app preview does. See lib/scoreDisplay.ts.
   */
  hasScore: boolean;
  startMs: number;
  endMs: number;
};

export type ScorecardData = {
  courseName: string;
  /** Card design; absent = 'classic' (older binaries ignore it). */
  template?: ScorecardTemplate;
  /** Shown on the tour-style cards. */
  playerName?: string;
  /** Par over COMPLETED holes only (0 when no hole is finished). */
  totalPar: number;
  /** Strokes over COMPLETED holes only (0 when no hole is finished). */
  totalStrokes: number;
  /** How many holes are finished — 0 means the card shows "-" and no chip. */
  holesCompleted: number;
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
  /**
   * Optional: absent on every native build predating the MEDIA-002 work.
   * Sets NSURLIsExcludedFromBackupKey on the given file/dir URL.
   */
  excludeFromBackup?(fileUri: string): Promise<{ excluded: boolean; reason?: string }>;
  deleteFile(fileUri: string): Promise<DeleteFileResult>;
  getMemoryStats(): Promise<MemoryStats>;
  detectBallLaunch(videoUri: string, impactTimeMs: number, optionsJson: string): Promise<BallLaunchResult>;
  renderTracerOnClip(videoUri: string, specJson: string): Promise<{ tracerUri: string; durationMs: number }>;
  /**
   * V3 pair. Optional for the same reason `excludeFromBackup` is: they are
   * absent from every native build predating the tracer-v3 branch, and an old
   * dev client must SKIP cleanly rather than crash. Both wrappers below check
   * `typeof … === "function"` before calling.
   */
  detectShotV3?(videoUri: string, impactTimeMs: number, optionsJson: string): Promise<TracerDetectResultV3>;
  renderTracerV3?(videoUri: string, specJson: string): Promise<{ tracerUri: string; durationMs: number; stats?: Record<string, unknown> }>;
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

// Used by reclaimTemporaryExports to sweep this module's own leftovers out of
// Library/Caches. Literal require so Metro bundles it; null under node/web.
let FileSystemLegacy: typeof import("expo-file-system/legacy") | null = null;
try {
  FileSystemLegacy = require("expo-file-system/legacy");
} catch {
  // expo-file-system not available (plain node test runner)
}

/**
 * Whether the native shot-detector is present in this binary. Lets callers
 * (e.g. the onboarding aha) pick a fallback path up-front instead of
 * inferring absence from a `{ found: false }` result that could equally
 * mean "detection genuinely found no swing".
 */
export function isShotDetectorAvailable(): boolean {
  return nativeModule !== null;
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

// ─── MEDIA-003: reclaiming temporary exports ───
//
// Every trim, compose and "share this hole" drops a full-fidelity copy of the
// golfer's video into Library/Caches and nothing ever removes it:
//   trim_<UUID>.(mp4|mov)      — trimVideo / detectAndTrim
//   stitch_<UUID>.mp4          — stitchClips / composeReel
//   tracer_<UUID>.mp4          — renderTracerOnClip
//   clippar_reel_<roundId>.mp4 — lib/sharing.ts getLocalVideoUri
// `clearTrimCache` above only ever matched `trim_`, and had no call sites at
// all, so these accumulate for the life of the install. That is unbounded
// retention of readable footage the user believes they deleted — deleting a
// round unlinks only the URIs recorded in SQLite, and a temp that was never
// promoted into a column is not among them — plus the practical cause of
// storage exhaustion on an 18-hole round. A crash mid-export (realistic: the
// compose path holds large buffers) also leaves a readable partial video
// behind permanently, which is what "reconcile orphaned temporary files after
// crash" in the spec is asking for.
//
// This is implemented in TS rather than by widening the native filter for two
// reasons: it can ship over-the-air (a Swift change needs a new binary), and
// the two safety rules below are testable in isolation.

const TEMP_EXPORT_PREFIXES = ["trim_", "stitch_", "tracer_", "clippar_reel_"] as const;
const TEMP_EXPORT_SUFFIXES = [".mp4", ".mov"] as const;

/**
 * Files younger than this are left alone. An export in flight, or a reel the
 * user composed moments ago and has not yet saved, must never be pulled out
 * from under the player.
 */
export const TEMP_EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Map arbitrary URIs to the bare filenames `reclaimTemporaryExports` compares
 * against. Handles the file:// prefix, percent-encoding and any ?query so a
 * URI stored in SQLite still matches the file on disk.
 */
export function tempExportFilenames(
  uris: ReadonlyArray<string | null | undefined>
): Set<string> {
  const names = new Set<string>();
  for (const uri of uris) {
    if (!uri) continue;
    const withoutQuery = uri.split("?")[0].split("#")[0];
    let name = withoutQuery.substring(withoutQuery.lastIndexOf("/") + 1);
    if (!name) continue;
    try {
      name = decodeURIComponent(name);
    } catch {
      // Malformed escape — compare the raw name rather than dropping it,
      // since dropping it would make the file look reclaimable.
    }
    names.add(name);
  }
  return names;
}

/**
 * The whole safety decision for one file, kept pure so the "never delete
 * something in use" and "never delete something recent" guarantees are locked
 * down by tests rather than by inspection of an async sweep.
 *
 * Anything that is not a recognised temporary export is left untouched — this
 * must never grow into a general cache wipe, because Library/Caches also holds
 * other subsystems' data (e.g. recovered-clips/).
 */
export function isReclaimableTempExport(
  filename: string,
  opts: {
    modifiedAtMs: number;
    nowMs: number;
    maxAgeMs: number;
    inUseFilenames: ReadonlySet<string>;
  }
): boolean {
  const isTempExport =
    TEMP_EXPORT_PREFIXES.some((p) => filename.startsWith(p)) &&
    TEMP_EXPORT_SUFFIXES.some((s) => filename.toLowerCase().endsWith(s));
  if (!isTempExport) return false;
  if (opts.inUseFilenames.has(filename)) return false;
  // A missing/zero mtime means we could not establish the file's age; treat it
  // as brand new rather than guessing, so an unreadable stat can never cause
  // deletion.
  if (!opts.modifiedAtMs) return false;
  return opts.nowMs - opts.modifiedAtMs >= opts.maxAgeMs;
}

/**
 * Sweep aged-out temporary exports out of Library/Caches.
 *
 * `inUseUris` is REQUIRED and has no default on purpose: the caller is the only
 * one who can enumerate local_clips.file_uri / trimmed_file_uri and
 * rounds.reel_url, and a caller who forgets it would delete a reel the player
 * is holding. Making it mandatory means that mistake is a type error.
 *
 * Safe to call at startup — it never touches files younger than `maxAgeMs`.
 */
export async function reclaimTemporaryExports(params: {
  inUseUris: ReadonlyArray<string | null | undefined>;
  maxAgeMs?: number;
  nowMs?: number;
}): Promise<ReclaimTempExportsResult> {
  const result: ReclaimTempExportsResult = {
    deletedCount: 0,
    skippedInUse: 0,
    skippedTooRecent: 0,
  };

  const cacheDir = FileSystemLegacy?.cacheDirectory;
  if (!FileSystemLegacy || !cacheDir) return result;

  const maxAgeMs = params.maxAgeMs ?? TEMP_EXPORT_MAX_AGE_MS;
  const nowMs = params.nowMs ?? Date.now();
  const inUseFilenames = tempExportFilenames(params.inUseUris);

  let entries: string[];
  try {
    entries = await FileSystemLegacy.readDirectoryAsync(cacheDir);
  } catch (err) {
    console.warn("[ShotDetector] reclaimTemporaryExports: cannot read cache dir", err);
    return result;
  }

  for (const filename of entries) {
    const looksTemporary =
      TEMP_EXPORT_PREFIXES.some((p) => filename.startsWith(p)) &&
      TEMP_EXPORT_SUFFIXES.some((s) => filename.toLowerCase().endsWith(s));
    if (!looksTemporary) continue;

    const uri = `${cacheDir}${filename}`;
    try {
      // getInfoAsync on a FILE is cheap — the pathological recursive-sizing
      // case (see lib/media.ts) only applies to directories.
      const info = await FileSystemLegacy.getInfoAsync(uri);
      if (!info.exists) continue;
      const modifiedAtMs = (info as { modificationTime?: number }).modificationTime
        ? Math.round(((info as { modificationTime: number }).modificationTime) * 1000)
        : 0;

      if (inUseFilenames.has(filename)) {
        result.skippedInUse++;
        continue;
      }
      if (
        !isReclaimableTempExport(filename, { modifiedAtMs, nowMs, maxAgeMs, inUseFilenames })
      ) {
        result.skippedTooRecent++;
        continue;
      }

      await FileSystemLegacy.deleteAsync(uri, { idempotent: true });
      result.deletedCount++;
    } catch (err) {
      // One unreadable file must not abort the sweep.
      console.warn("[ShotDetector] reclaimTemporaryExports: skipping", filename, err);
    }
  }

  return result;
}

/**
 * MEDIA-002: mark a file or directory NSURLIsExcludedFromBackupKey so it is
 * left out of iCloud/iTunes device backups.
 *
 * Why this exists: raw clips live in documentDirectory/clips/, which iOS backs
 * up to iCloud by default. A user who deliberately leaves Cloud backup OFF —
 * and is told "Cloud backup off — clips not in the cloud" — still has every
 * clip, and the GPS-bearing SQLite database, uploaded to Apple on the next
 * device backup and restored onto any device that restores it.
 *
 * expo-file-system exposes no way to set this key, so it needs a native
 * counterpart. Until `excludeFromBackup` exists in ShotDetectorModule.swift
 * this resolves `{ excluded: false, reason: 'native-unavailable' }` and the
 * control is NOT in force — callers must treat a false as "still backed up"
 * and must not report success on its behalf.
 */
export async function excludeFromBackup(fileUri: string): Promise<ExcludeFromBackupResult> {
  if (!nativeModule || typeof nativeModule.excludeFromBackup !== "function") {
    return { excluded: false, reason: "native-unavailable" };
  }
  try {
    const result = await nativeModule.excludeFromBackup(fileUri);
    return { excluded: result?.excluded === true, reason: result?.reason };
  } catch (err) {
    return { excluded: false, reason: String(err) };
  }
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

// ─── V3 physics tracer (config.tracer.engine === 'v3'; iOS-only) ───

/**
 * Knobs forwarded to native `detectShotV3` as optionsJson. Anything omitted
 * keeps the lab's own value (tracer-lab/lib/detect.py's `P` dict) — the Swift
 * side defaults every field, so this object only ever OVERRIDES.
 */
export type TracerDetectV3Options = {
  /** Analysis window around impact, 30 fps-equivalent frames. */
  preFrames?: number;
  postFrames?: number;
  /** 0 = no ceiling on frames analysed. */
  maxFrames?: number;
  /** Track-level emission: mean confidence floor and minimum detections. */
  confFloor?: number;
  minTrackEmit?: number;
  /** Score a candidate must reach to be accepted INTO a running track (lab
   *  `accept_score`, 0.22). Lowering it makes the tracker hold a ball that is
   *  going sub-pixel; it also picks up junk, which is why it is a retry rather
   *  than a default. See `config.tracer.v3.retryAcceptScore`. */
  acceptScore?: number;
  /** Diagnostics: adds a per-frame `trackLog` to `notes`. Large. */
  verbose?: boolean;
};

/**
 * Detect the ball at address and through the launch (the V3 detector: median
 * background, DoG blobs, a pose-seeded address finder, Core ML ball model,
 * departure cue, decaying-velocity Kalman).
 *
 * Runs on the ORIGINAL (untrimmed) file when there is one — it holds more
 * post-impact footage — and `impactTimeMs` is on that same file's timeline.
 *
 * NEVER REJECTS. Every failure, including a missing file, comes back
 * `found: false` with a reason in `notes`, because the product rule is that a
 * failure is a SKIP and a rejected promise reads as a bug. The one thing it
 * cannot answer for is a binary that predates it: that is the guard below, and
 * it produces the same shaped "no" so `lib/tracerV3.ts` needs no special case.
 *
 * NOTE: native detectShotV3 is a 3-arg AsyncFunction; Expo Modules matches
 * arity exactly, so this wrapper ALWAYS forwards all three args.
 */
export async function detectShotV3(
  videoUri: string,
  impactTimeMs: number,
  optionsJson: string = JSON.stringify({
    preFrames: config.tracer.v3.detectPreFrames,
    postFrames: config.tracer.v3.detectPostFrames,
    maxFrames: config.tracer.v3.detectMaxFrames,
    confFloor: config.tracer.v3.detectConfFloor,
    minTrackEmit: config.tracer.v3.detectMinTrackEmit,
  } satisfies TracerDetectV3Options)
): Promise<TracerDetectResultV3> {
  if (!nativeModule || typeof nativeModule.detectShotV3 !== "function") {
    console.warn(
      "[ShotDetector] detectShotV3 not available — rebuild native app with: npx expo run:ios --device"
    );
    return {
      found: false,
      method: 'none',
      fps: 0,
      width: 0,
      height: 0,
      impactFrameGiven: 0,
      impactFrameUsed: null,
      launchFrame: null,
      address: null,
      detections: [],
      notes: { reason: 'native-unavailable' },
      msPerFrame: 0,
    };
  }
  return nativeModule.detectShotV3(videoUri, impactTimeMs, optionsJson);
}

/**
 * Burn a V3 polyline trace onto a clip, producing a NEW tracer_<UUID>.mp4 in
 * caches (the source file is never touched). `spec` is the TracerRenderSpecV3
 * built by lib/tracerV3.ts — normalized 0..1, bottom-left, display-oriented.
 *
 * Rejects on spec/file/track/export errors, with the SAME error names the v1
 * renderer uses (ERR_TRACER_SPEC / ERR_FILE_NOT_FOUND / ERR_NO_VIDEO_TRACK /
 * ERR_COMPOSITION / ERR_INSERT_VIDEO / ERR_TRACER_ANIM_WINDOW /
 * ERR_EXPORT_GATE_TIMEOUT / ERR_EXPORT_SESSION / ERR_TRACER_RENDER_FAILED), so
 * the caller marks the clip 'failed' and continues exactly as before. Resolves
 * `{ tracerUri: null }` when the native function is absent.
 */
export async function renderTracerV3(
  videoUri: string,
  spec: TracerRenderSpecV3
): Promise<TracerRenderResult> {
  if (!nativeModule || typeof nativeModule.renderTracerV3 !== "function") {
    console.warn(
      "[ShotDetector] renderTracerV3 not available — rebuild native app with: npx expo run:ios --device"
    );
    return { tracerUri: null, durationMs: 0 };
  }
  const result = await nativeModule.renderTracerV3(videoUri, JSON.stringify(spec));
  return {
    tracerUri: result.tracerUri ?? null,
    durationMs: result.durationMs ?? 0,
  };
}

/** Whether this binary carries the V3 native pair at all. Lets the batch skip
 *  the whole engine rather than fail every clip one at a time. */
export function isTracerV3Available(): boolean {
  return (
    nativeModule !== null &&
    typeof nativeModule.detectShotV3 === "function" &&
    typeof nativeModule.renderTracerV3 === "function"
  );
}
