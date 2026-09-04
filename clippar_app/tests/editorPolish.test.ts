import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const modal = readFileSync(join(root, 'components/editor/ClipTrimModal.tsx'), 'utf8');
const editor = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
const share = readFileSync(join(root, 'lib/clipShare.ts'), 'utf8');
const play = readFileSync(join(root, 'app/training/play.tsx'), 'utf8');

// Henry, 4 Sep, second round from the phone.
test('the trimmer sits below the Dynamic Island with thumb-sized controls', () => {
  assert.match(modal, /paddingTop: insets\.top \+ 8/);
  assert.doesNotMatch(modal, /Drag indicator for iOS pageSheet/, 'no fake drag pill on a fullScreen modal');
  assert.match(modal, /width: 44,\s*height: 44,\s*borderRadius: 22,\s*backgroundColor: 'rgba\(255,255,255,0\.15\)'/, 'X is 44pt');
  assert.match(modal, /flex: 1, minWidth: 0, flexDirection: 'row'/, 'the centre block shrinks before the buttons');
  assert.doesNotMatch(modal, /top: -26, left: 0, right: 0, alignItems: 'center'/, 'the zoom badge no longer sits on the time labels');
  assert.match(modal, /width: '28%', zIndex: 5/, 'tap the edge of the video to change shot');
  assert.match(modal, /<Check size=\{24\}/);
  assert.match(modal, /<ChevronLeft size=\{30\}/);
});

test('trim handles are thick and hold-to-zoom fine scrubbing exists', () => {
  assert.match(modal, /const HANDLE_WIDTH = 44;/);
  assert.match(modal, /width: 16,\s*height: 48,\s*borderRadius: 6,/, 'visible bar is 16x48');
  assert.match(modal, /const FINE_HOLD_MS = 450;/);
  assert.match(modal, /const FINE_ZOOM = 4;/);
  assert.match(modal, /enterFine\(handle\)/);
  assert.match(modal, /\(dur \/ zoomRef\.current\)/, 'a zoomed drag moves a quarter as far');
  assert.match(modal, /viewStartMs \+ i \* interval/, 'the filmstrip follows the zoomed window');
  assert.match(modal, /Fine scrub · \{FINE_ZOOM\}× — let go to zoom out/);
});

test('trimmer navigation walks the whole round, not one hole', () => {
  assert.match(editor, /const flatClips = useMemo\(\(\) => state\.holes\.flatMap\(\(h\) => h\.clips\)/);
  assert.match(editor, /flatClips\.findIndex\(\(c\) => c\.id === trimClip\.id\) < flatClips\.length - 1/);
});

test('tiles carry one red X; download moved into Options; share is deferred and reports failure', () => {
  assert.match(editor, /<XCircle size=\{26\} color=\{theme\.colors\.accentRed\}/);
  assert.doesNotMatch(editor, /top: 26,\s*right: 3,\s*width: 22,/, 'the tile download overlay is gone');
  assert.match(editor, />\s*Save to Photos\s*<\/Text>/);
  assert.match(editor, /setTimeout\(async \(\) => \{\s*const ok = await shareClip\(/, 'share waits for the sheet to dismiss');
  assert.match(editor, /Alert\.alert\('Could not share'/);
  assert.match(share, /export async function shareClip\(uri: string, title: string\): Promise<boolean>/);
  assert.match(share, /FileSystemLegacy\.getInfoAsync\(shareUri\)/, 'checks the file exists first');
  assert.doesNotMatch(share, /\}\)\.catch\(\(\) => \{\}\);\s*\}\s*\n\n\/\*\*\n \* Stitch all clips/, 'no swallowed share errors');
});

test('Select · Preview · Export live in a sticky bottom bar', () => {
  assert.match(editor, /STICKY ACTION BAR: Select · Preview · Export \/ Back to round/);
  assert.match(editor, /paddingBottom: insets\.bottom \+ 112, \/\/ clears the sticky action bar/);
  const header = editor.slice(editor.indexOf('---- HEADER'), editor.indexOf('---- AUTO-TRIM PROGRESS BANNER'));
  assert.doesNotMatch(header, /onPress=\{handleExportPress\}/, 'Export is no longer in the header');
  assert.doesNotMatch(header, /onPress=\{handlePreviewAll\}/, 'Preview is no longer in the header');
});

test('the training window puts the strike at three-quarters, not the middle', () => {
  assert.match(play, /impactFractionInFile\(current\) - 0\.75 \* L/);
});

test('hole buttons say what they do; only a real cut is labelled Trimmed; preview opens the full trimmer', () => {
  assert.match(editor, />Save hole<\/Text>/);
  assert.match(editor, />Share hole<\/Text>/);
  assert.match(editor, /const wasTrimmed =/);
  assert.match(editor, /\(clip\.isExcluded \|\| wasTrimmed\) && \(/, 'untouched clips get no band');
  assert.doesNotMatch(editor, /: 'Trimmed' : 'Edit'\}/, 'no "Edit" band');
  const preview = readFileSync(join(root, 'app/round/preview.tsx'), 'utf8');
  assert.match(preview, /const HANDLE_WIDTH = 40;/);
  assert.match(preview, /<ClipTrimModal\s*visible=\{fullTrimOpen && !!currentClip\}/);
  assert.match(preview, /<Scissors size=\{16\}/);
});
