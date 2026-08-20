/**
 * Pure logic for custom course-scorecard bookmarks (per-hole par override).
 *
 * Deliberately storage-free / native-free so the node test runner can
 * exercise it directly (tests/scorecardLogic.test.ts). The UI glue lives in
 * components/record/ScorecardSetupScreen.tsx and the round-start wiring in
 * app/(tabs)/record.tsx + app/round/import.tsx.
 *
 * A "scorecard" is a POSITIONAL per-hole par array of length holes_played.
 * Element i is the par of the i-th hole played, so it reattaches to real
 * hole numbers via the round's start hole (see buildHoleDataFromPars). For
 * the common front-nine / 18-hole case (start_hole = 1) that reduces to the
 * intuitive mapping: hole number N → holePars[N-1].
 */
import type { HoleData } from '@/types/round';

/** The par values the entry UI offers as big tappable buttons. */
export const PAR_OPTIONS = [3, 4, 5] as const;

/** Persisted par bounds — matches the DB CHECK in migration 014. The UI only
 *  offers 3/4/5, but 3..6 is accepted so an odd par-6 still round-trips. */
export const MIN_HOLE_PAR = 3;
export const MAX_HOLE_PAR = 6;

/**
 * The hole numbers a live round plays, in play order, wrapping after 18.
 * 18 from 1 → 1..18; 9 from 1 → 1..9; 9 from 10 → 10..18; and 18 from the
 * 10th tee (shotgun/back start) → [10..18, 1..9]. Must stay in lockstep with
 * liveRecordingLogic.orderedHoleNumbers — same formula, same wrap.
 */
export function liveHoleNumbers(holesPlayed: 9 | 18, startHole: 1 | 10): number[] {
  return Array.from({ length: holesPlayed }, (_, i) => ((startHole - 1 + i) % 18) + 1);
}

/**
 * What we know about whether a hole was actually played. `strokes` is the
 * golfer's score (undefined/null when they never scored it), `clipCount` how
 * many clips were filmed on it.
 */
export interface HolePlayEvidence {
  strokes?: number | null;
  clipCount?: number | null;
}

/**
 * True when there is any evidence the golfer played this hole.
 *
 * The asymmetry here is deliberate and load-bearing: a hole with a score but
 * NO clips is a real played hole (you don't film every hole) and must survive
 * to the scorecard; a hole with clips but no score is likewise real. Only a
 * hole with neither — the ones you walk past on a shotgun start, or skip when
 * the group behind is pushing — was never played and must not render. The
 * scorecard is burned into the exported reel, so a hole dropped here is a hole
 * the golfer loses from their round for good.
 */
export function holeWasPlayed(hole: HolePlayEvidence): boolean {
  return (hole.strokes ?? 0) > 0 || (hole.clipCount ?? 0) > 0;
}

/**
 * The played subset of a hole list, in the order given (so a round that starts
 * on 10 and wraps to 1..9 keeps its play order, not numeric order).
 */
export function playedHoles<T extends HolePlayEvidence>(
  holes: readonly T[],
): T[] {
  return holes.filter(holeWasPlayed);
}

/**
 * Build the authoritative HoleData[] from a positional per-hole par array.
 * Element i maps to holeNumber = startHole + i, so the resolved par lines up
 * with the hole numbers the round actually scores (getParForHole looks up by
 * holeNumber). For startHole = 1 this is holeNumber i → holePars[i-1].
 */
export function buildHoleDataFromPars(
  holePars: readonly number[],
  startHole: 1 | 10 = 1,
): HoleData[] {
  return holePars.map((par, i) => ({ holeNumber: startHole + i, par }));
}

/**
 * True when a preset carries a usable custom scorecard: hole_pars present and
 * its length matches holes_played (guards a partially-written / stale row).
 * Callers use this to decide whether to override the API par and to badge the
 * preset as a saved scorecard in the picker.
 */
export function presetHasScorecard(preset: {
  hole_pars: number[] | null;
  holes_played: number;
}): boolean {
  return (
    Array.isArray(preset.hole_pars) &&
    preset.hole_pars.length === preset.holes_played
  );
}

/**
 * Index of the next hole still needing a par, scanning forward from `from`
 * and wrapping once so the last-entered hole hands off to any earlier gap.
 * Returns null when every hole is filled. Drives the entry screen's
 * auto-advance.
 */
export function nextUnfilledIndex(
  pars: readonly (number | null)[],
  from: number,
): number | null {
  const n = pars.length;
  if (n === 0) return null;
  for (let k = 1; k <= n; k++) {
    const idx = (from + k) % n;
    if (pars[idx] == null) return idx;
  }
  // Every other hole is filled; the only remaining gap may be `from` itself.
  return pars[from] == null ? from : null;
}

/** Every hole has a chosen par (and there is at least one hole). */
export function isScorecardComplete(pars: readonly (number | null)[]): boolean {
  return pars.length > 0 && pars.every((p) => p != null);
}

/**
 * Validate a positional par array for persistence. Returns a clean number[]
 * when every element is an integer in [MIN_HOLE_PAR, MAX_HOLE_PAR] and the
 * length matches holes_played; otherwise null so the caller refuses to save
 * a malformed scorecard (which the DB CHECK would reject anyway).
 */
export function sanitizeHolePars(
  pars: readonly (number | null)[],
  holesPlayed: number,
): number[] | null {
  if (pars.length !== holesPlayed) return null;
  const out: number[] = [];
  for (const p of pars) {
    if (
      p == null ||
      !Number.isInteger(p) ||
      p < MIN_HOLE_PAR ||
      p > MAX_HOLE_PAR
    ) {
      return null;
    }
    out.push(p);
  }
  return out;
}

/** Sum of a par array — the total_par a saved scorecard implies. */
export function totalParOf(holePars: readonly number[]): number {
  return holePars.reduce((sum, p) => sum + p, 0);
}

/**
 * Decide whether saving a scorecard under `name` should UPDATE an existing
 * preset or INSERT a new one. Returns the user's preset that a save would
 * collide with on the DB's UNIQUE(user_id, name) key — so the caller can
 * overwrite it in place (letting the user iterate on a saved scorecard, e.g.
 * fix a wrong par) instead of hitting the duplicate-name error — or null when
 * the name is new. Matches the stored name exactly after trimming both sides,
 * mirroring the case-sensitive DB constraint (a differently-cased name is a
 * distinct preset, not a collision). Blank names never match.
 */
export function findPresetToUpdate<T extends { name: string }>(
  presets: readonly T[],
  name: string,
): T | null {
  const target = name.trim();
  if (!target) return null;
  return presets.find((p) => p.name.trim() === target) ?? null;
}
