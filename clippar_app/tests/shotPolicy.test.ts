import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isConfidentClassification,
  shouldKeepFullRecording,
  resolveVisionStroke,
  REAL_CLASSIFICATION_MIN_CONFIDENCE,
  VISION_POSE_CONFIDENCE,
  VISION_MOTION_FALLBACK_CONFIDENCE,
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

// swing-vision reports confidence as an image-prototype score (~0.0-0.1). If
// that were passed through raw, EVERY vision result would land below the
// threshold above — including the pose classifications that are the best
// signal the app has — so resolveVisionStroke translates onto this scale.

test('a pose-seen putt keeps the full recording', () => {
  const s = resolveVisionStroke({ strokeType: 'putt', wristHeight: -0.7 });
  assert.equal(s.strokeType, 'putt');
  assert.equal(s.poseDecided, true);
  assert.equal(
    shouldKeepFullRecording({ found: true, shotType: s.strokeType, confidence: s.confidence }),
    true,
    'pose measured the wrist height — that is a real classification'
  );
});

test('a putt with NO pose reading is trimmed, not kept', () => {
  // Without a body to measure, 'putt' is a residue label that non-golf footage
  // lands in too. The 36-clip round is what this rule exists to prevent.
  for (const wristHeight of [undefined, null, NaN, Infinity] as unknown[]) {
    const s = resolveVisionStroke({
      strokeType: 'putt',
      wristHeight: wristHeight as number,
    });
    assert.equal(s.strokeType, 'swing', 'an unseen putt must be trimmed like any shot');
    assert.equal(
      shouldKeepFullRecording({ found: true, shotType: s.strokeType, confidence: s.confidence }),
      false
    );
  }
});

test('a vision swing is never kept whole, pose or not', () => {
  for (const wristHeight of [0.6, undefined] as unknown[]) {
    const s = resolveVisionStroke({ strokeType: 'swing', wristHeight: wristHeight as number });
    assert.equal(s.strokeType, 'swing');
    assert.equal(
      shouldKeepFullRecording({ found: true, shotType: s.strokeType, confidence: s.confidence }),
      false
    );
  }
});

test('the two vision confidences sit on the correct sides of the bar', () => {
  // The whole translation depends on this ordering. Pin it so a future tuning
  // pass cannot move one across the threshold without a failing test.
  assert.ok(
    VISION_POSE_CONFIDENCE >= REAL_CLASSIFICATION_MIN_CONFIDENCE,
    'a pose classification must read as real'
  );
  assert.ok(
    VISION_MOTION_FALLBACK_CONFIDENCE < REAL_CLASSIFICATION_MIN_CONFIDENCE,
    'the unmeasured motion fallback must read as a guess'
  );
});

test('the vision adapter uses the shared policy rather than its own rule', () => {
  const src = read('lib/visionTrim.ts');
  assert.match(src, /resolveVisionStroke\(r\)/, 'visionTrim must not re-derive the stroke rule');
  assert.doesNotMatch(
    src,
    /confidence:\s*r\.confidence/,
    'the native prototype score must never be passed through as a confidence'
  );
});

test('the vision path can only add detections, never remove one', () => {
  // Every non-detection must return null so shot-detector still runs. If this
  // module ever answers `found: false` it has ENDED the clip's processing on
  // its own abstention, and a clip the old path would have trimmed comes back
  // full length — the exact regression this feature is meant to fix.
  const src = read('lib/visionTrim.ts');
  const code = src
    .slice(src.indexOf('export async function visionDetectAndTrim'))
    // Drop comments — the rule is explained in prose that quotes the very
    // thing it forbids, and only real code should be asserted against.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    code,
    /found:\s*false/,
    'a NO_SWING result must fall through to shot-detector, not answer for it'
  );
});

test('the vision path is gated on a config flag that needs no rebuild', () => {
  // Henry has to be able to revert this in one line if it disappoints in the
  // field. The check must come BEFORE anything touches native, so that "off"
  // is the same route as "module not in this build".
  const src = read('lib/visionTrim.ts');
  assert.match(src, /config\.detection\.swingVision/, 'visionTrim must read the kill switch');
  const cfg = read('constants/config.ts');
  assert.match(cfg, /swingVision:\s*true as boolean/, 'the flag must exist and default on');
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
