import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCaptureArmed } from '../lib/captureArming';

// Control BLE-001 — "accept the event only inside an armed capture screen".
// These lock down the predicate that app/(tabs)/record.tsx gates BOTH shutter
// subscriptions on. Every case below is an ATTACK: an external HID event
// (the golfer's clicker, or any other paired keyboard in range emitting
// VolumeUp / Enter) arriving on a surface that is not armed.

const armed = {
  roundInProgress: true,
  screenFocused: true,
  tutorialActive: false,
  tutorialPhase: 'intro',
} as const;

test('a live, focused record screen with no overlay is armed', () => {
  assert.equal(isCaptureArmed(armed), true);
});

test('clicker press while the blocking tutorial intro card is up must NOT arm capture', () => {
  // THE ATTACK: record.tsx auto-opens ClickerTutorial at phase 'intro' the
  // moment a Live round starts. Its scrim swallows touches, so every on-screen
  // control (including the record button) is unreachable — but a HID key event
  // is not a touch. `practice` is still false at 'intro', so the clip is REAL;
  // and when the user later runs a practice pass, endTutorial → resetToStart
  // unlinks that real clip's file from disk with no undo entry.
  assert.equal(
    isCaptureArmed({ ...armed, tutorialActive: true, tutorialPhase: 'intro' }),
    false
  );
});

test('the non-blocking coaching card leaves capture armed (it is a live practice run)', () => {
  // 'coaching' is entered only by tapping "Practise first". Clips recorded
  // under it are discarded by useCamera (practice=true), which is the point —
  // the user must actually see recording start and stop.
  assert.equal(
    isCaptureArmed({ ...armed, tutorialActive: true, tutorialPhase: 'coaching' }),
    true
  );
});

test('a press with no round in progress must NOT arm capture', () => {
  assert.equal(isCaptureArmed({ ...armed, roundInProgress: false }), false);
});

test('a press while the screen is unfocused must NOT arm capture', () => {
  // "Review round so far" router.pushes the editor ON TOP of this screen, so
  // the round stays in_progress. Without the focus term, volume presses used
  // to adjust preview playback in the editor would start recordings and
  // advance holes behind the user's back.
  assert.equal(isCaptureArmed({ ...armed, screenFocused: false }), false);
});

test('the intro card blocks even a focused, in-progress round (all terms are AND-ed)', () => {
  assert.equal(
    isCaptureArmed({
      roundInProgress: true,
      screenFocused: true,
      tutorialActive: true,
      tutorialPhase: 'intro',
    }),
    false
  );
  assert.equal(
    isCaptureArmed({
      roundInProgress: false,
      screenFocused: false,
      tutorialActive: true,
      tutorialPhase: 'coaching',
    }),
    false
  );
});

// ─── The predicate is only half the control ───

// isCaptureArmed above is correct and always was. The bug on 2026-08-06 was
// that its RESULT never reached the volume channel: useShutter read `armed`
// as an early return inside its volume effect, but the dependency array was
// [emitPress]. `armed` is dynamic — record.tsx passes isCaptureArmed(...),
// false until a round is in progress AND the screen is focused — so the
// effect ran once while disarmed, bailed before installing anything, and
// never re-ran when the round started.
//
// For the whole round there was then no addVolumeListener, no
// showNativeVolumeUI({enabled:false}) and no re-centering, so every clicker
// press went straight to iOS: the volume rose, the HUD appeared, and no shot
// was captured. Henry hit exactly this on TestFlight.
//
// Asserting on source text because hooks/useShutter.ts imports react-native,
// which the node test runner cannot transform — same approach as
// redeemCodeWiring.test.ts and privacyManifest.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const shutter = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks/useShutter.ts'),
  'utf8'
);

test('the volume effect re-runs when `armed` changes', () => {
  const start = shutter.indexOf('const subscription = VolumeManager.addVolumeListener');
  assert.notEqual(start, -1, 'expected the volume listener effect in useShutter.ts');
  const depsAt = shutter.indexOf('}, [', start);
  assert.notEqual(depsAt, -1, 'expected a dependency array closing that effect');
  const deps = shutter.slice(depsAt, shutter.indexOf(']', depsAt) + 1);
  assert.match(
    deps,
    /\barmed\b/,
    `the volume effect gates on \`armed\` but does not depend on it — it will ` +
      `never install the listener for a round that starts after mount. Deps: ${deps}`
  );
});

test('the volume effect still gates on armed at all', () => {
  // If this early return is ever removed, the test above passes vacuously
  // while the effect starts hijacking device volume outside a capture screen.
  const start = shutter.indexOf('const subscription = VolumeManager.addVolumeListener');
  const effectStart = shutter.lastIndexOf('useEffect(() => {', start);
  const body = shutter.slice(effectStart, start);
  assert.match(body, /if \(!armed\)/, 'the volume channel must stay armed-only');
});

test("the user's volume is handed back on disarm", () => {
  // The effect pins the system volume to 0.5 as its working point. userVolume
  // is captured on arm for the express purpose of restoring it; for a while it
  // was captured and never used, which left the phone at half volume after
  // every round and read to the user as "the clicker changed my volume".
  const start = shutter.indexOf('let userVolume');
  assert.notEqual(start, -1, 'expected userVolume to be captured on arm');
  assert.match(
    shutter.slice(start),
    /setVolume\(userVolume/,
    'userVolume is captured but never restored — the phone stays pinned at 0.5'
  );
});
