import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampRecoveredPointer,
  insertClipInOrder,
  previousHoleTarget,
  resumeShotNumber,
  upsertHoleScore,
  findLastClipIndexOnHole,
  nextShotCounterAfterClip,
  departingHoleStrokes,
} from '../lib/liveRecordingLogic';

// Hole attribution: "when I record on that first hole it won't actually add
// those videos to the hole chosen." These tests lock down the pure logic
// behind the fixes — resumed-round pointer clamping, restore-in-order for the
// undo, and a hand-simulated round that walks holes with Prev/Next and checks
// every clip lands on the hole that was on screen when it was recorded.

// ── clampRecoveredPointer ────────────────────────────────────────────────────

test('clampRecoveredPointer: a back-nine round persisted as hole 1 resumes on hole 10', () => {
  // The pre-fix bug: saveLocalRound never wrote current_hole, so the column
  // default (1) came back for a round that started on hole 10.
  const p = clampRecoveredPointer(1, 3, 9, 10);
  assert.equal(p.hole, 10);
  // Shot counter belonged to the wrong hole → caller must re-derive it.
  assert.equal(p.shot, null);
});

test('clampRecoveredPointer: an in-range pointer is trusted verbatim', () => {
  const p = clampRecoveredPointer(13, 4, 9, 10);
  assert.equal(p.hole, 13);
  assert.equal(p.shot, 4);
});

test('clampRecoveredPointer: a hole past the end of the round clamps to the last hole', () => {
  assert.equal(clampRecoveredPointer(19, 2, 18, 1).hole, 18);
  assert.equal(clampRecoveredPointer(19, 2, 9, 10).hole, 18);
  assert.equal(clampRecoveredPointer(12, 2, 9, 1).hole, 9);
});

test('clampRecoveredPointer: missing/zero values fall back to the start hole and re-derive the shot', () => {
  assert.deepEqual(clampRecoveredPointer(null, null, 18, 1), { hole: 1, shot: null });
  assert.deepEqual(clampRecoveredPointer(undefined, 0, 9, 10), { hole: 10, shot: null });
});

test('clampRecoveredPointer: a shot counter below 1 is floored', () => {
  assert.equal(clampRecoveredPointer(5, -2, 18, 1).shot, 1);
  assert.equal(clampRecoveredPointer(5, 1, 18, 1).shot, 1);
});

// ── insertClipInOrder (Restore deleted shot) ─────────────────────────────────

const clip = (holeNumber: number, shotNumber: number, id: number) => ({
  holeNumber,
  shotNumber,
  id,
});

test('insertClipInOrder: a restored earlier-hole shot goes back in its own place', () => {
  const clips = [clip(3, 1, 1), clip(4, 1, 3), clip(4, 2, 4)];
  const restored = insertClipInOrder(clips, clip(3, 2, 2));
  assert.deepEqual(
    restored.map((c) => `${c.holeNumber}.${c.shotNumber}`),
    ['3.1', '3.2', '4.1', '4.2']
  );
});

test('insertClipInOrder: restoring the round’s latest shot still appends', () => {
  const clips = [clip(3, 1, 1), clip(3, 2, 2)];
  const restored = insertClipInOrder(clips, clip(3, 3, 3));
  assert.deepEqual(restored.map((c) => c.id), [1, 2, 3]);
});

test('insertClipInOrder: does not mutate the original array', () => {
  const clips = [clip(3, 1, 1)];
  insertClipInOrder(clips, clip(3, 2, 2));
  assert.equal(clips.length, 1);
});

// ── nextShotCounterAfterClip / departingHoleStrokes (the glue decisions) ─────

test('nextShotCounterAfterClip: advances only when the clip is on the current hole', () => {
  assert.equal(nextShotCounterAfterClip(3, 5, 5), 4); // same hole → +1
  assert.equal(nextShotCounterAfterClip(3, 4, 5), 3); // clip landed for a hole we left → unchanged
});

test('departingHoleStrokes: commits only a hole that saw activity', () => {
  assert.equal(departingHoleStrokes(1), null); // fresh hole, no shots
  assert.equal(departingHoleStrokes(2), 1); // 1 shot
  assert.equal(departingHoleStrokes(6), 5); // 3 shots + 2 penalty strokes
});

