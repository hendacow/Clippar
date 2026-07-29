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
