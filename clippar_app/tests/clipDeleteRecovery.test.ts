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

// Every path that touches a bin entry binds the id that built the key to the
// round's owner. Read and restore were the two that did not, on the argument
// that gating them would hide an entry whose round is gone — which the
// predicate's own null-tolerance refutes: `round == null` passes. What it
// excludes is an entry whose round still EXISTS and belongs to someone else.
test('all five entry paths go through the ownership predicate', () => {
  const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
  for (const fn of [
    'export async function listBinnedClips',
    'export async function restoreClipFromBin',
    'export async function purgeClipFromBin',
    'export async function purgeAllBinnedClips',
  ]) {
    const body = bin.match(new RegExp(`${fn}[\\s\\S]*?\\n}`))?.[0] ?? '';
    assert.notEqual(body, '', `${fn} should still exist`);
    assert.match(body, /entryOwnedBy\(/, `${fn} must gate on the shared ownership predicate`);
  }
  const pred = bin.match(/async function entryOwnedBy[\s\S]*?\n}/)?.[0] ?? '';
  // Two properties, and the second is why this test changed shape.
  //
  // 1. Null-tolerant for a round that is GONE, or gating the read path DOES
  //    recreate findings 34/41 — an entry outliving its round would vanish.
  assert.match(pred, /owner === undefined\) return true/, 'a gone round must still pass');
  // 2. It must NOT ask the scoped read. `getLocalRound` filters on user_id and
  //    post-filters with isRowVisible, so a round owned by ANOTHER account comes
  //    back null — indistinguishable from gone, and admitted by (1). Built that
  //    way, the predicate's advertised exclusion set was empty.
  assert.doesNotMatch(
    pred,
    /getLocalRound\(/,
    'the scoped read collapses "gone" and "owned by someone else" into null'
  );
  assert.match(pred, /return owner === userId/, 'a foreign owner must be refused');
});

test('the restore refusal mutates nothing', () => {
  const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
  const body = bin.match(/export async function restoreClipFromBin[\s\S]*?\n}/)?.[0] ?? '';
  // Refuse BEFORE the row insert and before the bin is rewritten, so the entry
  // survives for its real owner rather than being dropped by the refusal.
  assert.ok(
    body.indexOf('entryOwnedBy(') < body.indexOf('await restoreLocalClip('),
    'the gate must precede the restore'
  );
  assert.ok(
    body.indexOf('entryOwnedBy(') < body.indexOf('await writeBinAt('),
    'the gate must precede the bin write, or a refusal destroys the entry'
  );
});

// The read path must fail closed, like every other gate on this branch.
test('listBinnedClips shows nothing when the account cannot be resolved', () => {
  const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
  const body = bin.match(/export async function listBinnedClips[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(body, /if \(!userId\) return \[\];/, 'no session must list nothing');
  assert.doesNotMatch(body, /readBin\(\)/, 'binKey() alone is the unbound resolution this replaced');
});

// The writer must refuse an UNREADABLE bin rather than overwrite it, and must
// refuse before the clip row leaves SQLite.
//
// getSetting is a bare getDatabase() + getFirstAsync with no catch, so it
// rejects on a busy database. The lenient reader turns that into [], and
// deleteLocalClip runs first — so writeBinAt(key, [entry]) would replace up to
// MAX_ENTRIES valid records whose rows are already deleted, orphaning their
// files with nothing left naming them.
//
// This assertion exists because reverting the fix left the suite GREEN. The
// same property is pinned for both registries; I did not carry it to the third
// reader while fixing them.
test('deleteClipToBin refuses an unreadable bin, before the row is deleted', () => {
  const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
  const body = bin.match(/export async function deleteClipToBin[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(body, '', 'deleteClipToBin should still exist');
  assert.match(body, /readBinAtStrict\(/, 'the writer must use the reader that can say "unreadable"');
  assert.doesNotMatch(
    body,
    /await readBinAt\(/,
    'the lenient reader turns a failed read into [], which this function then persists'
  );
  assert.match(body, /if \(existing === null\) return null;/, 'an unreadable bin must refuse the delete');
  assert.ok(
    body.indexOf('if (existing === null) return null;') < body.indexOf('await deleteLocalClip('),
    'refuse BEFORE the row leaves SQLite, or the clip is lost with nowhere to record recovery'
  );
});

// The lenient reader stays correct for callers that only LOOK UP an entry: a
// failed read there means "not found", which they handle without writing.
test('the lenient bin reader is derived from the strict one, not a second copy', () => {
  const bin = readFileSync(join(root, 'lib/clipBin.ts'), 'utf8');
  const lenient = bin.match(/async function readBinAt\(key: string\)[\s\S]*?\n}/)?.[0] ?? '';
  assert.notEqual(lenient, '', 'readBinAt should still exist');
  assert.match(
    lenient,
    /readBinAtStrict\(key\)\) \?\? \[\]/,
    'one implementation, so the per-entry validation cannot drift between them'
  );
});
