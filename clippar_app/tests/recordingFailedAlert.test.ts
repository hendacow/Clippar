import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const camera = readFileSync(join(root, 'hooks/useCamera.ts'), 'utf8');

// Reported from hole 12, 30 Aug 2026: "Recording failed — check your free
// storage". The golfer went looking at his iCloud storage. Storage was not
// the cause and the app already knew that.
test('the recording failure alert no longer blames storage', () => {
  assert.doesNotMatch(camera, /check your free storage/);
});

test('a real free-disk check still runs BEFORE recording, with its own specific alert', () => {
  // This is why the generic message must not mention storage: by the time it
  // fires, low disk has already been ruled out and named separately.
  assert.match(camera, /MIN_FREE_DISK_MB/);
  assert.match(camera, /'Storage almost full'/);
  assert.match(camera, /freeDiskMB < MIN_FREE_DISK_MB/);
});

test('the failure alert reports the actual error instead of guessing', () => {
  const block = camera.match(/if \(!isPractice\) \{([\s\S]*?)\n        \}/)?.[1] ?? '';
  assert.match(block, /error instanceof Error/);
  assert.match(block, /reason/);
});

// The catch spans everything after saveLocalClip too, so "not saved" was a
// claim the code could not support.
test('the alert only says "not saved" when the row really did not land', () => {
  assert.match(camera, /let savedClipId: number \| null = null;/);
  assert.match(camera, /savedClipId = clipId \?\? null;/);
  const block = camera.match(/if \(!isPractice\) \{([\s\S]*?)\n        \}/)?.[1] ?? '';
  assert.match(block, /savedClipId \?/, 'the message branches on whether the clip saved');
  assert.match(block, /This shot IS saved/);
});

// Every deliberate round action already waits for the save. Navigation is the
// path that is not guarded, so the message should name it.
test('round-mutating actions still wait for the save to finish', () => {
  const record = readFileSync(join(root, 'app/(tabs)/record.tsx'), 'utf8');
  assert.match(record, /const recordingBusy = camera\.isRecording \|\| camera\.isFinalizing;/);
  assert.match(record, /Stop the current clip and let it finish saving before reviewing your round/);
});
