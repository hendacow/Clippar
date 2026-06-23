// ────────────────────────────────────────────────────────────────────────
// Detection A/B logging harness (lightweight — NO SQLite migration).
//
// After `detectAndTrim` resolves anywhere in the app, call `logDetection`
// with the result + the clip id. We persist a ring buffer of the last ~100
// structured rows via the EXISTING getSetting/setSetting key/value store
// (key 'detection_ab_log') and emit a one-line '[ABHARNESS]' console marker
// so A/B runs are greppable in device logs.
//
// This module is intentionally self-contained and NON-FATAL: every public
// function swallows its own errors so a logging hiccup can never break the
// detection / trim path it's instrumenting. Callers should still wrap the
// invocation in try/catch (or `.catch(() => {})`) as belt-and-suspenders.
// ────────────────────────────────────────────────────────────────────────

import { getSetting, setSetting } from '@/lib/storage';
import type { DetectAndTrimResult } from 'shot-detector';

/** local_settings key holding the JSON-encoded ring buffer of rows. */
export const DETECTION_AB_LOG_KEY = 'detection_ab_log';

/** Keep at most this many rows; oldest are dropped as new ones arrive. */
export const DETECTION_AB_LOG_MAX_ROWS = 100;

/**
 * One persisted A/B row. Mirrors the harness keys returned by the native
 * `detectAndTrim` (see DetectAndTrimResult). All numeric/boolean detection
 * fields are optional because older native builds (or the JS fallback) may
 * not return them — we record whatever is present.
 */
export type DetectionLogRow = {
  /** ISO timestamp of when the result was logged. */
  ts: string;
  /** Clip id this detection belongs to (string form; '' if unknown). */
  clipId: string;
  /** Strategy native actually ran (echoed back). 'unknown' if absent. */
  strategy: string;
  /** Impact time in ms (rounded). null when no swing found. */
  impactMs: number | null;
  /** Detection confidence 0..1. null when absent. */
  confidence: number | null;
  /** Candidate swing episodes the strategy considered. */
  episodeCount: number | null;
  /** Source video had an audio track at all. */
  hadAudioTrack: boolean | null;
  /** A qualifying audio onset existed in the pose window (A/B denominator). */
  audioUsable: boolean | null;
  /** An audio onset was actually snapped to. */
  audioOnsetMatched: boolean | null;
};

/**
 * Read the full ring buffer (oldest → newest). Returns [] on any error or
 * when nothing has been logged yet. Never throws.
 */
export async function getDetectionLog(): Promise<DetectionLogRow[]> {
  try {
    const raw = await getSetting(DETECTION_AB_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DetectionLogRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * Clear the ring buffer. Used by the dev screen's "Clear" affordance.
 * Never throws.
 */
export async function clearDetectionLog(): Promise<void> {
  try {
    await setSetting(DETECTION_AB_LOG_KEY, null);
  } catch {
    // non-fatal
  }
}

/**
 * Record a single detection result into the ring buffer + emit a one-line
 * '[ABHARNESS]' console marker. Designed to be called at every site where
 * `detectAndTrim` resolves. NON-FATAL: any failure is swallowed.
 *
 * @param clipId - The clip id (number from SQLite or string from the editor).
 * @param result - The resolved DetectAndTrimResult.
 */
export async function logDetection(
  clipId: number | string | null | undefined,
  result: DetectAndTrimResult
): Promise<void> {
  try {
    const row: DetectionLogRow = {
      ts: new Date().toISOString(),
      clipId: clipId == null ? '' : String(clipId),
      strategy: result.chosenStrategy ?? 'unknown',
      impactMs:
        result.found && typeof result.impactTimeMs === 'number'
          ? Math.round(result.impactTimeMs)
          : null,
      confidence:
        typeof result.confidence === 'number' ? result.confidence : null,
      episodeCount:
        typeof result.episodeCount === 'number' ? result.episodeCount : null,
      hadAudioTrack:
        typeof result.hadAudioTrack === 'boolean' ? result.hadAudioTrack : null,
      audioUsable:
        typeof result.audioUsable === 'boolean' ? result.audioUsable : null,
      audioOnsetMatched:
        typeof result.audioOnsetMatched === 'boolean'
          ? result.audioOnsetMatched
          : null,
    };

    // One-line structured marker — greppable across device logs.
    console.log(
      `[ABHARNESS] strategy=${row.strategy} clip=${row.clipId} ` +
        `found=${result.found} impactMs=${row.impactMs ?? '-'} ` +
        `conf=${row.confidence != null ? row.confidence.toFixed(2) : '-'} ` +
        `episodes=${row.episodeCount ?? '-'} ` +
        `audioTrack=${fmtBool(row.hadAudioTrack)} ` +
        `audioUsable=${fmtBool(row.audioUsable)} ` +
        `audioMatched=${fmtBool(row.audioOnsetMatched)}`
    );

    // Append to ring buffer, trimming to the last MAX_ROWS rows.
    const existing = await getDetectionLog();
    const next = [...existing, row].slice(-DETECTION_AB_LOG_MAX_ROWS);
    await setSetting(DETECTION_AB_LOG_KEY, JSON.stringify(next));
  } catch {
    // Logging must never break the detection/trim path it instruments.
  }
}

function fmtBool(v: boolean | null): string {
  return v == null ? '-' : v ? 'y' : 'n';
}

/**
 * Per-strategy aggregate used by the dev summary screen.
 */
export type DetectionStrategySummary = {
  strategy: string;
  /** Total rows logged for this strategy. */
  count: number;
  /** Rows where found=true (impactMs not null) — informational. */
  foundCount: number;
  /** Mean confidence across rows with a numeric confidence. */
  meanConfidence: number | null;
  /** Rows where audioUsable === true (the honest A/B denominator). */
  audioUsableCount: number;
  /** Rows where audioUsable && audioOnsetMatched. */
  audioMatchedCount: number;
  /** matched / usable, 0..1 — null when no usable rows. */
  audioMatchedPct: number | null;
};

/**
 * Group the ring buffer by strategy and compute summary stats. Pure (takes
 * rows in, returns aggregates) so the dev screen can call it after reading
 * the log. Strategies are returned sorted by descending count.
 */
export function summarizeDetectionLog(
  rows: DetectionLogRow[]
): DetectionStrategySummary[] {
  const byStrategy = new Map<string, DetectionLogRow[]>();
  for (const row of rows) {
    const key = row.strategy || 'unknown';
    const bucket = byStrategy.get(key);
    if (bucket) bucket.push(row);
    else byStrategy.set(key, [row]);
  }

  const summaries: DetectionStrategySummary[] = [];
  for (const [strategy, group] of byStrategy) {
    const confValues = group
      .map((r) => r.confidence)
      .filter((c): c is number => typeof c === 'number');
    const meanConfidence =
      confValues.length > 0
        ? confValues.reduce((a, b) => a + b, 0) / confValues.length
        : null;

    const audioUsableCount = group.filter((r) => r.audioUsable === true).length;
    const audioMatchedCount = group.filter(
      (r) => r.audioUsable === true && r.audioOnsetMatched === true
    ).length;

    summaries.push({
      strategy,
      count: group.length,
      foundCount: group.filter((r) => r.impactMs != null).length,
      meanConfidence,
      audioUsableCount,
      audioMatchedCount,
      audioMatchedPct:
        audioUsableCount > 0 ? audioMatchedCount / audioUsableCount : null,
    });
  }

  summaries.sort((a, b) => b.count - a.count);
  return summaries;
}
