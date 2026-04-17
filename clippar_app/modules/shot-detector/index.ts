export type ShotTypeClassification = 'swing' | 'putt';

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

type ShotDetectorEvents = {
  onStitchProgress: (event: StitchProgressEvent) => void;
};

type NativeModuleType = {
  detectSwing(videoUri: string): Promise<SwingDetectionResult>;
  trimVideo(videoUri: string, startMs: number, endMs: number): Promise<TrimResult>;
  detectAndTrim(videoUri: string, preRollMs: number, postRollMs: number): Promise<DetectAndTrimResult>;
  stitchClips(clipUris: string[]): Promise<StitchResult>;
  composeReel(clipUris: string[], scorecardJson: string, musicUri: string): Promise<ComposeReelResult>;
  clearTrimCache(): Promise<ClearTrimCacheResult>;
  deleteFile(fileUri: string): Promise<DeleteFileResult>;
  getMemoryStats(): Promise<MemoryStats>;
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
 *
 * Returns detection result + trimmedUri (null if no swing found or trim failed).
 * Falls back gracefully when the native module is unavailable.
 */
export async function detectAndTrim(
  videoUri: string,
  preRollMs: number = 3000,
  postRollMs: number = 2000
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

  const result = await nativeModule.detectAndTrim(videoUri, preRollMs, postRollMs);
  return {
    ...result,
    // NSNull from Swift becomes null in JS, but just be safe
    trimmedUri: result.trimmedUri ?? null,
    shotType: (result.shotType as ShotTypeClassification) ?? 'swing',
  };
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
 * - Stitches clips in order using AVMutableComposition
 * - Adds scorecard overlay (hole/par/score) via AVVideoComposition + CALayer
 * - Mixes background music via AVAudioMix (clip audio 80%, music 30%, fade out)
 *
 * @param clipUris - Array of file URIs to concatenate
 * @param scorecard - Scorecard data with per-hole timing for overlays
 * @param musicUri - Optional local file URI for background music track
 * @returns Object with reelUri, durationMs, clipCount, hasOverlay, hasMusic
 */
export async function composeReel(
  clipUris: string[],
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
  return nativeModule.composeReel(clipUris, scorecardJson, musicUri ?? "");
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
