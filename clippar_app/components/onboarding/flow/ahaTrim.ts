/**
 * Pure helpers for the camera-roll aha's detection-failed fallback:
 * when detectAndTrim finds no swing, we still show the user THEIR clip by
 * trimming the middle ~6 seconds. Kept free of React Native imports so it
 * can be unit-tested under plain node (tests/ahaTrim.test.ts).
 */

export const FALLBACK_CLIP_MS = 6000;

/**
 * Compute the [startMs, endMs] window to trim when detection failed.
 * Returns null when the clip is already short enough to play as-is
 * (duration unknown, zero, or <= the fallback window).
 */
export function computeFallbackTrimWindow(
  durationMs: number | null | undefined,
  windowMs: number = FALLBACK_CLIP_MS
): { startMs: number; endMs: number } | null {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= windowMs) {
    return null;
  }
  const mid = durationMs / 2;
  const startMs = Math.max(0, Math.round(mid - windowMs / 2));
  const endMs = Math.min(durationMs, startMs + windowMs);
  return { startMs, endMs };
}
