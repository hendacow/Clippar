/**
 * Pure logic for the Live round-setup flow (app/(tabs)/record.tsx).
 *
 * Two questions live here, both of which the setup screen used to answer
 * inline and only half-right:
 *
 *   1. WHICH START HOLES ARE VALID for a given hole count. The round model
 *      doesn't wrap — a round plays [startHole .. startHole + holesPlayed-1]
 *      (lib/liveRecordingLogic.lastHoleOf) — so a full 18 can only tee off on
 *      hole 1, and a back-nine (shotgun) start is a 9-hole round from 10.
 *      Picking 18 + hole 10 would score holes 19..27, which don't exist.
 *
 *   2. DO WE ALREADY KNOW THIS COURSE'S PARS. If we don't, starting the round
 *      stamps DEFAULT_PAR = 4 on every hole and that wrong scorecard is burned
 *      into the exported reel. So "Set the scorecard" gates Start Round for a
 *      course we have no hole data for — and ONLY for that case, because
 *      gating a course whose pars we already hold is friction for nothing.
 *
 * Storage-free / native-free so the node runner can exercise it directly
 * (tests/roundSetup.test.ts).
 */
import type { HoleData } from '@/types/round';
import {
  liveHoleNumbers,
  buildHoleDataFromPars,
  presetHasScorecard,
} from './scorecardLogic';

/** The shape of a saved preset this module needs. Structural (not the full
 *  CoursePreset) so tests can hand it a literal, and so callers can pass any
 *  row that carries these fields. */
export interface SetupPreset {
  course_id?: string | null;
  course_name: string;
  holes_played: 9 | 18;
  start_hole: 1 | 10;
  hole_pars: number[] | null;
  last_used_at?: string;
}

export interface StartHoleOption {
  value: 1 | 10;
  label: string;
}

/**
 * The start holes a round of this length can actually tee off on. 9 holes is
 * a real choice (front or back); 18 has exactly one valid answer because the
 * round doesn't wrap back to hole 1 — see the header note.
 */
export function startHoleOptions(holesPlayed: 9 | 18): StartHoleOption[] {
  if (holesPlayed === 9) {
    return [
      { value: 1, label: 'Hole 1' },
      { value: 10, label: 'Hole 10' },
    ];
  }
  return [{ value: 1, label: 'Hole 1' }];
}

/**
 * Force a start hole to one the count allows. Flipping 9 → 18 while "back 9"
 * is selected would otherwise carry a hole 10 start into an 18-hole round.
 */
export function normalizeStartHole(holesPlayed: 9 | 18, startHole: 1 | 10): 1 | 10 {
  return startHoleOptions(holesPlayed).some((o) => o.value === startHole)
    ? startHole
    : 1;
}

/** Same course? Ids win when both sides have one (names get re-typed and
 *  re-cased); otherwise fall back to a trimmed, case-insensitive name match,
 *  which is how the user's own saved scorecards are keyed. */
function isSameCourse(
  preset: SetupPreset,
  courseName: string,
  courseId?: string,
): boolean {
  if (courseId && preset.course_id) return preset.course_id === courseId;
  const a = preset.course_name.trim().toLowerCase();
  const b = courseName.trim().toLowerCase();
  return a.length > 0 && a === b;
}

/** Does this preset's saved scorecard cover every hole the round will play?
 *  hole_pars is positional from the PRESET's own start hole, so an 18-hole
 *  scorecard covers a back-nine round but a front-nine one does not. */
export function presetCoversRound(
  preset: SetupPreset,
  holesPlayed: 9 | 18,
  startHole: 1 | 10,
): boolean {
  if (!presetHasScorecard(preset)) return false;
  const covered = new Set(liveHoleNumbers(preset.holes_played, preset.start_hole));
  return liveHoleNumbers(holesPlayed, startHole).every((n) => covered.has(n));
}

/** Does the course hole data we fetched carry a par for every hole played?
 *  CourseSearch deliberately DROPS holes the API gave no par for rather than
 *  defaulting them to 4, so a partial list means partial knowledge. */
