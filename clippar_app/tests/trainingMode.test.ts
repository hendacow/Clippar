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

test('the window is sized by the player, never by SQLite duration', () => {
  // (Centring moved from clip-middle to the strike on 31 Aug — see the
  // impact-centring test below. This test keeps the other half of the
  // original claim: duration_seconds records the REQUESTED trim width, not
  // the produced file — the reel-scorecard lesson — so the window must be
  // computed from the player's own reading of the file.)
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
  // Retitled 31 Aug when selection became clip-level: shots, not clubs.
  assert.match(editor, /isTraining \? 'Select shots' : 'Select holes'/);
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

// Round two of the iCloud fight, 31 Aug: the fix that passed tests failed on
// the device — PHPhotosError 3164 and a silently-bouncing picker. Root cause
// found in the vendored picker source: its fast path streamed originals with
// network access DISALLOWED (`options: nil`), and its "graceful fallback"
// comment lied — a writeData throw errored the whole picker.
test('the picker patch allows iCloud download and makes the fallback real', () => {
  const patch = readFileSync(join(root, 'patches/expo-image-picker+17.0.10.patch'), 'utf8');
  assert.match(patch, /isNetworkAccessAllowed = true/);
  assert.match(patch, /\+.*do \{/, 'fast path wrapped so failure falls through');
  assert.match(patch, /loadFileRepresentation"?\)?/);
});

test('import asks for library permission so the fast path can run at all', () => {
  const imp = readFileSync(join(root, 'app/training/import.tsx'), 'utf8');
  assert.match(imp, /MediaLibrary\.requestPermissionsAsync/);
  assert.match(imp, /denial is not a blocker/i);
});

// 31 Aug, session review batch. Henry's geometric acceptance test: at any
// per-shot length the STRIKE sits at the centre of the played window. The
// trim puts impact at ~62.5% of the file (preRoll 2500 / postRoll 1500), so
// centring on the clip middle showed the strike at the window's edge — his
// "+0.2s" ask was a workaround for that; the fix is centring on impact.
test('the auto window centres on the strike, not the clip middle', () => {
  const tr = readFileSync(join(root, 'lib/training.ts'), 'utf8');
  const pl = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');
  assert.match(tr, /export function impactFractionInFile/);
  assert.match(tr, /impactTimeMs - clip\.autoTrimStartMs/, 'anchored to the stored impact');
  assert.match(tr, /return 0\.625;/, 'fallback assumes the trim shape, not the middle');
  assert.match(pl, /dur \* impactFractionInFile\(current\)/);
  assert.doesNotMatch(pl, /dur \/ 2 - L \/ 2/, 'the middle-centred window is gone');
});

// "Once you edit a video that video will stay exactly the same and won't
// change until you edit it again."
test('a manually trimmed clip is pinned: registry ONLY, and it ignores the per-shot length', () => {
  const pl = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');
  // The bounds heuristic (trimStart>0) silently skipped six of nine shots in
  // the field — auto-trim stores ORIGINAL-timeline bounds on trimmed files.
  // Pinned is decided by the registry both editors write, nothing else.
  assert.match(pl, /const isPinned = useCallback\(\(c: TrainingClip\) => pinnedIds\.has\(c\.id\), \[pinnedIds\]\);/);
  assert.doesNotMatch(pl, /c\.trimStartMs > 0 \|\| c\.trimEndMs !== -1/);
  const pinnedBranch = pl.match(/if \(isPinned\(current\) && pinnedSane\) \{([\s\S]*?)\} else \{/)?.[1] ?? '';
  assert.doesNotMatch(pinnedBranch, /playLengthRef/, 'pinned playback never reads the selector');
});

// The field bug, pinned as a contract: a clip can never play for zero
// seconds. Degenerate windows (stale bounds past the file's end, unready
// metadata) fall back to playing the clip — silent skip hides real shots.
test('a zero-length playback window is impossible by construction', () => {
  const pl = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');
  assert.match(pl, /pinnedSane = dur > 0 && pinnedStart < dur - 0\.2/);
  assert.match(pl, /NEVER play for zero/i);
  assert.match(pl, /dur > 0 \? dur \* 1000 : 9000/, 'unready metadata gets a generous timer, not a skip');
});

// Trimming must own its drags: the shared trim modal is fullScreen, because
// pageSheet's drag-to-dismiss stole the handle gesture app-wide.
test('the shared trim surface cannot be dragged away mid-trim', () => {
  const modal = readFileSync(join(root, 'components/editor/ClipTrimModal.tsx'), 'utf8');
  assert.match(modal, /presentationStyle="fullScreen"/);
  assert.doesNotMatch(modal, /"pageSheet"/);
});

test('the kit link points at the live product page', () => {
  const cfg = readFileSync(join(root, 'constants/config.ts'), 'utf8');
  assert.match(cfg, /clippargolf\.com\/products\/clippar-golf-kit/);
});

// One stored trim per clip, two places to edit it. The preview's save goes
// through the SAME columns the editor's updateTrim writes — after removeClip
// and durationMs, nothing ships that persists to one store and not the other.
test('a trim written from preview is exactly what the editor reads back', () => {
  const pl = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');
  const hook = readFileSync(join(root, 'hooks/useEditorState.ts'), 'utf8');
  assert.match(pl, /ClipTrimModal/, 'the REAL trimmer, not a lookalike');
  assert.match(pl, /updateClipEditorState\(c\.id, updates\)/, 'same persistence call');
  assert.match(pl, /trim_start_ms: trimStartMs,\s*\n\s*trim_end_ms: trimEndMs,/);
  assert.match(pl, /updates\.file_uri = sourceOverride\.sourceUri;/, 'same sourceOverride shape');
  // and editing in the MAIN editor pins too — either editor counts
  assert.match(hook, /markClipManuallyTrimmed\(numId\)/);
});

// Export: whole club in one tap, or arbitrary individual shots across clubs.
test('training select mode selects individual shots; club header selects all of a club', () => {
  const ed = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
  assert.match(ed, /toggleClipSelected/);
  assert.match(ed, /toggleClubClipsSelected/);
  assert.match(ed, /isTraining \? toggleClubClipsSelected/);
  assert.match(ed, /selectedClips\.has\(c\.id\)/, 'collect gathers the picked shots');
  assert.match(ed, /'Select shots'/);
  assert.match(ed, /Share this shot/, 'single-shot share from the clip menu');
});
