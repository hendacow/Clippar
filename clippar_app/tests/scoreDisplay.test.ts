import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getScoreColor,
  getScoreBg,
  formatDiff,
  holeResultLabel,
  isHoleComplete,
  completedTotals,
} from '../lib/scoreDisplay';
import { theme } from '../constants/theme';

// The round-preview scorecard used to reveal a hole's score based on WHERE
// PLAYBACK WAS (hole number below the current clip's hole, or last shot of
// the current hole) — and, worse, `strokes` for an unfinished hole is just
// the clip-count fallback from buildHoleSections. Henry's rule is simpler:
// a hole shows NO score indication until it is finished, then it shows the
// score colour-coded exactly like the real scorecard. "Finished" is a data
// fact — a scores row is written only when a hole is ended (useRound's
// endHole / pickup / next-hole commit), carried as `hasScore`.
//
// These tests pin the two halves that rule needs:
//   1. completion comes from hasScore, never from stroke counts, so a
//      mid-hole clip count can never masquerade as a score;
//   2. TOTAL sums completed holes only, and admits it knows nothing
//      (null → "-") until at least one hole is finished.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const hole = (par: number, strokes: number, hasScore: boolean) => ({
  par,
  strokes,
  hasScore,
});

// ─── Completion is a data fact, not a stroke count ───

test('an unfinished hole shows no score, even with clips already recorded', () => {
  // strokes=3 here is the clip-count fallback, not a score
  assert.equal(isHoleComplete(hole(4, 3, false)), false);
});

test('a finished hole shows its score', () => {
  assert.equal(isHoleComplete(hole(4, 5, true)), true);
});

// ─── Colours match the round scorecard exactly ───

test('score colours are the established scorecard mapping', () => {
  assert.equal(getScoreColor(-3), theme.colors.eagle);
  assert.equal(getScoreColor(-2), theme.colors.eagle);
  assert.equal(getScoreColor(-1), theme.colors.birdie);
  assert.equal(getScoreColor(0), theme.colors.par);
  assert.equal(getScoreColor(1), theme.colors.bogey);
  assert.equal(getScoreColor(2), theme.colors.doubleBogey);
  assert.equal(getScoreColor(5), theme.colors.doubleBogey);
});

test('par gets no background tint; every other result gets one', () => {
  assert.equal(getScoreBg(0), 'transparent');
  for (const diff of [-2, -1, 1, 2]) {
    assert.notEqual(getScoreBg(diff), 'transparent');
  }
});

test('diff formatting: E at level, signed otherwise', () => {
  assert.equal(formatDiff(0), 'E');
  assert.equal(formatDiff(2), '+2');
  assert.equal(formatDiff(-1), '-1');
});

test('hole results carry their golf names', () => {
  assert.equal(holeResultLabel(-3), 'Albatross');
  assert.equal(holeResultLabel(-2), 'Eagle');
  assert.equal(holeResultLabel(-1), 'Birdie');
  assert.equal(holeResultLabel(0), 'Par');
  assert.equal(holeResultLabel(1), 'Bogey');
  assert.equal(holeResultLabel(2), 'Double Bogey');
  assert.equal(holeResultLabel(3), '+3');
});

// ─── TOTAL reflects completed holes only ───

test('TOTAL knows nothing until at least one hole is finished', () => {
  assert.equal(completedTotals([]), null);
  assert.equal(
    completedTotals([hole(4, 2, false), hole(4, 3, false)]),
    null,
  );
});

test('an in-progress hole never leaks into the total', () => {
  const totals = completedTotals([
    hole(4, 5, true), // bogey, finished
    hole(3, 3, true), // par, finished
    hole(4, 2, false), // mid-hole: 2 clips so far — must not count
  ]);
  assert.deepEqual(totals, { strokes: 8, par: 7, diff: 1, holesCompleted: 2 });
});

test('a finished round totals every hole', () => {
  const totals = completedTotals([
    hole(4, 3, true), // birdie
    hole(3, 3, true), // par
    hole(5, 7, true), // double
  ]);
  assert.deepEqual(totals, { strokes: 13, par: 12, diff: 1, holesCompleted: 3 });
});

// ─── The screens actually use these rules ───

test('the preview scorecard derives completion from data, not playback position', () => {
  const src = read('app/round/preview.tsx');
  assert.match(src, /from '@\/lib\/scoreDisplay'/);
  // The old playback-position reveal and its ad-hoc colours must be gone.
  assert.doesNotMatch(src, /isLastShotOfHole/);
  assert.doesNotMatch(src, /#4ADE80|#FF7366/);
});

test('the round scorecard shares the same colour source', () => {
  const src = read('components/round/Scorecard.tsx');
  assert.match(src, /from '@\/lib\/scoreDisplay'/);
});

test('useEditorState derives hasScore from the existence of a score row', () => {
  const src = read('hooks/useEditorState.ts');
  assert.match(src, /hasScore: !!score/);
});
