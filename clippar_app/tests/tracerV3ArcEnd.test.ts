/**
 * The arc may not be drawn on a scale that was never established.
 *
 * WHERE THIS COMES FROM. 7 Sep 2026, the first time the V3 renderer was ever
 * executed (it had been written, reviewed and shipped without one frame being
 * painted). On IMG_0552_2 — one of Henry's own imported clips — the detector
 * tracked the ball 41 frames through the apex and part-way down, ending high in
 * the frame near the horizon. The drawn trace did not stop there: it carried on
 * to the FITTED landing, which under `geometry_unknown` rests on an assumed
 * camera pitch and an f_px prior, and plunged back down towards the tee. On the
 * rendered frame it read as a vertical red stick beside the golfer.
 *
 * The label already refused to state a distance on that clip. The arc was still
 * being extrapolated on the same unusable number. These tests hold the two to
 * the same standard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { traceClip } from '../lib/tracerV3';
import {
  HEIGHT, PITCH_DOWN_DEG,
  detectionResult, flightDetections, traceInput,
} from './fixtures/tracerV3Clip';

/** A flight cut off before its landing — the ball goes sub-pixel and is lost. */
function lostInTheAir() {
  return flightDetections({ frames: 26 });
}

test('with a MEASURED camera the arc still draws on to the fitted landing', () => {
  const r = traceClip(traceInput({ detection: detectionResult(lostInTheAir()) }));
  assert.ok(r.spec !== null, `measured-camera clip should draw: ${r.reason}`);
  assert.ok(
    r.flags.includes('arc_end:fitted'),
    `a measured camera must still reach its landing; flags: ${r.flags.join(' ')}`
  );
});

test('an imported clip: the drawn arc ends where the ball was, not past it', () => {
  // Exactly the app's import conditions — no pitch, no lens, no GPS.
  const dets = lostInTheAir();
  const withCamera = traceClip(traceInput({ detection: detectionResult(dets) }));
  const imported = traceClip(
    traceInput({
      detection: detectionResult(dets),
      pitchDownDeg: null,
      capture: { lens: null, zoom: null },
      allowUnknownGeometry: true,
      assumedPitchDownDeg: PITCH_DOWN_DEG,
    })
  );
  assert.ok(withCamera.spec !== null, `measured-camera clip should draw: ${withCamera.reason}`);
  assert.ok(imported.spec !== null, `imported clip should still draw: ${imported.reason}`);

  // The import's trace must not reach further down the frame than the ball was
  // last seen. Spec y is normalised BOTTOM-left, detection y is pixels from the
  // top, so "further down" is a SMALLER spec y.
  const lastSeenY = 1 - dets[dets.length - 1].y / HEIGHT;
  const importEndY = imported.spec!.samples[imported.spec!.samples.length - 1].y;
  assert.ok(
    importEndY >= lastSeenY - 0.02,
    `the import's arc ends at y=${importEndY.toFixed(3)}, below the last detection at ${lastSeenY.toFixed(3)}`
  );
  // ...and it is a real shortening, not a no-op: the measured-camera clip is
  // allowed to run on past it.
  const camEndY = withCamera.spec!.samples[withCamera.spec!.samples.length - 1].y;
  assert.ok(
    importEndY > camEndY,
    `the import (${importEndY.toFixed(3)}) should stop above the measured camera's landing (${camEndY.toFixed(3)})`
  );
  assert.ok(imported.flags.includes('arc_end:seen'), `flags: ${imported.flags.join(' ')}`);
});
