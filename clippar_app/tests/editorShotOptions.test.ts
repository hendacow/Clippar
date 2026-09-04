import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const storage = readFileSync(join(root, 'lib/storage.ts'), 'utf8');
const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
const state = readFileSync(join(root, 'hooks/useEditorState.ts'), 'utf8');
const editor = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
const modal = readFileSync(join(root, 'components/editor/ClipTrimModal.tsx'), 'utf8');

// Henry, 4 Sep: six shots minus shot two read "1, 3, 4, 5, 6" and the scorecard
// still said six. Delete must close the gap and drop the score by one; restore
// must give both back.
test('deleting a shot renumbers the hole and drops its score by one', () => {
  assert.match(storage, /export async function renumberHoleShots/);
  assert.match(storage, /export async function adjustHoleStrokes/);
  assert.match(storage, /SET strokes = MAX\(0, strokes \+ \?\)/, 'floors at zero');
  const del = bin.slice(bin.indexOf('export async function deleteClipToBin'), bin.indexOf('export async function restoreClipFromBin'));
  assert.match(del, /renumberHoleShots\(roundId, row\.hole_number\)/);
  assert.match(del, /adjustHoleStrokes\(roundId, row\.hole_number, -1\)/);
  const res = bin.slice(bin.indexOf('export async function restoreClipFromBin'), bin.indexOf('async function purgeEntry'));
  assert.match(res, /adjustHoleStrokes\(entry\.roundId, entry\.row\.hole_number, \+1\)/);
  // and the in-memory editor state mirrors it without a reload
  const rm = state.slice(state.indexOf('const removeClip = useCallback'), state.indexOf('const undoRemoveClip'));
  assert.match(rm, /shotNumber: i \+ 1/);
  assert.match(rm, /Math\.max\(0, h\.strokes - 1\)/);
});

test('a shot can be given a different number on its hole, and it persists', () => {
  assert.match(state, /const setClipShotNumber = useCallback/);
  assert.match(state, /storage\.writeHoleShotOrder\(state\.roundId, holeNumber, ids\)/);
  assert.match(storage, /export async function writeHoleShotOrder/);
  assert.match(storage, /SET shot_number = \?, sort_order = \?/, 'both columns move together');
  assert.match(editor, /Shot number on this hole/);
  assert.match(editor, /editor\.setClipShotNumber\(movingClip\.id, num\)/);
});

test('every shot has a visible Options button; the hold is only a shortcut', () => {
  assert.match(editor, /<MoreHorizontal size=\{14\}/);
  assert.match(editor, />Options<\/Text>/);
  assert.match(editor, /\{optionsButton\}/);
});

test('the trimmer swipes between shots on the hole, applying the trim first', () => {
  assert.match(modal, /Gesture\.Fling\(\)\.direction\(Directions\.LEFT\)/);
  assert.match(modal, /Gesture\.Fling\(\)\.direction\(Directions\.RIGHT\)/);
  assert.match(modal, /<GestureHandlerRootView style=\{\{ flex: 1 \}\}>/, 'a Modal needs its own gesture root');
  assert.match(modal, /onNavigate\(dir, finalStart, finalEnd\)/, 'trim handed back before moving');
  assert.match(editor, /editor\.updateTrim\(trimClip\.id, startMs, endMs\);\s*Haptics\.selectionAsync\(\);\s*setTrimClip\(next\);/);
  assert.match(editor, /Shot \$\{i \+ 1\} of \$\{clips\.length\}/);
});
