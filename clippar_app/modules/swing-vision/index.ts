/**
 * swing-vision — EXPERIMENTAL on-device zero-shot swing classifier.
 *
 * Standalone Expo module (does NOT touch shot-detector). The native side runs
 * a bundled MobileCLIP/CLIP image encoder over sampled frames and returns
 * per-frame class scores; pooling + the decision live in
 * `experiments/vision-swing-classifier/swingVisionLogic.ts` so the policy is
 * testable off-device.
 *
 * Availability is runtime-gated: on a build without the model bundled,
 * `isAvailable()` is false and callers no-op. Nothing in the app depends on
 * this yet.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type VisionClass = 'full_swing' | 'address' | 'putt_chip' | 'no_shot';
export type FrameScores = Record<VisionClass, number>;

export interface ClassifyResult {
  frames: FrameScores[];
  frameCount: number;
  /** Wall-clock time the native classify took, in ms — real device latency. */
  elapsedMs: number;
}

// Optional: absent if the module isn't in this build (e.g. Expo Go, web).
const native = requireOptionalNativeModule('SwingVision');

/** True when the native module itself linked into this build (regardless of
 *  whether its model loaded). Lets the UI distinguish "module missing" from
 *  "model failed to load". */
export function isNativeModulePresent(): boolean {
  return !!native;
}

/** True when the native module AND its bundled model/embeddings are present. */
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
 * Classify a clip by sampling `frameCount` frames. Returns per-frame class
 * scores + real device latency. Rejects if the module/model is unavailable —
 * callers should check isAvailable() first.
 */
export async function classifyClip(
  videoUri: string,
  frameCount = 8
): Promise<ClassifyResult> {
  if (!native) throw new Error('SwingVision native module not present in this build');
  return native.classifyClip(videoUri, frameCount);
}
