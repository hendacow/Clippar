/**
 * What the app does with a detected shot — the one place that decides.
 *
 * WHY THIS EXISTS. On 2026-08-05 putts were changed to keep the whole
 * recording (a window centred on impact cuts off the ball travelling to the
 * hole). That is the right rule. Applying it to `shotType === 'putt'` alone
 * was not, and it left roughly half of a real 36-clip round uncut.
 *
 * The reason is that `shotType` is two different qualities of answer wearing
 * one name:
 *
 *   - The POSE state machine actually watches the swing and reports from
 *     confidence 0.6 upward. That is a classification.
 *   - `fallbackClassify` runs when pose finds nothing and guesses from clip
 *     duration and audio transients. Every branch of it returns 0.20–0.35 —
 *     including `durationLong`, which calls ANY recording over 12 seconds a
 *     putt on length alone (ShotDetectorModule.swift ~:1461). That is not a
 *     classification, it is a shrug.
 *
 * A shrug must not decide whether a golfer's shot gets trimmed. So keeping
 * the full recording requires a putt the detector genuinely saw; everything
 * else is trimmed to the user's window, which is what the app did before and
 * what it does well.
 */

/**
 * Lowest confidence that means "the detector actually classified this",
 * rather than "the detector gave up and guessed from the clip's length".
 *
 * 0.5 sits in the empty gap between the two: the fallback's ceiling is 0.35,
 * the pose state machine's floor is 0.6. Nothing in the codebase emits a
 * value in between, so this threshold cannot split a real classification.
 */
export const REAL_CLASSIFICATION_MIN_CONFIDENCE = 0.5;

export interface ShotOutcomeLike {
  found: boolean;
  shotType?: string | null;
  confidence?: number | null;
}

/**
 * True when the detector genuinely classified the shot, false when the
 * result came from the duration/audio fallback.
 */
export function isConfidentClassification(outcome: ShotOutcomeLike): boolean {
  const c = outcome.confidence;
  return typeof c === 'number' && Number.isFinite(c) && c >= REAL_CLASSIFICATION_MIN_CONFIDENCE;
}

/**
 * True when the clip should be left at its full recorded length instead of
 * trimmed to the user's window.
 *
 * Only a CONFIDENTLY detected putt qualifies. A low-confidence "putt" is the
 * fallback guessing from duration, and trimming it to the requested window is
 * both what the user asked for and what the app did before putts were given
 * their own path.
 */
export function shouldKeepFullRecording(outcome: ShotOutcomeLike): boolean {
  if (!outcome.found) return false;
  if (outcome.shotType !== 'putt') return false;
  return isConfidentClassification(outcome);
}
