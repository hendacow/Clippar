/**
 * Pure helpers for the camera-roll aha:
 * - the detection-failed fallback (trim the middle ~6s of THEIR clip), and
 * - the multi-clip batch: dedupe/cap the picker selection, fold per-clip
 *   results into a batch outcome (single / stitched / sample), overall
 *   timeout math, and the "Cutting swing 2 of 4…" progress line.
 * Kept free of React Native imports so it can be unit-tested under plain
 * node (tests/ahaTrim.test.ts).
 */

export const FALLBACK_CLIP_MS = 6000;

/** Max clips a user can pick for the onboarding aha reel. */
export const MAX_AHA_CLIPS = 5;

/** Base overall-build timeout, plus per-clip allowance. */
export const OVERALL_TIMEOUT_BASE_MS = 30_000;
export const OVERALL_TIMEOUT_PER_CLIP_MS = 15_000;

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

/* ── Multi-clip batch helpers ─────────────────────────────────────────── */

/**
 * Overall build timeout: base 30s + 15s per clip. Insurance against a batch
 * of huge 4K clips (or a wedged native promise) stranding the user on
 * "Building your reel…" — the whole build races this and falls to the
 * sample path on expiry. Counts below 1 are clamped to 1 so a degenerate
 * call still gets the single-clip budget.
 */
export function computeOverallBuildTimeoutMs(
  clipCount: number,
  baseMs: number = OVERALL_TIMEOUT_BASE_MS,
  perClipMs: number = OVERALL_TIMEOUT_PER_CLIP_MS
): number {
  const clips = Number.isFinite(clipCount) ? Math.max(1, Math.floor(clipCount)) : 1;
  return baseMs + perClipMs * clips;
}

/**
 * Dedupe a picker selection (PHPicker shouldn't return duplicates, but be
 * safe) and cap it at MAX_AHA_CLIPS, preserving the user's pick order.
 * Identity is assetId when present, else uri.
 */
export function dedupeSelectedAssets<T extends { uri: string; assetId?: string | null }>(
  assets: T[],
  maxClips: number = MAX_AHA_CLIPS
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const asset of assets) {
    if (!asset?.uri) continue;
    const key = asset.assetId ?? asset.uri;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
    if (out.length >= maxClips) break;
  }
  return out;
}

/**
 * Fold per-clip processing results (trimmed uri, or null when the clip was
 * skipped) into the successful uris, preserving pick order.
 */
export function collectSuccessfulClips(results: Array<string | null>): string[] {
  return results.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
}

export type BatchOutcome =
  | { kind: 'sample' }
  | { kind: 'single'; uri: string }
  | { kind: 'stitched'; uris: string[] };

/**
 * Decide what the batch produced:
 *   0 successes → sample fallback,
 *   1 success   → play it exactly as the single-clip flow always has,
 *   ≥2          → stitch them (pick order) into one reel.
 */
export function resolveBatchOutcome(successUris: string[]): BatchOutcome {
  if (successUris.length === 0) return { kind: 'sample' };
  if (successUris.length === 1) return { kind: 'single', uri: successUris[0] };
  return { kind: 'stitched', uris: successUris };
}

export type AhaBuildStage = 'cutting' | 'stitching';

export type AhaBuildProgress = {
  /** 1-based index of the clip being worked on (cutting stage). */
  current: number;
  /** Clips in this stage (picked count while cutting; successes while stitching). */
  total: number;
  stage: AhaBuildStage;
};

/**
 * First line of the labor-illusion checklist. Single clip (or no progress
 * info) keeps the historical "Finding the swing…"; multi-clip reflects real
 * progress ("Cutting swing 2 of 4…", then "Stitching 4 swings into one reel…").
 */
export function buildProgressLine(progress: AhaBuildProgress | null): string {
  if (!progress || progress.total <= 1) return 'Finding the swing…';
  if (progress.stage === 'stitching') {
    return `Stitching ${progress.total} swings into one reel…`;
  }
  const current = Math.min(Math.max(1, Math.floor(progress.current)), progress.total);
  return `Cutting swing ${current} of ${progress.total}…`;
}
