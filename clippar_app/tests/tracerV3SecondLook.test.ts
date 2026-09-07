/**
 * The consensus refit and the second look — the two changes of 7 Sep.
 *
 * WHERE THEY COME FROM. Henry sent IMG_0601 with *"i can even see it the entire
 * time"*. He was right: the detector found the ball on 4 frames of a ~40-frame
 * flight. One number caused it — `acceptScore`, the score a candidate must reach
 * to stay in a running track. At 0.12 rather than 0.22 that clip goes from 4
 * detections to 41 and mean confidence RISES (0.78 -> 0.89), so the ball was
 * being rejected rather than junk accepted.
 *
 * Neither change is a loosened threshold, and that is the point of these tests:
 *
 *  - `acceptScore: 0.12` as a DEFAULT is a net loss (28/72 against 32/72 on the
 *    121-clip corpus). It only ever runs as a second pass.
 *  - the consensus refit only ever SHRINKS the set it fits, must keep a majority
 *    of a real number of points, and re-applies every gate. The prefix-trim rung
 *    that did not was reverted on 7 Sep for drawing arcs over a tossed ball.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../constants/config';
import { traceClip } from '../lib/tracerV3';
import { detectionResult, flightDetections, traceInput } from './fixtures/tracerV3Clip';

const root = join(__dirname, '..');
const editor = readFileSync(join(root, 'hooks/useEditorState.ts'), 'utf8');
const ladder = readFileSync(join(root, 'lib/tracerV3.ts'), 'utf8');

test('the second look is a RETRY, never the first pass', () => {
  // The first detect call must not carry the loose score.
  const firstCall = /let detection = await detectShotV3\(v3DetectUri, v3DetectImpactMs\);/;
  assert.match(editor, firstCall, 'the first pass must use the shipped defaults');
  // ...and the loose score must appear only inside the retry.
  const retry = /retryAcceptScore/g;
  const hits = editor.match(retry) ?? [];
  assert.equal(hits.length, 1, `retryAcceptScore should appear once, found ${hits.length}`);
});

test('the second look is kept only when it draws AND more than doubles the points', () => {
  assert.match(editor, /retryResult\.spec !== null &&\s*\(result\.spec === null \|\| retryK > 2 \* firstK\)/);
});

test('a config flag turns the second look off completely', () => {
  assert.equal(typeof config.tracer.v3.retrySecondPass, 'boolean');
  assert.match(editor, /config\.tracer\.v3\.retrySecondPass &&/);
});

test('the consensus refit can only shrink the fitted set, never grow it', () => {
  assert.match(ladder, /inliers\.length < ordered\.length/);
});

test('the consensus refit needs a majority of a real number of points', () => {
  assert.match(ladder, /const CONSENSUS_MIN_N = 8;/);
  assert.match(ladder, /const CONSENSUS_MIN_FRAC = 0\.5;/);
  assert.match(ladder, /inliers\.length >= CONSENSUS_MIN_N/);
  assert.match(ladder, /inliers\.length >= CONSENSUS_MIN_FRAC \* ordered\.length/);
  // MIN_FIT is 3 and three points fit anything — the floor must not be it.
  assert.match(ladder, /const MIN_FIT = 3;/);
});

test('the consensus refit re-applies every gate the full fit failed', () => {
  const block = /runC\.fit\.rmsPx <= POOR_FIT_RMS_PX \* u &&[\s\S]{0,240}?runC\.fit\.summary\.hangS >= MIN_FLIGHT_HANG_S/;
  assert.match(ladder, block, 'rms, v0, apex and hang must all be re-checked');
});

test('a clean flight is unaffected by either change', () => {
  const r = traceClip(traceInput({ detection: detectionResult(flightDetections()) }));
  assert.ok(r.spec !== null, `a clean synthetic flight must still draw: ${r.reason}`);
  assert.ok(
    !r.flags.some((f) => f.startsWith('consensus_refit')),
    `nothing to refit on a clean track; flags: ${r.flags.join(' ')}`
  );
});
