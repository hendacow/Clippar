import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isConfidentClassification,
  shouldKeepFullRecording,
  REAL_CLASSIFICATION_MIN_CONFIDENCE,
} from '../lib/shotPolicy';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

// The regression these exist for, from Henry's 36-clip round on 2026-08-05:
// putts were given their own "keep the whole recording" path, keyed on
// shotType alone. Half the round came back as full-length videos, because
// fallbackClassify calls ANY clip over 12 seconds a putt at confidence 0.25.
// Every clip in that round was a fallback guess — 0.20, 0.25, 0.30 — so the
// rule was deciding on a coin flip.

test("a putt from the duration fallback does NOT keep the full recording", () => {
  // The exact rows from his log that regressed.
  for (const confidence of [0.25, 0.3, 0.35]) {
    assert.equal(
      shouldKeepFullRecording({ found: true, shotType: 'putt', confidence }),
      false,
      `confidence ${confidence} is fallbackClassify guessing — it must be trimmed`
    );
  }
});

test('a confidently detected putt DOES keep the full recording', () => {
  // The pose state machine reports from 0.6 up. That is a real classification
  // and Henry's rule applies: a window centred on impact would cut off the
  // ball travelling to the hole.
  for (const confidence of [0.6, 0.75, 1]) {
    assert.equal(shouldKeepFullRecording({ found: true, shotType: 'putt', confidence }), true);
  }
});

test('swings are always trimmed, at any confidence', () => {
  for (const confidence of [0.2, 0.35, 0.6, 0.95]) {
    assert.equal(shouldKeepFullRecording({ found: true, shotType: 'swing', confidence }), false);
  }
});

test('nothing detected never takes the keep-full path', () => {
  // An undetected clip keeps its full length too, but on a different branch —
  // this predicate must not claim it, or the caller skips persisting the
  // classification it does have.
  assert.equal(shouldKeepFullRecording({ found: false, shotType: 'putt', confidence: 0.9 }), false);
});

test('missing or malformed confidence is treated as not-confident', () => {
  for (const confidence of [null, undefined, NaN, Infinity, -1] as unknown[]) {
    assert.equal(
      shouldKeepFullRecording({ found: true, shotType: 'putt', confidence: confidence as number }),
      false,
      'an unusable confidence must fall back to trimming, never to keeping'
    );
  }
});

test('the threshold sits in the gap between the two classifiers', () => {
  // 0.5 is only safe while nothing emits a confidence between the fallback's
  // ceiling and the pose machine's floor. Pin both ends against the Swift so
  // a future tuning pass cannot silently close that gap.
  const swift = read('modules/shot-detector/ios/ShotDetectorModule.swift');

  const fallbackConfidences = [...swift.matchAll(/return \(\.(?:putt|swing), (0\.\d+), "/g)].map(
    (m) => Number(m[1])
  );
  assert.ok(fallbackConfidences.length > 0, 'expected fallbackClassify return sites in the Swift');
  const ceiling = Math.max(...fallbackConfidences);
  assert.ok(
    ceiling < REAL_CLASSIFICATION_MIN_CONFIDENCE,
    `fallbackClassify now emits ${ceiling}, at or above the ${REAL_CLASSIFICATION_MIN_CONFIDENCE} threshold — ` +
      'a guess would be treated as a real classification and putts would stop being trimmed again'
  );

  assert.equal(isConfidentClassification({ found: true, confidence: ceiling }), false);
  assert.equal(isConfidentClassification({ found: true, confidence: 0.6 }), true);
});

test('all three trim paths route through the shared policy', () => {
  // Live capture and both import paths must agree. The regression was one
  // rule expressed three times; this keeps it expressed once.
  for (const rel of ['hooks/useCamera.ts', 'hooks/useEditorState.ts']) {
    const src = read(rel);
    assert.match(src, /shouldKeepFullRecording\(result\)/, `${rel} must use the shared policy`);
    assert.doesNotMatch(
      src,
      /found && result\.shotType === 'putt'\) \{/,
      `${rel} must not re-introduce a bare shotType check as a branch guard`
    );
  }
});
