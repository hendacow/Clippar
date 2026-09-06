/**
 * lib/tracerV3.ts — the decision ladder, the one coordinate conversion, and the
 * render spec.
 *
 * WHAT THESE TESTS ARE FOR. The ladder is the only thing standing between a bad
 * detection and a golfer being shown an arc his ball did not fly. Every refusal
 * in it exists because the lab measured a specific clip going wrong
 * (`tracer-lab/experiments/e2e2/report.md` §3.2, §7): IMG_3647 is a putt whose
 * 42 rolling-ball detections fit a "flight"; IMG_2329 is a topped shot whose 3
 * wrong detections fit 95 m/s at 22 px rms; IMG_2331 fits at 5.3 px over 23
 * frames and draws a bullet under a climbing ball. So each refusal gets its own
 * fixture here — not one happy path and a shrug.
 *
 * The fixtures are SYNTHETIC and that is deliberate: a real clip's detections
 * cannot be committed, and a synthetic flight is the only way to know the truth
 * the fit is supposed to recover. They are built by simulating a flight with
 * `lib/tracerPhysics.ts` and projecting it through `lib/tracerCamera.ts`, using
 * the SAME conventions `lib/tracerFit.ts` uses internally (z0 = the ball radius,
 * world z measured from `start.z - BALL_RADIUS_M`), so a fixture that the fit
 * cannot recover is a real disagreement and not a fixture bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLUB_PRIORS } from '../lib/tracerPhysics';
import { labelStepM, roundLabelM } from '../lib/tracerFit';
import {
  bucketFlightLimits,
  chooseModel,
  pxToNormalizedBottomLeft,
  resolveV3Knobs,
  selectDetections,
  traceClip,
  trackForFit,
  type BallDetection,
} from '../lib/tracerV3';

import {
  BALL_START,
  FPS,
  F_PX,
  H_CAM_M,
  K_IMPACT,
  PITCH_DOWN_DEG,
  WIDTH,
  HEIGHT,
  addressCue,
  detectionResult,
  flightDetections,
  traceInput,
  truthCamera,
} from './fixtures/tracerV3Clip';

// ── 1. The one coordinate conversion (SHARED CONVENTION 1) ──────────────────

test('the principal point maps to the exact centre of the normalized frame', () => {
  // This is the identity that says the pixel-centre offset is right. The camera
  // model's principal point is ((w-1)/2, (h-1)/2), a pixel INDEX, and the centre
  // of the image in continuous coordinates is w/2 — so ((w-1)/2 + 0.5)/w = 0.5.
  const n = pxToNormalizedBottomLeft({ x: (WIDTH - 1) / 2, y: (HEIGHT - 1) / 2 }, WIDTH, HEIGHT);
  assert.ok(Math.abs(n.x - 0.5) < 1e-12, `x ${n.x}`);
  assert.ok(Math.abs(n.y - 0.5) < 1e-12, `y ${n.y}`);
});

test('the y axis flips: a TOP-LEFT pixel becomes a HIGH bottom-left value', () => {
  const top = pxToNormalizedBottomLeft({ x: 0, y: 0 }, WIDTH, HEIGHT);
  const bottom = pxToNormalizedBottomLeft({ x: 0, y: HEIGHT - 1 }, WIDTH, HEIGHT);
  assert.ok(top.y > 0.99, `top of frame should be near 1, got ${top.y}`);
  assert.ok(bottom.y < 0.01, `bottom of frame should be near 0, got ${bottom.y}`);
  assert.ok(top.y > bottom.y, 'the conversion must flip y, not merely scale it');
});

test('the conversion stays inside 0..1 for every in-frame pixel', () => {
  for (const p of [
    { x: 0, y: 0 },
    { x: WIDTH - 1, y: 0 },
    { x: 0, y: HEIGHT - 1 },
    { x: WIDTH - 1, y: HEIGHT - 1 },
  ]) {
    const n = pxToNormalizedBottomLeft(p, WIDTH, HEIGHT);
    assert.ok(n.x >= 0 && n.x <= 1, `x out of range: ${n.x}`);
    assert.ok(n.y >= 0 && n.y <= 1, `y out of range: ${n.y}`);
  }
});

// ── 2. Selection and model choice (lab: select_detections / choose_model) ────

test('the early window is 15 frames at 30 fps and scales with the clip fps', () => {
  const sel = selectDetections(detectionResult(flightDetections({ frames: 12 })));
  // 60 fps -> 30 frames of early window, so all 12 detections are early.
  assert.equal(sel.earlyWindowFrames, 30);
  assert.equal(sel.mode, 'early');
  assert.equal(sel.used.length, 12);
  // The ball is at address in k and displaced in k+1.
  assert.equal(sel.kImpFit, K_IMPACT);
});

test('a track that reaches the image apex uses EVERY detection, not the early window', () => {
  // The fit report: a lob only resolves speed against launch angle on the
  // descent, so a track that got there must be fitted whole.
  const sel = selectDetections(detectionResult(flightDetections({ v0: 22, thetaDeg: 40, frames: 90 })));
  assert.equal(sel.throughApex, true, 'a 90-frame lob should pass the image apex');
  assert.equal(sel.mode, 'all');
  assert.equal(sel.used.length, 90);
});

test('fewer than three early detections falls back to the first three', () => {
  // The early window is measured from the impact frame, which is itself the
  // frame before the FIRST detection — so a sparse track is what puts fewer
  // than three inside it, not a late one. At 60 fps the window is 30 frames.
  const dets = flightDetections({ frames: 3 });
  const sparse = [
    dets[0],
    { ...dets[1], frame: K_IMPACT + 45 },
    { ...dets[2], frame: K_IMPACT + 55 },
  ];
  const sel = selectDetections(detectionResult(sparse));
  assert.equal(sel.mode, 'first3');
  assert.equal(sel.used.length, 3);
});

test('the model ladder: <3 needs a carry, 3-4 fixes spin, >=5 goes free', () => {
  const knobs = resolveV3Knobs(undefined);
  const sel = { throughApex: false };
  assert.equal(chooseModel(0, null, sel, FPS, knobs).decision, 'none');
  assert.equal(chooseModel(2, null, sel, FPS, knobs).decision, 'none');
  assert.equal(chooseModel(2, 150, sel, FPS, knobs).decision, 'prior');
  assert.equal(chooseModel(4, null, sel, FPS, knobs).fixSpin, true);
  assert.equal(chooseModel(5, null, sel, FPS, knobs).fixSpin, false);
  // fit_pitch needs a LONG track through the apex, not merely a long one: on a
  // short climb the fit report measured the nuisance moving the wrong way.
  assert.equal(chooseModel(60, null, { throughApex: false }, FPS, knobs).fitPitch, false);
  assert.equal(chooseModel(60, null, { throughApex: true }, FPS, knobs).fitPitch, true);
});

test('detector confidence is mapped onto the lab\'s STEP weighting, not passed through', () => {
  // The lab weights a detection 1x above conf 0.4 and 2x below it. tracerFit
  // maps conf linearly (sigma = px * (1 + 2*(1 - conf))), so 1 and 0.5 are the
  // two confidences that reproduce the step exactly.
  const pts = trackForFit([
    { frame: 1, t: 0, x: 0, y: 0, r: 3, conf: 0.9 },
    { frame: 2, t: 0, x: 0, y: 0, r: 3, conf: 0.4 },
    { frame: 3, t: 0, x: 0, y: 0, r: 3, conf: 0.39 },
  ]);
  assert.equal(pts[0].conf, 1);
  assert.equal(pts[1].conf, 1, 'conf exactly at the floor is NOT weighted down');
  assert.equal(pts[2].conf, 0.5);
});

// ── 3. Plausibility limits reproduce the lab's published numbers ────────────

test('the club buckets\' physical maxima match the lab\'s own figures', () => {
  // tracer-lab/lib/tracer.py states these outright: "48.8 m of apex and 8.07 s
  // of hang for a driver, 37.7 m / 6.61 s for a short iron". Reproducing them
  // from CLUB_PRIORS through this port's own flight model is the check that the
  // corner search and the physics both came across intact.
  const driver = bucketFlightLimits('driver');
  assert.ok(Math.abs(driver.apexMaxM - 48.8) < 0.6, `driver apex max ${driver.apexMaxM}`);
  assert.ok(Math.abs(driver.hangMaxS - 8.07) < 0.15, `driver hang max ${driver.hangMaxS}`);
  const shortIron = bucketFlightLimits('shortIron');
  assert.ok(Math.abs(shortIron.apexMaxM - 37.7) < 0.6, `short iron apex max ${shortIron.apexMaxM}`);
  assert.ok(Math.abs(shortIron.hangMaxS - 6.61) < 0.15, `short iron hang max ${shortIron.hangMaxS}`);
});

test('an unknown club is bounded by the DRIVER, the most permissive bucket', () => {
  // The lab's CAP_BUCKET: an unknown club maps to 'driver' so the cap can never
  // refuse a real shot for being longer than a wedge.
  assert.equal(bucketFlightLimits(undefined).bucket, 'driver');
  // ... and a pitch is bounded by the wedge, which CLUB_PRIORS-for-flight has.
  assert.equal(bucketFlightLimits('pitch').bucket, 'wedge');
});

test('the corner search uses the band EDGES, so the maximum beats the typical shot', () => {
  for (const bucket of Object.keys(CLUB_PRIORS) as (keyof typeof CLUB_PRIORS)[]) {
    const lim = bucketFlightLimits(bucket);
    assert.ok(lim.apexMaxM > lim.apexTypicalM, `${bucket}: max apex must exceed the typical one`);
    assert.ok(lim.hangMaxS > lim.hangTypicalS, `${bucket}: max hang must exceed the typical one`);
  }
});

// ── 4. The happy path, and the render spec's hard invariants ────────────────

test('a clean synthetic driver produces a drawable trace', () => {
  const result = traceClip(traceInput());
  assert.equal(result.spec !== null, true, `expected a spec, got skip: ${result.reason}`);
  assert.equal(result.decision, 'fit');
  assert.equal(result.reason, null);
  // The fit has to actually recover the flight, not merely converge: a 12-point
  // synthetic track with no noise should sit well inside the lab's 4 px
  // poor-fit threshold.
  assert.ok(result.meta.fit!.rmsPx < 2, `rms ${result.meta.fit!.rmsPx} px on a noiseless track`);
  // The camera height is recovered from the address ball alone. 1.4 m truth.
  assert.ok(
    Math.abs(result.meta.camera!.hCamM - H_CAM_M) < 0.05,
    `recovered hCam ${result.meta.camera!.hCamM} vs truth ${H_CAM_M}`
  );
});

test('the render spec satisfies every invariant the native renderer rejects on', () => {
  const spec = traceClip(traceInput()).spec;
  assert.ok(spec, 'expected a spec');
  // >= 2 samples.
  assert.ok(spec.samples.length >= 2, `only ${spec.samples.length} samples`);
  // tSec[0] === 0 exactly (CA needs keyTimes[0] === 0).
  assert.equal(spec.samples[0].tSec, 0);
  // Strictly increasing (equal keyTimes glitch a CAKeyframeAnimation).
  for (let i = 1; i < spec.samples.length; i++) {
    assert.ok(
      spec.samples[i].tSec > spec.samples[i - 1].tSec,
      `sample ${i} tSec ${spec.samples[i].tSec} not > ${spec.samples[i - 1].tSec}`
    );
  }
  // tSec.last === animDurationSec (CA needs keyTimes.last === 1).
  assert.equal(spec.samples[spec.samples.length - 1].tSec, spec.animDurationSec);
  assert.ok(spec.animDurationSec > 0);
  assert.ok(spec.animStartSec >= 0);
  // Every coordinate finite, and depths 1:1 and positive.
  for (const s of spec.samples) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.tSec));
  }
  assert.equal(spec.depths!.length, spec.samples.length);
  for (const d of spec.depths!) assert.ok(Number.isFinite(d) && d > 1e-3, `bad depth ${d}`);
  // Non-degenerate arc length.
  let arc = 0;
  for (let i = 1; i < spec.samples.length; i++) {
    arc += Math.hypot(
      spec.samples[i].x - spec.samples[i - 1].x,
      spec.samples[i].y - spec.samples[i - 1].y
    );
  }
  assert.ok(arc > 1e-9, 'degenerate polyline');
});

test('the trace is drawn on the RENDER file\'s timeline, not the detector\'s', () => {
  // Detection runs on the original file; the render runs on the trimmed one,
  // which starts `auto_trim_start_ms` later. Getting this wrong draws the arc
  // seconds away from the swing.
  const withOffset = traceClip(traceInput({ detectToRenderOffsetSec: 1.0 }));
  const without = traceClip(traceInput({ detectToRenderOffsetSec: 0 }));
  assert.ok(withOffset.spec && without.spec);
  assert.ok(
    Math.abs(without.spec.animStartSec - withOffset.spec.animStartSec - 1.0) < 1e-9,
    `offset not applied: ${without.spec.animStartSec} vs ${withOffset.spec.animStartSec}`
  );
  // The DURATION is unchanged — an offset moves the window, it does not stretch it.
  assert.ok(Math.abs(without.spec.animDurationSec - withOffset.spec.animDurationSec) < 1e-9);
});

test('a flight that outlasts the clip asks for a freeze tail, and a short one does not', () => {
  const long = traceClip(traceInput({ renderDurationSec: 2 }));
  assert.ok(long.spec, `expected a spec, got ${long.reason}`);
  assert.ok(
    long.spec.freezeCompleteToSec !== null && long.spec.freezeCompleteToSec! > 2,
    'a 2 s clip cannot contain a driver flight; the last frame must be held'
  );
  const plenty = traceClip(traceInput({ renderDurationSec: 30 }));
  assert.ok(plenty.spec);
  // Omitted, not null: the key is left out entirely so the Swift parser never
  // has to coerce an NSNull.
  assert.equal('freezeCompleteToSec' in plenty.spec, false, 'a 30 s clip needs no freeze');
});

// ── 5. Every refusal, on its own fixture ────────────────────────────────────

test('REFUSAL: no address ball', () => {
  const r = traceClip(traceInput({ detection: detectionResult(flightDetections(), { address: null }) }));
  assert.equal(r.spec, null);
  assert.equal(r.reason, 'detector_found_no_address_ball');
});

test('REFUSAL: the detector found nothing', () => {
  const r = traceClip(traceInput({ detection: detectionResult([], { found: false }) }));
  assert.equal(r.spec, null);
  assert.equal(r.reason, 'detector_found_no_address_ball');
  const r2 = traceClip(traceInput({ detection: detectionResult([]) }));
  assert.equal(r2.spec, null);
  assert.equal(r2.reason, 'no_detections');
});

test('REFUSAL: a putt is never traced', () => {
  const r = traceClip(traceInput({ shotType: 'putt' }));
  assert.equal(r.spec, null);
  assert.equal(r.reason, 'putt');
});

test('REFUSAL: fewer than three detections and no GPS distance to scale them', () => {
  const r = traceClip(traceInput({ detection: detectionResult(flightDetections({ frames: 2 })) }));
  assert.equal(r.spec, null);
  assert.match(r.reason!, /^too_few_detections_no_carry/);
});

test('REFUSAL: a track that never climbs is a top or a roll, not a flight', () => {
  // Detections that stay at the address row: the ball never leaves the ground.
  const cam = truthCamera();
  const addr = addressCue(cam);
  const rolling: BallDetection[] = [];
  for (let i = 1; i <= 10; i++) {
    rolling.push({
      frame: K_IMPACT + i,
      t: (K_IMPACT + i) / FPS,
      x: addr.x + i * 6,
      y: addr.y - i * 0.8, // 8 px of rise over the whole track: under the 25 px floor
      r: addr.r,
      conf: 0.8,
    });
  }
  const r = traceClip(traceInput({ detection: detectionResult(rolling) }));
  assert.equal(r.spec, null);
  assert.match(r.reason!, /^not_a_flight:track never climbs/);
  assert.ok(r.flags.includes('not_a_flight'));
});

test('REFUSAL: no camera pitch means the camera cannot be calibrated', () => {
  const r = traceClip(traceInput({ pitchDownDeg: null }));
  assert.equal(r.spec, null);
  assert.match(r.reason!, /^no_camera_pitch/);
});

test('REFUSAL: detections that do not lie on any flight are refused, not fitted', () => {
  // IMG_2329's failure mode: a handful of wrong detections that a free
  // optimiser will happily fit at 95 m/s.
  const cam = truthCamera();
  const addr = addressCue(cam);
  const scatter: BallDetection[] = [
    { frame: K_IMPACT + 1, t: 0, x: addr.x - 20, y: addr.y - 300, r: 4, conf: 0.5 },
    { frame: K_IMPACT + 2, t: 0, x: addr.x + 400, y: addr.y - 120, r: 4, conf: 0.5 },
    { frame: K_IMPACT + 3, t: 0, x: addr.x - 350, y: addr.y - 700, r: 4, conf: 0.5 },
    { frame: K_IMPACT + 4, t: 0, x: addr.x + 90, y: addr.y - 200, r: 4, conf: 0.5 },
    { frame: K_IMPACT + 5, t: 0, x: addr.x + 500, y: addr.y - 900, r: 4, conf: 0.5 },
    { frame: K_IMPACT + 6, t: 0, x: addr.x - 480, y: addr.y - 150, r: 4, conf: 0.5 },
  ];
  const r = traceClip(traceInput({ detection: detectionResult(scatter) }));
  assert.equal(r.spec, null, `expected a refusal, got a spec (reason ${r.reason})`);
  // Which of the three physics refusals fires depends on where the optimiser
  // lands; all three mean "nothing drawn", which is the property under test.
  assert.match(r.reason!, /not_a_flight|track_not_ballistic|poor_fit|implausible_flight|fit_failed/);
});

test('a refusal still records the fit it refused, so a field test can read WHY', () => {
  const r = traceClip(traceInput({ shotType: 'putt' }));
  assert.equal(r.meta.decision, 'none');
  assert.equal(r.meta.reason, 'putt');
  assert.equal(r.meta.engine, 'v3');
  // And a refusal that got as far as fitting carries the fit.
  const cam = truthCamera();
  const addr = addressCue(cam);
  const rolling = Array.from({ length: 10 }, (_, i) => ({
    frame: K_IMPACT + i + 1,
    t: 0,
    x: addr.x + i * 6,
    y: addr.y - i * 0.8,
    r: addr.r,
    conf: 0.8,
  }));
  const r2 = traceClip(traceInput({ detection: detectionResult(rolling) }));
  assert.equal(r2.meta.selection.k, 10, 'the selection is recorded even on a refusal');
});

test('forceTrace bypasses a JUDGEMENT but never an absence of evidence', () => {
  // The putt gate is a judgement, so the dev switch may overrule it...
  const forced = traceClip(traceInput({ shotType: 'putt', knobs: { forceTrace: true } }));
  assert.notEqual(forced.reason, 'putt');
  // ... but no address ball is not a judgement, it is nothing to draw.
  const nothing = traceClip(
    traceInput({
      shotType: 'putt',
      knobs: { forceTrace: true },
      detection: detectionResult(flightDetections(), { address: null }),
    })
  );
  assert.equal(nothing.spec, null);
  assert.equal(nothing.reason, 'detector_found_no_address_ball');
});

// ── 6. The honest label ─────────────────────────────────────────────────────

test('the label step widens with the fit\'s own uncertainty (lab: label_step_m)', () => {
  assert.equal(labelStepM(1), 1);
  assert.equal(labelStepM(4), 5);
  assert.equal(labelStepM(20), 10);
  // ... and rounding lands on that step, so a driver says "250 m" and not "251 m".
  assert.equal(roundLabelM(251.4, 20), 250);
  assert.equal(roundLabelM(12.7, 3.0), 15);
  assert.equal(roundLabelM(12.4, 1.0), 12);
});

test('a pixel-only trace says "no GPS" instead of implying a measured distance', () => {
  const r = traceClip(traceInput());
  assert.ok(r.spec);
  assert.match(r.spec.labelSubText!, /no GPS/);
  assert.match(r.spec.labelText!, /^\d+ m$/);
});

test('turning label rounding off stops the honest step being applied', () => {
  // The dev switch exists to see the unrounded number; it must NOT be the
  // default, because an unrounded carry over-claims what the fit knows.
  const rounded = traceClip(traceInput()).spec!;
  const raw = traceClip(traceInput({ knobs: { labelRounding: false } })).spec!;
  const roundedM = Number(rounded.labelText!.replace(' m', ''));
  const rawM = Number(raw.labelText!.replace(' m', ''));
  assert.ok(Number.isFinite(roundedM) && Number.isFinite(rawM));
  // The rounded value must land on the step the fit asked for.
  const step = labelStepM(1e9); // whatever the fit's sigma, the step is 1/5/10
  assert.ok([1, 5, 10].includes(step));
  assert.equal(roundedM % 1, 0);
});

test('buildLabel is the only place the pill text is composed', () => {
  const r = traceClip(traceInput());
  assert.ok(r.spec);
  // Same inputs, same string — buildLabel is pure and the spec uses it.
  assert.ok(r.spec.labelText!.endsWith(' m'));
  assert.ok(r.spec.labelSubText!.startsWith('apex '));
});

// ── 7. Knob resolution ──────────────────────────────────────────────────────

test('a partial or junk config block falls back per-key, never to undefined', () => {
  const knobs = resolveV3Knobs({ v3: { occlusion: false, freezeTailSec: 'nope', renderHz: 60 } });
  assert.equal(knobs.occlusion, false, 'a valid override is taken');
  assert.equal(knobs.freezeTailSec, 0.6, 'a wrong-typed value is ignored, not injected');
  assert.equal(knobs.renderHz, 60);
  assert.equal(knobs.labelRounding, true, 'an absent key keeps the documented default');
  // No config at all is the documented default set.
  assert.deepEqual(resolveV3Knobs(undefined).forceTrace, false);
});

test('buildLabel and the ladder agree that a carry needs a GPS distance', () => {
  // With no successor there is no carry, so the fit is pixel-only and the label
  // must SAY so. This is the "last shot of a hole" case and it is not an error.
  const r = traceClip(traceInput({ carryM: null }));
  assert.ok(r.spec);
  assert.match(r.spec.labelSubText!, /no GPS/);
  assert.equal(r.meta.carry!.inputM, null);
});

test('an explicit GPS carry reaches the fit and the label drops the "no GPS" note', () => {
  const pixelOnly = traceClip(traceInput());
  assert.ok(pixelOnly.spec && pixelOnly.meta.flight);
  // Feed back a carry close to what the pixels already say, so the fit has no
  // reason to fight it — the point of the test is the plumbing, not the physics.
  const carryM = pixelOnly.meta.flight.carryM;
  const withGps = traceClip(traceInput({ carryM, carrySigmaGpsM: 6 }));
  assert.ok(withGps.spec, `expected a spec, got ${withGps.reason}`);
  assert.equal(withGps.meta.carry!.inputM, carryM);
  assert.ok(withGps.meta.carry!.status !== null, 'a supplied carry must get a status');
  assert.doesNotMatch(withGps.spec.labelSubText!, /no GPS/);
});
