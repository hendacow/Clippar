import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const swift = readFileSync(join(root, 'modules/shot-detector/ios/ShotDetectorModule.swift'), 'utf8');

// Henry's field calibration, 31 Aug: "make its estimated impact time .3
// seconds forward... don't change anything into how else it picks anything
// up". These tests pin BOTH halves of that instruction.
test('the shipped impact estimate is calibrated +300ms', () => {
  assert.match(swift, /impactCalibrationMs: Double = 300\.0/);
  assert.match(swift, /min\(durationMs, r\.impactTimeMs \+ impactCalibrationMs\)/, 'clamped to the clip');
});

test('calibration applies at both shipping boundaries, after detection', () => {
  assert.match(swift, /let result = calibrateImpact\(rawResult/, 'detectAndTrim path');
  assert.match(swift, /let result = calibrateImpact\(rawClassifyResult/, 'classifier path');
});

test('selection, classification and confidence still run on the RAW pick', () => {
  // resultFromEpisode is where confidence and shot type are computed — the
  // calibration must not appear inside it, or "don't change how it picks" is
  // violated (audio-transient confidence keys off the raw impact time).
  const rfe = swift.match(/private func resultFromEpisode[\s\S]*?\n    \}\n/)?.[0] ?? '';
  assert.notEqual(rfe, '', 'resultFromEpisode still exists');
  assert.doesNotMatch(rfe, /calibrateImpact|impactCalibrationMs/);
  const dispatch = swift.match(/private func dispatchDetection[\s\S]*?\n    \}\n/)?.[0] ?? '';
  assert.doesNotMatch(dispatch, /calibrateImpact/, 'dispatch returns the raw result');
});

test('the trim window is built from the calibrated estimate, so it moves with it', () => {
  // trimStart/trimEnd derive from result.impactTimeMs AFTER calibration —
  // the window and the stored impact move together, which is what keeps
  // ball-launch seeding and playback centring coherent.
  assert.match(swift, /let trimStart = max\(0\.0, result\.impactTimeMs - effectivePreRoll\)/);
});
