import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFrame,
  poolFrames,
  decideClip,
  DEFAULT_THRESHOLDS,
  VISION_CLASSES,
  type FrameScores,
} from './swingVisionLogic';

// Pure-logic tests for the experimental vision classifier's decision layer.
// These run under `node --test` with no Core ML dependency.

const fs = (
  full_swing: number,
  address: number,
  putt_chip: number,
  no_shot: number
): FrameScores => ({ full_swing, address, putt_chip, no_shot });

test('classifyFrame: an image embedding nearest a class scores highest for it', () => {
  const classEmb = {
    full_swing: [1, 0, 0],
    address: [0, 1, 0],
    putt_chip: [0, 0, 1],
    no_shot: [-1, 0, 0],
  };
  const scores = classifyFrame([0.9, 0.1, 0.0], classEmb);
  const top = VISION_CLASSES.reduce((a, b) => (scores[a] >= scores[b] ? a : b));
  assert.equal(top, 'full_swing');
  const sum = VISION_CLASSES.reduce((s, c) => s + scores[c], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'softmax sums to 1');
});

test('poolFrames: mean-of-top-k ignores a single outlier frame', () => {
  // One lucky full_swing frame among mostly putt frames must not dominate.
  const frames = [
    fs(0.9, 0.05, 0.9, 0.0), // the one swingy frame (also high putt)
    fs(0.1, 0.4, 0.5, 0.0),
    fs(0.1, 0.4, 0.5, 0.0),
    fs(0.1, 0.4, 0.5, 0.0),
  ];
  const pooled = poolFrames(frames, 3);
  // top-3 full_swing = (0.9,0.1,0.1)/3 ≈ 0.367, not 0.9
  assert.ok(pooled.full_swing < 0.4);
  assert.ok(pooled.putt_chip > pooled.full_swing);
});

test('decideClip: a clear full swing (sustained finish across frames) → FULL_SWING', () => {
  const frames = [
    fs(0.2, 0.6, 0.1, 0.1),
    fs(0.55, 0.3, 0.1, 0.05), // backswing
    fs(0.7, 0.15, 0.1, 0.05), // impact/finish
    fs(0.6, 0.2, 0.15, 0.05), // finish held
  ];
  const { label, pooled } = decideClip(frames);
  assert.equal(label, 'FULL_SWING');
  assert.ok(pooled.full_swing >= DEFAULT_THRESHOLDS.fullSwing);
});

test('decideClip: a chip with one mini-swing frame does NOT become a full swing', () => {
  const frames = [
    fs(0.2, 0.4, 0.45, 0.0),
    fs(0.5, 0.2, 0.5, 0.0), // the single club-up chip frame — high putt too
    fs(0.15, 0.4, 0.5, 0.0),
    fs(0.15, 0.4, 0.5, 0.0),
    fs(0.15, 0.4, 0.5, 0.0),
  ];
  const { label } = decideClip(frames);
  assert.notEqual(label, 'FULL_SWING');
  assert.equal(label, 'PUTT_CHIP');
});

test('decideClip: an empty course → NO_SHOT', () => {
  const frames = [
    fs(0.05, 0.05, 0.05, 0.85),
    fs(0.05, 0.1, 0.05, 0.8),
    fs(0.1, 0.1, 0.1, 0.7),
  ];
  assert.equal(decideClip(frames).label, 'NO_SHOT');
});

test('decideClip: golfer addressing with no decisive swing → UNSURE (does not force a call)', () => {
  const frames = [
    fs(0.2, 0.6, 0.15, 0.05),
    fs(0.25, 0.55, 0.15, 0.05),
    fs(0.2, 0.6, 0.15, 0.05),
  ];
  assert.equal(decideClip(frames).label, 'UNSURE');
});

test('decideClip: empty input → UNSURE, never throws', () => {
  assert.equal(decideClip([]).label, 'UNSURE');
});

