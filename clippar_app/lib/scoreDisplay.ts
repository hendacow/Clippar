/**
 * Score display rules shared by the round scorecard
 * (components/round/Scorecard.tsx) and the round-preview overlay
 * (app/round/preview.tsx).
 *
 * Pure and native-free so the node test runner can exercise it directly
 * (tests/scoreDisplay.test.ts).
 *
 * The one rule that matters: a hole shows NO score indication until it is
 * actually finished. "Finished" is a data fact, not a playback position —
 * a scores row is written only when a hole is ended (hooks/useRound.ts:
 * endHole / pickup / next-hole commit), and useEditorState carries that
 * fact as `hasScore` on each EditorHoleSection. When `hasScore` is false,
 * `strokes` is only the clip-count fallback and must never be shown as a
 * score, nor leak into a total.
 */
import { theme } from '@/constants/theme';

export interface DisplayHole {
  par: number;
  strokes: number;
  /** True only when a real score row exists — i.e. the hole was ended. */
  hasScore: boolean;
}

/** Colour for a score relative to par — the established scorecard mapping. */
export function getScoreColor(diff: number): string {
  if (diff <= -2) return theme.colors.eagle;
  if (diff === -1) return theme.colors.birdie;
  if (diff === 0) return theme.colors.par;
  if (diff === 1) return theme.colors.bogey;
  return theme.colors.doubleBogey;
}

/** Subtle cell background matching getScoreColor. */
export function getScoreBg(diff: number): string {
  if (diff <= -2) return 'rgba(255, 215, 0, 0.15)';
  if (diff === -1) return 'rgba(76, 175, 80, 0.15)';
  if (diff === 0) return 'transparent';
  if (diff === 1) return 'rgba(255, 152, 0, 0.15)';
  return 'rgba(255, 68, 68, 0.15)';
}

/** "E" at level par, signed number otherwise. */
export function formatDiff(diff: number): string {
  if (diff === 0) return 'E';
  if (diff > 0) return `+${diff}`;
  return `${diff}`;
}

/** "Birdie"/"Bogey"-style name for a single finished hole's result. */
export function holeResultLabel(diff: number): string {
  if (diff === -3) return 'Albatross';
  if (diff === -2) return 'Eagle';
  if (diff === -1) return 'Birdie';
  if (diff === 0) return 'Par';
  if (diff === 1) return 'Bogey';
  if (diff === 2) return 'Double Bogey';
  return formatDiff(diff);
}

/** A hole may show its score only once it has actually been finished. */
export function isHoleComplete(hole: Pick<DisplayHole, 'hasScore'>): boolean {
  return hole.hasScore;
}

/**
 * Round total over COMPLETED holes only. Returns null when no hole is
 * finished yet — the card shows "-" and no +/- chip. A running total for
 * an unfinished hole is never included.
 */
export function completedTotals(
  holes: readonly DisplayHole[],
): { strokes: number; par: number; diff: number; holesCompleted: number } | null {
  const done = holes.filter(isHoleComplete);
  if (done.length === 0) return null;
  const strokes = done.reduce((sum, h) => sum + h.strokes, 0);
  const par = done.reduce((sum, h) => sum + h.par, 0);
  return { strokes, par, diff: strokes - par, holesCompleted: done.length };
}
