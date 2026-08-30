import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const hook = readFileSync(join(root, 'hooks/useEditorState.ts'), 'utf8');
const editor = readFileSync(join(root, 'app/round/editor.tsx'), 'utf8');
const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
const profile = readFileSync(join(root, 'app/(tabs)/profile.tsx'), 'utf8');
const screen = readFileSync(join(root, 'app/profile/deleted-clips.tsx'), 'utf8');

// The bug, stated as a test: removeClip changed React state and nothing else,
// so the editor's focus reload re-read SQLite and every deleted clip came back.
test('removeClip persists the delete instead of only changing React state', () => {
  const body = hook.match(/const removeClip = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
  assert.notEqual(body, '', 'removeClip should still be a useCallback');
  assert.match(body, /deleteClipToBin\(/, 'the delete must reach SQLite');
  assert.match(body, /parseInt\(clipId, 10\)/);
});

// The editor re-reads on focus. That is what exposed the bug, so it is what
// makes the fix meaningful — keep it, or the test above stops proving anything.
test('the editor still reloads from SQLite on focus', () => {
  assert.match(editor, /useFocusEffect/);
  assert.match(editor, /editor\.reload\(\)/);
});

// Persisting the delete without a way back would be worse than the bug: the
// old delete lost nothing, a real one loses a shot on a single tap.
test('a persisted delete is recoverable, not destructive', () => {
  assert.match(hook, /restoreClipFromBin/);
  assert.match(hook, /undoRemoveClip/);
  assert.match(bin, /export async function restoreClipFromBin/);
  assert.match(bin, /export async function deleteClipToBin/);
});

// deleteLocalClip documents that staling the predecessor's tracer is
// irreversible and must be deferred when undo is offered. The bin offers undo.
test('the bin defers the irreversible half of a delete', () => {
  assert.match(bin, /deleteLocalClip\(clipId, false\)/);
  assert.match(bin, /commitClipDeletion/);
});

// Files are what make a restore meaningful; unlinking them at delete time
// would leave a row that restores to a missing video.
test('video files survive until an entry leaves the bin', () => {
  const purge = bin.match(/async function purgeEntry\(([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(purge, /deleteFile/, 'files are unlinked on purge');
  const del = bin.match(/export async function deleteClipToBin\(([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(del, /deleteFile/, 'and never at delete time');
});

// Both delete controls ask first. The X did not until the delete became real.
test('every clip delete control confirms before deleting', () => {
  const xButton = editor.match(/\{\/\* Remove button \(top-right X\)[\s\S]*?<\/Pressable>/)?.[0] ?? '';
  assert.notEqual(xButton, '', 'the X control should still exist');
  assert.match(xButton, /Alert\.alert\(/, 'the X must confirm');
  assert.match(xButton, /style: 'cancel'/);
  assert.match(editor, /Alert\.alert\('Delete clip'/, 'the menu Delete still confirms');
});

// A recovery path nobody can find is not a recovery path.
test('Recently deleted is reachable from Profile and is not dev-only', () => {
  assert.match(profile, /Recently deleted/);
  assert.match(profile, /\/profile\/deleted-clips/);
  const row = profile.match(/title="Recently deleted"[\s\S]{0,200}/)?.[0] ?? '';
  assert.doesNotMatch(row, /__DEV__/);
  assert.match(screen, /restoreClipFromBin/);
  assert.match(screen, /Put back/);
});

// Purging is the only irreversible action on that screen, so it is the one
// that must ask.
test('deleting for good asks, restoring does not', () => {
  assert.match(screen, /Delete for good\?/);
  assert.match(screen, /cannot be undone/);
});
