/**
 * Highlight trim policy — pure, no native imports.
 *
 * Kept out of index.ts so it runs under `node --test` without expo-modules-core,
 * exactly like experiments/vision-swing-classifier/swingVisionLogic.ts. The
 * decision of what a user ends up watching is worth testing on its own.
 */

/** Total length of the trimmed highlight. DEFAULT ONLY — the app passes its own
 *  window, which the user can change in Profile → Trim settings. */
export const HIGHLIGHT_SECONDS = 5.0;
/** How much of that sits BEFORE impact — enough to see the backswing, leaving
 *  the remainder for the strike and the ball flight, which is the part worth
 *  watching. DEFAULT ONLY, same as above. */
export const LEAD_IN_SECONDS = 2.0;

/** Window override. Without this the policy would silently replace whatever the
 *  user configured with its own 5s — the app's own default is 4s (2.5s before
 *  impact, 1.5s after), so ignoring it is a visible change nobody asked for. */
export interface TrimWindow {
  /** Seconds kept BEFORE impact. */
  leadInSec?: number;
  /** Total clip length in seconds. */
  totalSec?: number;
}

/** The minimum a localization result must provide to plan a trim. */
export interface HighlightInput {
  decision: 'SWING' | 'NO_SWING';
  strokeType?: 'swing' | 'putt';
  tImpact?: number;
  durationSec: number;
  /** Present when body pose decided the stroke type; absent when it could not
   *  lock on and motion amplitude was the fallback. Only affects the `reason`
   *  string — see the note on honest wording in planHighlightTrim. */
  wristHeight?: number;
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
export function planHighlightTrim(r: HighlightInput, w: TrimWindow = {}): TrimPlan {
  const total = w.totalSec ?? HIGHLIGHT_SECONDS;
  const leadIn = Math.min(w.leadInSec ?? LEAD_IN_SECONDS, total);
  const whole = (reason: string): TrimPlan => ({
    trim: false, startSec: 0, endSec: r.durationSec, reason,
  });
  if (r.decision !== 'SWING' || r.tImpact === undefined) {
    return whole('no swing detected — left unchanged');
  }
  if (r.strokeType === 'putt') {
    // Be honest about which signal said so. 'putt' is a residue label: with no
    // body to measure, anything whose motion is too small to be a shot lands
    // here, including footage with no golf in it at all. Claiming "putt" for
    // that reads as a detection when it was a failure to detect. The ACTION is
    // identical either way, so only the wording changes.
    return whole(
      r.wristHeight === undefined
        ? 'no shot detected — left unchanged'
        : 'putt — left unchanged',
    );
  }
  if (r.durationSec <= total) {
    return whole(`clip is ${r.durationSec.toFixed(1)}s — already under ${total}s`);
  }
  // Centre the window on impact, then SLIDE it fully inside the clip rather
  // than shortening it — a swing near either end still yields a full window.
  const start = Math.min(
    Math.max(r.tImpact - leadIn, 0),
    r.durationSec - total
  );
  return {
    trim: true,
    startSec: start,
    endSec: start + total,
    reason: `swing at ${r.tImpact.toFixed(2)}s — trimmed to ${total}s`,
  };
}
