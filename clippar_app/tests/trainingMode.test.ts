import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const training = readFileSync(join(root, 'lib/training.ts'), 'utf8');
const record = readFileSync(join(root, 'app/training/record.tsx'), 'utf8');
const play = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');
const hub = readFileSync(join(root, 'app/training/index.tsx'), 'utf8');
const editor = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
const chooser = readFileSync(join(root, 'app/(tabs)/record.tsx'), 'utf8');

// The load-bearing trick: clubs ARE holes. If two clubs ever share a
// holeNumber, their shots merge irreversibly in every session ever recorded.
test('every club maps to a unique, stable hole number', () => {
  const nums = [...training.matchAll(/holeNumber: (\d+)/g)].map((m) => parseInt(m[1], 10));
  assert.ok(nums.length >= 14, 'a full bag of clubs');
  assert.equal(new Set(nums).size, nums.length, 'no two clubs share a hole number');
});

test('the mapping is documented as append-only', () => {
  assert.match(training, /append-only/i);
});

// A practice session must never surface in the orphaned-round recovery card:
// its Resume treats the session as a live round and its Discard deletes the
// practice clips.
test('sessions are born finished so the orphan-recovery card ignores them', () => {
  assert.match(training, /status: 'finished'/);
  assert.match(training, /startTrainingSession/);
});

// The capture screen inherits the live pipeline rather than forking it.
test('training capture records through the same useCamera pipeline as live', () => {
  assert.match(record, /useCamera\(\{/);
  assert.match(record, /holeNumber: club\.holeNumber/);
});

// Same discipline as record.tsx: no mutation while a clip is saving.
test('club switch, delete, review and end are all gated on recordingBusy', () => {
  assert.match(record, /const recordingBusy = camera\.isRecording \|\| camera\.isFinalizing;/);
  for (const fn of ['switchClub', 'handleDeleteLast', 'handleReview', 'handleEnd']) {
    const body = record.match(new RegExp(`const ${fn} = useCallback\\(([\\s\\S]*?)\\n  \\);`))?.[1] ?? '';
    assert.match(body, /recordingBusy/, `${fn} must check recordingBusy`);
  }
});

// Deleting at the range goes through the same recoverable bin as the editor.
test('delete last shot is recoverable, not destructive', () => {
  assert.match(record, /deleteClipToBin/);
  assert.match(record, /Recently deleted/);
  assert.match(record, /style: 'cancel'/);
});

// The ASMR contract: configurable gap, tap to pause, pause cancels a pending
// advance (otherwise pausing during the gap still jumps to the next shot).
test('playback waits the chosen interval between shots', () => {
  assert.match(training, /INTERVAL_OPTIONS_MS = \[500, 1000, 2000, 3000\]/);
  assert.match(play, /setTimeout\(/);
  assert.match(play, /intervalMs/);
});

test('pausing cancels a pending between-shots advance', () => {
  const body = play.match(/const togglePause = useCallback\(([\s\S]*?)\n  \}, /)?.[1] ?? '';
  assert.match(body, /clearTimeout\(gapTimer\.current\)/);
});

test('the interval choice persists across sessions', () => {
  assert.match(training, /training\.playback_interval_ms/);
  assert.match(play, /setPlaybackIntervalMs/);
});

// Review reuses the editor, whose per-hole export IS per-club export here —
// but only if the words change with it.
test('the editor in training mode says clubs, never holes', () => {
  assert.match(editor, /trainingHoleLabel/);
  assert.match(editor, /isTraining \? 'Select clubs' : 'Select holes'/);
  const header = editor.match(/\{training \? trainingHoleLabel[\s\S]{0,900}/)?.[0] ?? '';
  assert.match(header, /!training && \(/, 'Par and Score are hidden for a range session');
});

// The hub is the date-filtered history Henry asked for.
test('history is grouped by date with per-club summaries and a club filter', () => {
  assert.match(hub, /listTrainingSessions/);
  assert.match(hub, /trainingShotCounts/);
  assert.match(hub, /filterHole/);
  assert.match(hub, /dateLabel/);
});

// Entry point exists, and only where the live camera cannot also be mounted.
test('Practice is reachable from the record chooser', () => {
  assert.match(chooser, /router\.push\('\/training'\)/);
  const idx = chooser.indexOf("router.push('/training')");
  const before = chooser.slice(0, idx);
  assert.match(before, /IDLE STATE: Mode chooser/, 'the card lives on the no-active-round chooser');
});
