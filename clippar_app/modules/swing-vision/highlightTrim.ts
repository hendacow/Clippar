/**
 * Highlight trim policy — pure, no native imports.
 *
 * Kept out of index.ts so it runs under `node --test` without expo-modules-core,
 * exactly like experiments/vision-swing-classifier/swingVisionLogic.ts. The
 * decision of what a user ends up watching is worth testing on its own.
 */

/** Total length of the trimmed highlight. */
export const HIGHLIGHT_SECONDS = 5.0;
/** How much of that sits BEFORE impact — enough to see the backswing, leaving
 *  the remainder for the strike and the ball flight, which is the part worth
 *  watching. */
export const LEAD_IN_SECONDS = 2.0;

/** The minimum a localization result must provide to plan a trim. */
export interface HighlightInput {
  decision: 'SWING' | 'NO_SWING';
  strokeType?: 'swing' | 'putt';
  tImpact?: number;
  durationSec: number;
}

export interface TrimPlan {
  /** False means hand the ORIGINAL clip through untouched. */
  trim: boolean;
  startSec: number;
  endSec: number;
  /** Why — surfaced in the UI so the behaviour is never a mystery. */
  reason: string;
}

/**
 * Decide the highlight window from a localization result.
 *
 * Three cases are deliberately LEFT UNCHANGED rather than trimmed:
 *   - nothing detected — we have no idea where the action is, and cutting blind
 *     is worse than not cutting;
 *   - a putt — the whole clip is the moment;
 *   - a clip already shorter than the highlight length.
 */
export function planHighlightTrim(r: HighlightInput): TrimPlan {
  const whole = (reason: string): TrimPlan => ({
    trim: false, startSec: 0, endSec: r.durationSec, reason,
  });
  if (r.decision !== 'SWING' || r.tImpact === undefined) {
    return whole('no swing detected — left unchanged');
  }
  if (r.strokeType === 'putt') return whole('putt — left unchanged');
  if (r.durationSec <= HIGHLIGHT_SECONDS) {
    return whole(`clip is ${r.durationSec.toFixed(1)}s — already under ${HIGHLIGHT_SECONDS}s`);
  }
  // Centre the window on impact, then SLIDE it fully inside the clip rather
  // than shortening it — a swing near either end still yields a full 5s.
  const start = Math.min(
    Math.max(r.tImpact - LEAD_IN_SECONDS, 0),
    r.durationSec - HIGHLIGHT_SECONDS
  );
  return {
    trim: true,
    startSec: start,
    endSec: start + HIGHLIGHT_SECONDS,
    reason: `swing at ${r.tImpact.toFixed(2)}s — trimmed to ${HIGHLIGHT_SECONDS}s`,
  };
}
