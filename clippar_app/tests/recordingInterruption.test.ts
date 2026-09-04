import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const patch = readFileSync(join(root, 'patches/expo-camera+17.0.10.patch'), 'utf8');
const cam = readFileSync(join(root, 'hooks/useCamera.ts'), 'utf8');

// 4 Sep: "Recording failed — this shot was not saved" on the course, with a
// generic message and the shot gone. Three guarantees now live in the native
// patch, and this test fails if any of them is dropped by a package upgrade.
test('an interrupted recording keeps the footage it wrote', () => {
  assert.match(patch, /movieFragmentInterval = CMTime\(seconds: 1/, 'file is playable up to the last second');
  assert.match(patch, /"partial": true/, 'a cut-short file resolves, marked partial, instead of rejecting');
  assert.match(patch, /bytes > 250_000/, 'only a real file is handed back');
});

test('the real AVFoundation error reaches the app', () => {
  assert.match(patch, /CameraRecordingFailedException: GenericException<String>/);
  assert.match(patch, /localizedDescription/);
  assert.doesNotMatch(cam, /Leaving the app or switching tabs while a clip is still saving will do this/, 'no guessed cause');
  assert.match(cam, /This shot was not saved\.\\n\\n\$\{reason\}/);
});

test('a phone call or another app taking the mic no longer kills the session', () => {
  assert.match(patch, /AVCaptureSessionWasInterrupted/);
  assert.match(patch, /audioDeviceInUseByAnotherClient/);
  assert.match(patch, /removeInput\(audioInput\)/, 'video continues without the mic');
  assert.match(patch, /AVCaptureSessionInterruptionEnded/);
  assert.match(patch, /self\.session\.startRunning\(\)/, 'session restarts when the interruption ends');
});

test('the app saves a partial clip through the normal path and says so', () => {
  assert.match(cam, /partial\?: boolean; reason\?: string/);
  assert.match(cam, /Recording was cut short/);
  assert.match(cam, /saved up to the point it was interrupted/);
});
