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

// The ASMR contract, as corrected by Henry on 30 Aug: the knob is HOW LONG
// EACH SHOT PLAYS — uniform duration is the rhythm, there is no gap. The
// first build had full-length clips separated by a silence; these tests
// exist so nobody rebuilds that reading.
test('the playback knob is per-shot play length, not a gap between clips', () => {
  assert.match(training, /PLAY_LENGTH_OPTIONS_MS = \[500, 1000, 2000, 3000\]/);
  assert.doesNotMatch(training, /INTERVAL_OPTIONS_MS/);
  assert.match(play, /per shot/);
});

test('long clips play a window centred on the middle, sized by the player, not SQLite', () => {
  assert.match(play, /dur \/ 2 - L \/ 2/);
  // duration_seconds records the REQUESTED trim width, not the produced
  // file — the reel-scorecard lesson. The window must come from the player.
  assert.match(play, /player\.duration/);
  const loadBlock = play.match(/replaceAsync[\s\S]{0,700}/)?.[0] ?? '';
  assert.doesNotMatch(loadBlock, /durationSeconds/);
});

test('short clips advance on natural end instead of freezing out the window', () => {
  assert.match(play, /playToEnd/);
});

test('pausing cancels the window timer and resuming keeps only the REMAINING time', () => {
  const body = play.match(/const togglePause = useCallback\(([\s\S]*?)\n  \}, /)?.[1] ?? '';
  assert.match(body, /clearTimeout\(windowTimer\.current\)/);
  assert.match(body, /- elapsedMs/);
});

test('the play length persists across sessions', () => {
  assert.match(training, /training\.play_length_ms/);
  assert.match(play, /setPlayLengthMs/);
});

// The second capture path: import from Photos into the same session shape.
test('imported shots enter the same pipeline as filmed ones', () => {
  assert.match(training, /importShotsToSession/);
  assert.match(training, /needs_trim: 1/);
  assert.match(training, /persistAsset/);
});

test('import is reachable from the hub and assigns a club at import time', () => {
  const hubNow = readFileSync(join(root, 'app/training/index.tsx'), 'utf8');
  const imp = readFileSync(join(root, 'app/training/import.tsx'), 'utf8');
  assert.match(hubNow, /\/training\/import\?roundId=/);
  assert.match(imp, /importShotsToSession/);
  assert.match(imp, /allowsMultipleSelection: true/);
  assert.match(imp, /club\.holeNumber/);
});

test('in training mode the editor moves clips between ALL clubs, labelled as clubs', () => {
  const ed = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
  assert.match(ed, /isTraining \? 'Move to club' : 'Move to hole'/);
  assert.match(ed, /CLUBS\.map\(\(c\) => \(\{ holeNumber: c\.holeNumber, label: c\.short \}\)\)/);
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

// Reported from the range, 31 Aug: "my phone plays them instantly in Photos
// but it keeps saying that" — the import alert told him to go download in
// Photos manually. The app must fetch, not refuse.
test('import fetches iCloud videos instead of refusing', () => {
  const imp = readFileSync(join(root, 'app/training/import.tsx'), 'utf8');
  const media = readFileSync(join(root, 'lib/media.ts'), 'utf8');
  assert.match(media, /shouldDownloadFromNetwork: true/, 'MediaLibrary fallback actually downloads');
  assert.match(imp, /preferredAssetRepresentationMode/, 'no forced transcode on big iCloud videos');
  assert.doesNotMatch(imp, /Open the Photos app and download/, 'the go-do-it-yourself alert is gone');
  const catches = imp.match(/catch \(firstErr\)[\s\S]*?return;/)?.[0] ?? '';
  assert.match(catches, /launchImageLibraryAsync\(pickerOptions\)/, 'retries once — iCloud downloads resume');
  assert.match(catches, /reason/, 'the alert reports the real error, not a guessed cause');
});

// Henry, 31 Aug: previewing practice in the editor "should be exactly like
// the watch mode". One playback behaviour for practice content everywhere —
// the editor's Preview must open THE watch screen, not a variant of it.
test('editor preview for a practice session IS the watch mode', () => {
  const ed = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
  const block = ed.match(/const handlePreviewAll[\s\S]*?\n  \}, /)?.[0] ?? '';
  assert.match(block, /isTraining/);
  assert.match(block, /\/training\/play\?roundId=/);
  assert.match(block, /'\/round\/preview'/, 'round previews still use the round player');
});