// ── Simulated round: Prev/Next navigation + hole attribution ─────────────────

/**
 * A minimal stand-in for the live round state machine. The bug-carrying
 * DECISIONS are the real imported functions — clampRecoveredPointer,
 * resumeShotNumber, upsertHoleScore, previousHoleTarget, findLastClipIndexOnHole,
 * nextShotCounterAfterClip (recordClip's hole-aware counter) and
 * departingHoleStrokes (previousHole's penalty-preserving commit). This harness
 * is only the orchestration around them, so a regression re-introduced into
 * those functions in useRound would fail here.
 */
function simulateRound(startHole: 1 | 10, holesPlayed: 9 | 18) {
  const state = {
    currentHole: startHole as number,
    currentShot: 1,
    clips: [] as { holeNumber: number; shotNumber: number; id: number }[],
    scores: [] as { holeNumber: number; strokes: number; par: number }[],
    nextId: 1,
  };

  return {
    state,
    /** Record a shot: hole+shot latched now, clip lands `lagShots` later. */
    record(lagActions: (() => void)[] = []) {
      const hole = state.currentHole;
      const shot = state.currentShot;
      // Anything the user does while the clip is still saving.
      for (const action of lagActions) action();
      const landed = { holeNumber: hole, shotNumber: shot, id: state.nextId++ };
      state.clips = [...state.clips, landed];
      // Hole-aware counter — the REAL decision from useRound.recordClip.
      state.currentShot = nextShotCounterAfterClip(
        state.currentShot,
        landed.holeNumber,
        state.currentHole
      );
      return landed;
    },
    penalty(strokes = 1) {
      state.currentShot += strokes;
    },
    nextHole() {
      const strokes = Math.max(1, state.currentShot - 1);
      state.scores = upsertHoleScore(state.scores, {
        holeNumber: state.currentHole,
        strokes,
        par: 4,
      });
      state.currentHole += 1;
      state.currentShot = resumeShotNumber(state.scores, state.clips, state.currentHole);
    },
    previousHole() {
      const target = previousHoleTarget(state.currentHole, startHole);
      if (target === null) return false;
      // Commit the departing hole's strokes so penalties survive — the REAL
      // decision from useRound.previousHole.
      const departingStrokes = departingHoleStrokes(state.currentShot);
      if (departingStrokes !== null) {
        state.scores = upsertHoleScore(state.scores, {
          holeNumber: state.currentHole,
          strokes: departingStrokes,
          par: 4,
        });
      }
      state.currentHole = target;
      state.currentShot = resumeShotNumber(state.scores, state.clips, target);
      return true;
    },
    deleteLastOnCurrentHole() {
      const idx = findLastClipIndexOnHole(state.clips, state.currentHole);
      if (idx < 0) return null;
      const [removed] = state.clips.splice(idx, 1);
      state.currentShot = Math.max(1, state.currentShot - 1);
      return removed;
    },
    holesOf(hole: number) {
      return state.clips.filter((c) => c.holeNumber === hole);
    },
  };
}

test('front-nine: shots recorded on hole 1 stay on hole 1 after moving on', () => {
  const r = simulateRound(1, 18);
  r.record();
  r.record();
  r.nextHole();
  r.record();
  assert.equal(r.holesOf(1).length, 2);
  assert.equal(r.holesOf(2).length, 1);
});

test('back-nine: the first hole of the round is 10, not 1', () => {
  const r = simulateRound(10, 9);
  r.record();
  r.record();
  assert.equal(r.holesOf(10).length, 2);
  assert.equal(r.holesOf(1).length, 0);
  assert.deepEqual(r.holesOf(10).map((c) => c.shotNumber), [1, 2]);
});

test('back-nine: Previous Hole cannot step below hole 10', () => {
  const r = simulateRound(10, 9);
  assert.equal(r.previousHole(), false);
  assert.equal(r.state.currentHole, 10);
});