// ── OPEN-SET REJECTION ──────────────────────────────────────────────────────
// Regression guard for the bug found on device: a video with NO golf in it was
// classified FULL_SWING at 87%. Cause: softmax over 4 golf classes is a forced
// choice. The similarity values below are the REAL measured ones.

test('decideClip: a non-golf clip is rejected as NO_SHOT despite confident-looking percentages', () => {
  // Exactly the on-device failure: softmax says "swing", raw similarity says
  // nothing here resembles golf (measured 0.06-0.13 for black/UI/random).
  const frames = [
    fs(0.47, 0.09, 0.10, 0.34),
    fs(0.50, 0.11, 0.11, 0.28),
    fs(0.24, 0.19, 0.41, 0.15),
    fs(0.47, 0.09, 0.10, 0.34),
  ];
  const sims = [
    fs(0.115, 0.098, 0.100, 0.112),
    fs(0.134, 0.119, 0.118, 0.128),
    fs(0.105, 0.103, 0.110, 0.101),
    fs(0.060, 0.086, 0.085, 0.110),
  ];
  const { label, inDomainFrames } = decideClip(frames, DEFAULT_THRESHOLDS, sims);
  assert.equal(label, 'NO_SHOT');
  assert.equal(inDomainFrames, 0);
});

test('decideClip: a real golf clip still passes the open-set gate', () => {
  const frames = [
    fs(0.16, 0.43, 0.41, 0.0),
    fs(0.82, 0.11, 0.08, 0.0),
    fs(0.49, 0.30, 0.21, 0.0),
    fs(0.60, 0.20, 0.15, 0.05),
  ];
  // Measured in-domain similarities: 0.31-0.34.
  const sims = [
    fs(0.317, 0.327, 0.326, 0.266),
    fs(0.336, 0.316, 0.312, 0.260),
    fs(0.315, 0.310, 0.306, 0.268),
    fs(0.320, 0.300, 0.295, 0.255),
  ];
  const { label, inDomainFrames } = decideClip(frames, DEFAULT_THRESHOLDS, sims);
  assert.equal(label, 'FULL_SWING');
  assert.equal(inDomainFrames, 4);
});

test('decideClip: mixed clip keeps only the in-domain frames', () => {
  const frames = [
    fs(0.9, 0.05, 0.03, 0.02), // junk frame that "looks" like a swing
    fs(0.20, 0.55, 0.20, 0.05), // real address
    fs(0.25, 0.50, 0.20, 0.05), // real address
    fs(0.22, 0.52, 0.21, 0.05), // real address
  ];
  const sims = [
    fs(0.09, 0.05, 0.04, 0.03), // out of domain → dropped
    fs(0.31, 0.33, 0.32, 0.26),
    fs(0.30, 0.34, 0.31, 0.26),
    fs(0.31, 0.33, 0.32, 0.26),
  ];
  const { label, inDomainFrames } = decideClip(frames, DEFAULT_THRESHOLDS, sims);
  assert.equal(inDomainFrames, 3, 'the junk frame is excluded');
  assert.notEqual(label, 'FULL_SWING', 'junk frame must not drive the decision');
});

test('minSimilarity sits clear of both measured domains', () => {
  // Out-of-domain ceiling 0.134, in-domain floor 0.315.
  assert.ok(DEFAULT_THRESHOLDS.minSimilarity > 0.134);
  assert.ok(DEFAULT_THRESHOLDS.minSimilarity < 0.315);
});

test('decideClip: without sims (legacy callers) behaviour is unchanged', () => {
  const frames = [fs(0.7, 0.15, 0.1, 0.05), fs(0.6, 0.2, 0.15, 0.05)];
  assert.equal(decideClip(frames).label, 'FULL_SWING');
});

test('DEFAULT_THRESHOLDS are sane', () => {
  assert.ok(DEFAULT_THRESHOLDS.fullSwing > 0 && DEFAULT_THRESHOLDS.fullSwing < 1);
  assert.ok(DEFAULT_THRESHOLDS.topK >= 1);
});