export function courseHolesCoverRound(
  courseHoles: readonly HoleData[] | undefined,
  holesPlayed: 9 | 18,
  startHole: 1 | 10,
): boolean {
  if (!courseHoles || courseHoles.length === 0) return false;
  const known = new Set(
    courseHoles.filter((h) => typeof h.par === 'number').map((h) => h.holeNumber),
  );
  return liveHoleNumbers(holesPlayed, startHole).every((n) => known.has(n));
}

export interface RoundSetup<T extends SetupPreset = SetupPreset> {
  courseName: string;
  courseId?: string;
  /** Hole data from the courses table / live API, if a course was picked. */
  courseHoles?: readonly HoleData[];
  /** The user's saved presets (course_presets rows). */
  presets: readonly T[];
  holesPlayed: 9 | 18;
  startHole: 1 | 10;
}

/**
 * The user's own saved scorecard for this course that covers this round, or
 * null. First match wins — the caller's list is most-recent-first.
 */
export function findSavedScorecard<T extends SetupPreset>(
  setup: RoundSetup<T>,
): T | null {
  return (
    setup.presets.find(
      (p) =>
        isSameCourse(p, setup.courseName, setup.courseId) &&
        presetCoversRound(p, setup.holesPlayed, setup.startHole),
    ) ?? null
  );
}

/** Do we hold a real par for every hole this round will play — from either
 *  the course data or one of the golfer's saved scorecards? */
export function isCourseKnown(setup: RoundSetup): boolean {
  return (
    courseHolesCoverRound(setup.courseHoles, setup.holesPlayed, setup.startHole) ||
    !!findSavedScorecard(setup)
  );
}

/**
 * Is the course known for ANY start hole this count allows? The setup screen
 * asks this, because it gates "Continue" BEFORE the golfer has said which nine
 * they're playing: a user whose only saved scorecard is the back nine must
 * still be able to reach the step where they'd choose hole 10. The exact
 * choice is then gated by startRoundGate on that step.
 */
export function isCourseKnownForAnyStart(setup: RoundSetup): boolean {
  return startHoleOptions(setup.holesPlayed).some((option) =>
    isCourseKnown({ ...setup, startHole: option.value }),
  );
}

/**
 * The hole data the round should actually start with. A saved scorecard wins
 * over the API's — that override is the whole point of saving one (the API's
 * par data is not trustworthy). undefined = we know nothing, which is what
 * the Start Round gate below refuses to let happen.
 */
export function resolveRoundHoles(setup: RoundSetup): HoleData[] | undefined {
  const saved = findSavedScorecard(setup);
  if (saved?.hole_pars) {
    return buildHoleDataFromPars(saved.hole_pars, saved.start_hole);
  }
  return setup.courseHoles && setup.courseHoles.length > 0
    ? [...setup.courseHoles]
    : undefined;
}

export type StartRoundGate =
  | { allowed: true }
  /** No course chosen/typed yet. */
  | { allowed: false; reason: 'no-course' }
  /** A course we have no pars for — the scorecard must be set first. */
  | { allowed: false; reason: 'unknown-course' };

/**
 * May the round start? Blocking the unknown-course case is what stops a reel
 * going out with a par 4 invented for all 18 holes.
 */
export function startRoundGate(setup: RoundSetup): StartRoundGate {
  if (!setup.courseName.trim()) return { allowed: false, reason: 'no-course' };
  if (!isCourseKnown(setup)) return { allowed: false, reason: 'unknown-course' };
  return { allowed: true };
}

/**
 * The presets to offer as one-tap "recent" setups, most recently used first
 * and capped so the horizontal row stays a glance, not a list. Rows without a
 * last_used_at keep their incoming order behind the dated ones.
 */
export function recentSetups<T extends SetupPreset>(
  presets: readonly T[],
  limit = 8,
): T[] {
  return presets
    .map((preset, index) => ({ preset, index }))
    .sort((a, b) => {
      const at = a.preset.last_used_at ?? '';
      const bt = b.preset.last_used_at ?? '';
      if (at === bt) return a.index - b.index;
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? 1 : -1;
    })
    .slice(0, limit)
    .map((e) => e.preset);
}