test('Previous Hole then record: the clip lands on the hole gone back to', () => {
  const r = simulateRound(1, 18);
  r.record(); // hole 1, shot 1
  r.nextHole(); // → hole 2
  r.record(); // hole 2, shot 1
  r.previousHole(); // → back to hole 1
  const c = r.record(); // must be hole 1
  assert.equal(c.holeNumber, 1);
  // And it must not collide with the shot already on hole 1.
  assert.deepEqual(r.holesOf(1).map((x) => x.shotNumber), [1, 2]);
  assert.equal(r.holesOf(2).length, 1);
});

test('Previous Hole preserves penalty strokes on the hole being left', () => {
  const r = simulateRound(1, 18);
  r.record(); // hole 1 shot 1
  r.record(); // hole 1 shot 2
  r.record(); // hole 1 shot 3 → currentShot 4
  r.penalty(2); // water hazard → currentShot 6, i.e. 5 strokes
  r.previousHole(); // no earlier hole → refused, nothing lost
  assert.equal(r.state.currentShot, 6);

  r.nextHole(); // hole 1 scored 5, → hole 2
  r.record(); // hole 2 shot 1
  r.penalty(1); // → 2 strokes so far on hole 2
  r.previousHole(); // ← the case that used to drop the penalty
  assert.equal(r.state.currentHole, 1);

  r.nextHole(); // re-end hole 1, back to hole 2
  assert.equal(r.state.currentHole, 2);
  // Hole 2's committed strokes (2: one shot + one penalty) survived the trip,
  // so the next shot is numbered 3 rather than reusing 2.
  assert.equal(r.state.currentShot, 3);
  const score2 = r.state.scores.find((s) => s.holeNumber === 2);
  assert.equal(score2?.strokes, 2);
});

test('a clip that lands after the user has moved holes keeps its own hole and leaves the new hole’s counter alone', () => {
  const r = simulateRound(1, 18);
  r.record(); // hole 1 shot 1
  // Start a shot on hole 1, but the save completes only after Next Hole.
  const late = r.record([() => r.nextHole()]);
  assert.equal(late.holeNumber, 1, 'late clip belongs to the hole it was shot on');
  assert.equal(r.state.currentHole, 2);
  // Hole 2 has no footage yet, so its next shot must still be shot 1.
  assert.equal(r.state.currentShot, 1);
  assert.equal(r.holesOf(1).length, 2);
  assert.equal(r.holesOf(2).length, 0);
});

test('Delete last shot targets the CURRENT hole, not the round’s last shot', () => {
  const r = simulateRound(1, 18);
  r.record(); // hole 1 shot 1
  r.record(); // hole 1 shot 2
  r.nextHole(); // → hole 2
  r.record(); // hole 2 shot 1
  r.record(); // hole 2 shot 2 (the round's most recent shot)
  r.nextHole(); // → hole 3
  r.record(); // hole 3 shot 1
  r.previousHole(); // ← user steps back to hole 2... via 3→2
  assert.equal(r.state.currentHole, 2);

  const removed = r.deleteLastOnCurrentHole();
  assert.equal(removed?.holeNumber, 2, 'deletes hole 2’s last shot');
  assert.equal(r.holesOf(2).length, 1);
  assert.equal(r.holesOf(3).length, 1, 'hole 3’s footage untouched');
  assert.equal(r.holesOf(1).length, 2, 'hole 1’s footage untouched');
});

test('Delete last shot on a hole with no footage is a no-op', () => {
  const r = simulateRound(1, 18);
  r.record();
  r.nextHole();
  assert.equal(r.deleteLastOnCurrentHole(), null);
  assert.equal(r.holesOf(1).length, 1);
});

test('restore after delete puts the clip back on its own hole, in order', () => {
  const r = simulateRound(1, 18);
  r.record(); // 1.1
  r.record(); // 1.2
  r.nextHole();
  r.record(); // 2.1
  r.previousHole(); // back to hole 1
  const removed = r.deleteLastOnCurrentHole(); // removes 1.2
  assert.ok(removed);
  assert.deepEqual(
    r.state.clips.map((c) => `${c.holeNumber}.${c.shotNumber}`),
    ['1.1', '2.1']
  );

  const restored = insertClipInOrder(r.state.clips, removed!);
  assert.deepEqual(
    restored.map((c) => `${c.holeNumber}.${c.shotNumber}`),
    ['1.1', '1.2', '2.1']
  );
});
