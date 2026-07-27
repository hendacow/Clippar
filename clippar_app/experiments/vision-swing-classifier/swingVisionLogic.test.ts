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

test('DEFAULT_THRESHOLDS are sane', () => {
  assert.ok(DEFAULT_THRESHOLDS.fullSwing > 0 && DEFAULT_THRESHOLDS.fullSwing < 1);
  assert.ok(DEFAULT_THRESHOLDS.topK >= 1);
});
