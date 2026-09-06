/**
 * The adversarial probes, made permanent.
 *
 * WHERE THESE COME FROM. The `skeptic` agent wrote nine probe files against
 * `lib/tracerV3.ts`, ran them, found three blockers, and then DELETED them
 * (`docs/tracer-v3/review.md`, header). That is the wrong way round: the probes
 * are the most valuable thing that review produced, because they are the only
 * automated statement that this feature refuses rather than invents. A finding
 * gets fixed once; a probe stops it coming back.
 *
 * So this file is the probes rebuilt as committed tests, plus one reproduction
 * for each blocking finding — each of which FAILED before the fix that carries
 * its id and passes after it.
 *
 * WHAT THESE TESTS ARE NOT. They are not a claim that the pipeline can tell a
 * golf shot from a divot. It cannot, and F14 of the review says so plainly: the
 * ladder's floor for "this is a flight" is v0 >= 8 m/s, apex >= 0.3 m and
 * hang >= 0.4 s, and a real flying object that clears all three gets drawn. The
 * discrimination lives UPSTREAM, in the Swift detector's address-ball
 * anchoring, its pose-skeleton veto and its confidence floor. Where a fixture
 * below skips, the reason it skips is asserted, so that a future change which
 * makes it skip for a different reason — or stop skipping — is visible rather
 * than silently absorbed.
 *
 * The fixtures are synthetic, for the reason `tests/tracerV3.test.ts` gives:
 * only a simulated flight projected through a known camera has a truth to
 * compare against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../constants/config';
import { BALL_RADIUS_M, simulate } from '../lib/tracerPhysics';
import { TracerCamera } from '../lib/tracerCamera';
import { traceClip, type BallDetection, type TraceClipResult } from '../lib/tracerV3';

import {
  BALL_START,
  FPS,
  F_PX,
  HEIGHT,
  H_CAM_M,
  K_IMPACT,
  PITCH_DOWN_DEG,
  T0_SEC,
  WIDTH,
  addressCue,
  detectionResult,
  flightDetections,
  traceInput,
  truthCamera,
} from './fixtures/tracerV3Clip';
// The 4K/30 fps short-track fixture. Namespaced rather than destructured because
// every name in it collides with the one above, and the whole point of §3b is
// that the two geometries answer differently.
import * as shortTrack from './fixtures/tracerV3ShortTrack';
// The 1440x2560 flat-launch fixture, namespaced for the same reason. It exists
// because GATE-1 lives in the band BETWEEN the other two — see §3c and the
// fixture's own header.
import * as flatTension from './fixtures/tracerV3FlatTension';

/** A refusal, with the reason it gave — `reason` is what a field test reads. */
function refusal(r: TraceClipResult): string {
  assert.equal(r.spec, null, `expected a SKIP, got a drawn arc: ${JSON.stringify(r.spec?.labelText)}`);
  assert.equal(r.decision, 'none');
  assert.ok(r.reason, 'a skip must always carry a reason');
  return r.reason as string;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Absence of evidence. Nothing here may ever draw, and `forceTrace` — the
//    dev bypass — must not reach any of them: it bypasses JUDGEMENTS about a
//    shot, never the question of whether there is a shot at all.
// ═══════════════════════════════════════════════════════════════════════════

test('a detector that found no address ball never draws, with or without the bypass', () => {
  for (const knobs of [undefined, { forceTrace: true }]) {
    assert.match(
      refusal(traceClip(traceInput({ detection: detectionResult(flightDetections(), { address: null }), knobs }))),
      /detector_found_no_address_ball/
    );
    assert.match(
      refusal(traceClip(traceInput({ detection: detectionResult([], { found: false }), knobs }))),
      /detector_found_no_address_ball/
    );
  }
});

test('no detections, and one or two without a GPS carry, never draw', () => {
  assert.match(refusal(traceClip(traceInput({ detection: detectionResult([]) }))), /no_detections/);
  for (const n of [1, 2]) {
    assert.match(
      refusal(traceClip(traceInput({ detection: detectionResult(flightDetections({ frames: n })) }))),
      new RegExp(`too_few_detections_no_carry\\(${n}\\)`)
    );
  }
  // The bypass does not reach these either — there is nothing to draw FROM.
  assert.match(
    refusal(traceClip(traceInput({ detection: detectionResult([]), knobs: { forceTrace: true } }))),
    /no_detections/
  );
});

test('a track of 1-2 detections plus a carry is prior-driven and says so in every field', () => {
  // REVIEW F7, recorded rather than fixed — the review lists it as a latent
  // hazard, not a live one, and fixing it was explicitly out of scope for this
  // pass. What the club prior, the GPS scale and a single pixel produce here is
  // a beautiful arc pointing wherever that pixel was, and `checkFlightPlausible`
  // cannot catch it because a prior-driven fit is bounded plausible by
  // construction.
  //
  // It is unreachable from the app: the Swift detector will not emit a track
  // shorter than `minTrackEmit`, which is 3. That guard lives two module
  // boundaries away, so this test pins BOTH halves — the config that keeps it
  // unreachable, and the flags that make it unmistakable in `tracer_meta` if a
  // future caller ever supplies detections from somewhere else.
  assert.ok(config.tracer.v3.detectMinTrackEmit >= 3, 'the detector must not emit a track the ladder cannot judge');
  for (const n of [1, 2]) {
    const r = traceClip(traceInput({
      detection: detectionResult(flightDetections({ frames: n })),
      carryM: 150,
      carrySigmaGpsM: 6,
    }));
    assert.equal(r.decision, 'prior', `K=${n} must be marked prior-driven`);
    assert.ok(r.flags.includes('prior'), `K=${n}: ${r.flags.join(';')}`);
    assert.ok(r.flags.includes(`few_frames:${n}`), `K=${n}: ${r.flags.join(';')}`);
    assert.ok(
      r.flags.some((f) => f.startsWith('underdetermined:')),
      `K=${n} must be flagged underdetermined: ${r.flags.join(';')}`
    );
  }
});

test('no camera pitch is a refusal, not a guessed pitch', () => {
  // A guessed pitch maps 1:1 into launch angle, so there is no honest default.
  assert.match(refusal(traceClip(traceInput({ pitchDownDeg: null }))), /no_camera_pitch/);
  assert.match(
    refusal(traceClip(traceInput({ pitchDownDeg: null, knobs: { forceTrace: true } }))),
    /no_camera_pitch/
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Things that are not a golf shot.
// ═══════════════════════════════════════════════════════════════════════════

/** A cap-like blob that barely moves: 7 frames, sub-pixel drift per frame. */
function capBlob(): BallDetection[] {
  const addr = addressCue(truthCamera());
  return Array.from({ length: 7 }, (_, i) => ({
    frame: K_IMPACT + 1 + i,
    t: (K_IMPACT + 1 + i) / FPS,
    x: addr.x + 40 + 0.4 * i,
    y: addr.y - 120 - 0.3 * i,
    r: 9,
    conf: 0.7,
  }));
}

test('a near-static blob is refused with or without a GPS carry', () => {
  // The reviewer's own case: a cap on the ground that the detector locked on to.
  // A GPS distance must not rescue it — a carry is a scale, not evidence that
  // anything flew.
  for (const carryM of [null, 150]) {
    const r = traceClip(traceInput({
      detection: detectionResult(capBlob()),
      carryM,
      carrySigmaGpsM: carryM === null ? null : 6,
    }));
    assert.match(refusal(r), /not_a_flight|implausible_flight|track_not_ballistic|poor_fit/, `carry=${carryM}`);
  }
});

test('a topped ball is refused on the physics floor, not on the residual', () => {
  // v0 12 m/s at 2 degrees: it moves, it is even fittable, and it never flies.
  const r = traceClip(traceInput({
    detection: detectionResult(flightDetections({ v0: 12, thetaDeg: 2, frames: 10 })),
  }));
  assert.match(refusal(r), /^not_a_flight:fitted/);
});

test('a rolling putt the classifier called a SWING is still refused', () => {
  // The `putt` rung only fires on the classifier's verdict. When the classifier
  // is wrong, the physics floor is what is left, and it has to hold on its own.
  const r = traceClip(traceInput({
    detection: detectionResult(flightDetections({ v0: 6, thetaDeg: 1, frames: 20 })),
    shotType: 'swing',
  }));
  assert.match(refusal(r), /^not_a_flight:fitted/);
});

test('a putt the classifier called a putt is refused before any fitting', () => {
  const r = traceClip(traceInput({ shotType: 'putt' }));
  assert.equal(refusal(r), 'putt');
  // No fit was run, so there is nothing to record about one.
  assert.equal(r.meta.ladder.length, 0);
  assert.equal(r.meta.fit, undefined);
});

test('a divot and a tossed ball, tracked as long as a real one would be, are refused', () => {
  // HONESTY, because this test is easy to over-read: these skip because the
  // ladder cannot fit 30 frames of them, NOT because anything recognised a
  // divot. Give it only the first 10 frames of the same object and it draws —
  // review F14, which is recorded and accepted, and which is why the reasons
  // are asserted rather than just the refusal.
  const divot = traceClip(traceInput({
    detection: detectionResult(flightDetections({ v0: 15, thetaDeg: 45, frames: 30 })),
  }));
  assert.match(refusal(divot), /^poor_fit:/);

  const toss = traceClip(traceInput({
    detection: detectionResult(flightDetections({ v0: 9, thetaDeg: 60, frames: 30 })),
  }));
  assert.match(refusal(toss), /^track_not_ballistic:/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. F1 — a wrong GPS carry must never be laundered into a confident label.
// ═══════════════════════════════════════════════════════════════════════════

test('F1: a 40 m GPS carry against a 200 m pixel track is thrown away, not folded in', () => {
  // THE REPRODUCTION. Before the fix this returned decision `fit`, carry 208.9,
  // apex 34.9 and the pill "210 m / apex 35 m" with the "no GPS" marker REMOVED
  // — the GPS having been used untested, because the spin-bound refit's
  // pixel-only companion had a singular covariance and the port answered
  // `carry_untested` instead of computing z with sigma = 0 (fit.py:889).
  //
  // A short GPS carry is not exotic: the golfer laid up, or the successor fix
  // landed on the cart path.
  const r = traceClip(traceInput({ carryM: 40, carrySigmaGpsM: 6 }));
  assert.ok(r.spec, 'the pixel track is good, so the arc itself is still drawn');
  assert.equal(r.decision, 'pixel_only_fallback', 'the GPS must be dropped, not believed');
  assert.match(r.spec.labelSubText ?? '', /no GPS/, 'and the pill must say the GPS was not used');
  // The distance shown must be the PIXEL one, nowhere near the 40 m reading.
  assert.ok(r.meta.flight, 'a drawn clip records its flight');
  assert.ok(
    r.meta.flight.carryM > 150,
    `the drawn carry must come from the pixels, got ${r.meta.flight.carryM.toFixed(1)} m`
  );
  // And the reason the GPS was dropped is on the row, for the field test to read.
  assert.match(String(r.meta.reason), /carry_inconsistent/);
});

test('F1: a carry_inconsistent raised by ANY ladder rung survives into the decision', () => {
  // The second half of F1. Even with the sigma-substitution fixed, reading the
  // verdict off `fit.flags` — the flags of whichever rung the ladder ENDED on —
  // lets a refit silently overwrite the primary's opinion. On this clip the
  // PRIMARY fit is the one that raises `carry_inconsistent`; the accepted
  // spin-bound rung is a different fit object.
  const r = traceClip(traceInput({ carryM: 40, carrySigmaGpsM: 6 }));
  const rungsThatSawIt = r.meta.ladder.filter((e) =>
    e.flags.some((f) => f.startsWith('carry_inconsistent'))
  );
  assert.ok(rungsThatSawIt.length > 0, 'the reproduction requires at least one rung to raise it');
  assert.ok(r.flags.includes('inconsistent'), `the decision must carry it: ${r.flags.join(';')}`);
});

test('F1: a GPS carry that AGREES with the pixels is still used', () => {
  // The fix must not turn into "always ignore the GPS". A carry near the pixel
  // answer has to survive, or the whole joint fit is dead weight.
  const pixelOnly = traceClip(traceInput());
  assert.ok(pixelOnly.meta.flight);
  const agreeing = pixelOnly.meta.flight.carryM;
  const r = traceClip(traceInput({ carryM: agreeing, carrySigmaGpsM: 6 }));
  assert.ok(r.spec, `an agreeing carry must still draw: ${r.reason}`);
  assert.notEqual(r.decision, 'pixel_only_fallback');
  assert.doesNotMatch(r.spec.labelSubText ?? '', /no GPS/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3b. GATE NEW-1 — the SECOND path to a confident wrong distance, through
//     `carry_as_scale`. F1 above closed the `carry_untested` one; this is the
//     rung nobody looked at (docs/tracer-v3/re-verify.md, NEW-1).
//
//     `lib/tracerFit.ts` tested `carry_as_scale` BEFORE `carry_inconsistent`,
//     so whenever the pixel-only carry sigma exceeded 15 % of the pixel carry —
//     which a SHORT track always does — the GPS distance became the depth scale
//     regardless of how far it disagreed, and the pill said so with no "no GPS"
//     marker, because the GPS genuinely had been used.
//
//     THE LAB IS NOT THE AUTHORITY HERE. `tracer-lab/lib/fit.py:907-920` has the
//     same ordering and `tracer.py:837` does nothing with the verdict but append
//     a flag, so this is a faithful port of a LAB DESIGN GAP. The lab renders
//     research clips for a human reading a CSV; this renders a number to a
//     golfer, and Henry's rule outranks fidelity: the feature may skip, and it
//     may draw a trace without a distance, but it must never show a confidently
//     wrong number.
// ═══════════════════════════════════════════════════════════════════════════

/** The gate agent's own ladder of nonsense readings against a ~250 m shot. */
const WRONG_GPS_CARRIES_M = [5, 10, 20, 40, 80];

/**
 * The product rule, machine-checked. A clip may skip, and it may draw an arc
 * with no distance — but any NUMBER it does state has to be close to the truth,
 * and any number not backed by a used GPS carry has to say "no GPS".
 */
function assertNeverConfidentlyWrong(
  r: ReturnType<typeof traceClip>,
  truthCarryM: number,
  what: string,
  /** Defaults to the 15 % the NEW-1 section uses. §3c passes 20 % and says why. */
  maxErrFrac = 0.15
): void {
  if (r.spec === null) {
    assert.ok(r.reason, `${what}: a skip must carry a reason`);
    return;
  }
  const label = r.spec.labelText ?? '';
  if (label === 'no distance' || (r.spec.labelSubText ?? '') === 'no distance') return;
  const drawn = r.meta.flight?.carryM;
  assert.ok(drawn != null, `${what}: a drawn clip records its flight`);
  const errFrac = Math.abs(drawn - truthCarryM) / truthCarryM;
  assert.ok(
    errFrac < maxErrFrac,
    `${what}: stated "${label}" for a ${truthCarryM.toFixed(0)} m shot ` +
      `(${(100 * errFrac).toFixed(0)} % out, drawn ${drawn.toFixed(1)} m)`
  );
}

/** True when the pill states a distance AND claims the GPS behind it. */
function isGpsBackedNumber(r: ReturnType<typeof traceClip>): boolean {
  return (
    r.spec !== null &&
    r.spec.labelText !== 'no distance' &&
    !/no GPS/.test(r.spec.labelSubText ?? '')
  );
}

test('NEW-1: this fixture reaches carry_as_scale at all — the 1080p60 one never does', () => {
  // The reproduction has to be LIVE, or every assertion below passes for the
  // wrong reason. `carry_as_scale` needs a pixel-only carry sigma above 15 % of
  // the carry; the sibling fixture's 60 fps track is tight enough that it never
  // gets there, which is exactly why the fix round before this one did not see
  // the finding. Checked, not assumed.
  const shortDet = shortTrack.detectionResult(shortTrack.flightDetections({ frames: 8 }));
  const shortPx = traceClip(shortTrack.traceInput({ detection: shortDet }));
  const asScale = traceClip(
    shortTrack.traceInput({
      detection: shortDet,
      carryM: shortPx.meta.flight!.carryM,
      carrySigmaGpsM: 6,
    })
  );
  assert.equal(asScale.meta.carry?.status, 'carry_as_scale', 'the short track must reach it');

  for (const frames of [8, 10, 12]) {
    const det = detectionResult(flightDetections({ frames }));
    const px = traceClip(traceInput({ detection: det }));
    if (!px.meta.flight) continue;
    const r = traceClip(
      traceInput({ detection: det, carryM: px.meta.flight.carryM, carrySigmaGpsM: 6 })
    );
    assert.notEqual(
      r.meta.carry?.status,
      'carry_as_scale',
      `the 1080p60 fixture at ${frames} frames must NOT reach it, or this section proves nothing`
    );
  }
});

test('NEW-1: a 5-80 m GPS carry against a ~250 m short track never draws a confident distance', () => {
  // THE REPRODUCTION, on the gate agent's own geometry. Before the fix, an
  // 8-frame driver whose pixels said 257 m drew "170 m", "170 m", "170 m",
  // "180 m" and "200 m" for these five readings — decision `fit`, status
  // `carry_as_scale`, and NO "· no GPS", because the GPS was used. Truth 251 m,
  // so -19 % to -33 %. A short GPS carry is not exotic: the golfer laid up, or
  // the successor fix landed on the cart path.
  for (const opts of [{ frames: 8 }, { frames: 10, rpmBack: 4200, v0: 68, thetaDeg: 16 }]) {
    const truth = shortTrack.truthSummary(opts);
    const det = shortTrack.detectionResult(shortTrack.flightDetections(opts));
    // The control that keeps this honest: with no GPS at all these pixels DO
    // produce a good number, so a pass below is the GPS being handled, not the
    // fixture being unfittable.
    const px = traceClip(shortTrack.traceInput({ detection: det }));
    assert.ok(px.spec, `pixel-only must draw: ${px.reason}`);
    assert.ok(
      Math.abs(px.meta.flight!.carryM - truth.carryM) / truth.carryM < 0.1,
      `pixel-only ${px.meta.flight!.carryM.toFixed(1)} vs truth ${truth.carryM.toFixed(1)}`
    );

    for (const carryM of WRONG_GPS_CARRIES_M) {
      const r = traceClip(shortTrack.traceInput({ detection: det, carryM, carrySigmaGpsM: 6 }));
      assertNeverConfidentlyWrong(r, truth.carryM, `${JSON.stringify(opts)} gps=${carryM}`);
      // And it is never the GPS that is being believed: either the ladder threw
      // it away, or the pill refused to state a distance at all.
      const gpsBacked =
        r.spec !== null &&
        r.spec.labelText !== 'no distance' &&
        !/no GPS/.test(r.spec.labelSubText ?? '');
      assert.equal(gpsBacked, false, `gps=${carryM} produced a GPS-backed number`);
    }
  }
});

test('NEW-1(b): a loose-but-agreeing pixel carry still reaches carry_as_scale, and the arc is still drawn', () => {
  // The verdict is kept — this is the case it was designed for, a GPS distance
  // setting a depth scale the pixels cannot see — but the PILL stops claiming a
  // measurement. The honest 1-sigma here is the pixel-only carry sigma (69 % of
  // the carry, ~89 m), which is far wider than the coarsest rounding step
  // `labelStepM` can offer, so no step describes the error and the distance is
  // dropped the way F4 drops it. The trace itself is unaffected.
  const opts = { frames: 10, rpmBack: 4200, v0: 68, thetaDeg: 16 };
  const det = shortTrack.detectionResult(shortTrack.flightDetections(opts));
  const px = traceClip(shortTrack.traceInput({ detection: det }));
  const agreeing = px.meta.flight!.carryM;
  const r = traceClip(shortTrack.traceInput({ detection: det, carryM: agreeing, carrySigmaGpsM: 6 }));

  assert.equal(r.meta.carry?.status, 'carry_as_scale', 'the verdict survives');
  assert.notEqual(r.decision, 'pixel_only_fallback', 'an AGREEING carry is not thrown away');
  assert.ok(r.spec, 'the arc is still drawn — only the number is withheld');
  assert.ok(r.spec.samples.length > 1, 'and it is a real polyline, not an empty one');
  assert.equal(r.spec.labelText, 'no distance');
  assert.equal(r.spec.labelSubText, 'GPS unchecked');
  assert.ok(
    r.flags.some((f) => f.startsWith('carry_as_scale_no_distance(')),
    `the row must say WHY the distance was withheld: ${r.flags.join(';')}`
  );
});

test('NEW-1: the fix did not turn the GPS off — an agreeing carry on a TIGHT track is still used and still labelled', () => {
  // The other half of the trade, and the reason this is not just "ignore GPS".
  // On a track the pixels DO pin, an agreeing carry stays `carry_consistent`,
  // the number is stated, and the "· no GPS" marker stays off because the GPS
  // really was used.
  const pixelOnly = traceClip(traceInput());
  assert.ok(pixelOnly.meta.flight);
  const r = traceClip(
    traceInput({ carryM: pixelOnly.meta.flight.carryM, carrySigmaGpsM: 6 })
  );
  assert.ok(r.spec, `an agreeing carry must still draw: ${r.reason}`);
  assert.equal(r.meta.carry?.status, 'carry_consistent');
  assert.match(r.spec.labelText ?? '', /^\d+ m$/, 'the distance is stated as a number');
  assert.doesNotMatch(r.spec.labelSubText ?? '', /no GPS/);
  assert.ok(
    !r.flags.some((f) => f.startsWith('carry_as_scale')),
    `a tight pixel carry is not an as-scale case: ${r.flags.join(';')}`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3c. GATE-1 — the THIRD path to a confident wrong distance, through
//     `carry_tension` (docs/tracer-v3/gate.md).
//
//     THE SAME BUG, ONE RUNG LOWER, FOR THE THIRD TIME. Review F1 found it at
//     `carry_untested`; gate NEW-1 found it at `carry_as_scale`; the gate agent
//     found it at `carry_tension`, and each time the cause was the same — a
//     disagreement test skipped, or diluted, by a sigma that was itself
//     unreliable. NEW-1(a) added the pixel-sigma-free z but tested it only when
//     `rel > 15 %`; the gate agent's clip had rel = 14.16 %, so the code
//     computed 4.3 sigma and never looked at it, came back `carry_tension`, and
//     drew "100 m" for a 164.6 m shot whose own pixels said 171.8 m. 39 % wrong,
//     GPS-backed, no "· no GPS" — worse than the reproduction NEW-1 closed.
//
//     SO THE FIX IS THRESHOLD-INDEPENDENT, AND SO ARE THESE TESTS. At the fit
//     level the second z-score is now part of the verdict on every fit that has
//     a carry (`tests/tracerFit.test.ts`, on real clips). At the product level
//     the rule below is an ALLOWLIST: `carry_consistent` is the only verdict
//     that licenses a GPS-backed number, so a rung added later is unverified
//     until someone deliberately says otherwise, rather than being the next
//     finding.
// ═══════════════════════════════════════════════════════════════════════════

/** GPS carries from a lay-up to a different hole, against a ~165 m shot. */
const TENSION_GPS_LADDER_M = [5, 10, 20, 40, 60, 80, 100, 120, 140, 165, 200, 250, 300, 400, 500];

/** The four geometries the gate agent's worst rows sat on: 4-8 detections, flat launch. */
const TENSION_GEOMETRIES = [
  { frames: 5, fps: 60 },
  { frames: 6, fps: 60 },
  { frames: 8, fps: 60 },
  { frames: 4, fps: 30 },
] as const;

function flatTensionClip(o: (typeof TENSION_GEOMETRIES)[number]) {
  return flatTension.detectionResult(flatTension.flightDetections(o), { fps: o.fps });
}

/** `COARSEST_LABEL_STEP_M` in lib/tracerV3.ts. Duplicated deliberately, for the reason
 *  `Z_INCONSISTENT_FOR_TEST` is: a test that read the constant it is checking would pass
 *  whatever that constant became. */
const COARSEST_LABEL_STEP_FOR_TEST = 10;
/** `Z_TENSION` in lib/tracerFit.ts, same reason. */
const Z_TENSION_FOR_TEST = 2.0;

/**
 * How much the pixel-only carry sigma DILUTES the ordinary consistency test on a
 * given clip: |z_no_pixel_sigma| / |z|, which is
 * `sqrt(1 + sc^2 / (sigma_D^2 + sigma_fpx^2))` — 1.0 when the pixel carry is tight
 * enough that dropping its sigma changes nothing, and rising without bound as that
 * sigma takes the test over. It is the one number that says whether a fixture can
 * reproduce GATE-1 at all.
 */
function zDilution(r: ReturnType<typeof traceClip>): number {
  const z = r.meta.carry?.z;
  const zn = r.meta.carry?.zNoPixelSigma;
  assert.ok(z != null && zn != null && Math.abs(z) > 1e-6, 'both z-scores must be recorded');
  return Math.abs(zn) / Math.abs(z);
}

test('GATE-1: this fixture reaches carry_tension in the diluted band NEITHER sibling reaches', () => {
  // The reproduction has to be LIVE or every assertion below passes for the wrong
  // reason, and "live" here is a narrow window rather than just "a third fixture".
  // GATE-1 needs BOTH of:
  //   - `rel <= 15 %`, so the `carry_as_scale` rung — the one NEW-1 fixed — never
  //     fires. `carry_tension` is only reachable below that threshold, because the
  //     verdict ladder tests as-scale first, so asserting the STATUS asserts it.
  //   - the pixel-only sigma nonetheless large enough to divide the ordinary z
  //     down below the 4-sigma bar while the pixel-sigma-free z stays above it.
  //     That is exactly `zDilution` above, and it is ~1.45 here.
  const det = flatTensionClip({ frames: 5, fps: 60 });
  const tension = traceClip(
    flatTension.traceInput({ detection: det, carryM: 100, carrySigmaGpsM: 6 })
  );
  assert.equal(tension.meta.carry?.status, 'carry_tension', 'the flat fixture must reach it');
  assert.ok(
    zDilution(tension) > 1.35,
    `and the ordinary z must be materially diluted here, or this is a duplicate of the ` +
      `NEW-1(a) test: dilution ${zDilution(tension).toFixed(2)}`
  );

  // Sibling 1, the 1080p60 12-frame clip: tight, so the two z-scores agree to a
  // few per cent and the second test buys almost nothing. A fix tuned on this
  // fixture cannot see GATE-1, which is why the round before this one did not.
  const tightPx = traceClip(traceInput());
  const tight = traceClip(
    traceInput({ carryM: tightPx.meta.flight!.carryM * 0.6, carrySigmaGpsM: 6 })
  );
  assert.equal(tight.meta.carry?.status, 'carry_tension', 'same rung, different band');
  assert.ok(
    zDilution(tight) < 1.2,
    `the tight fixture must NOT be diluted, or it would reproduce this on its own: ` +
      `${zDilution(tight).toFixed(2)}`
  );

  // Sibling 2, the 4K30 8-frame clip: `rel` is 34-69 %, so the same relative error
  // lands on `carry_as_scale` and belongs to NEW-1's reproduction, not this one.
  const shortDet = shortTrack.detectionResult(shortTrack.flightDetections({ frames: 8 }));
  const shortPx = traceClip(shortTrack.traceInput({ detection: shortDet }));
  const short = traceClip(
    shortTrack.traceInput({
      detection: shortDet,
      carryM: shortPx.meta.flight!.carryM * 0.7,
      carrySigmaGpsM: 6,
    })
  );
  assert.equal(
    short.meta.carry?.status,
    'carry_as_scale',
    'the 4K30 fixture is the as-scale band, not this one'
  );
});

test('GATE-1: a ~165 m shot with GPS carries from 5 m to 500 m never draws an unconfirmed GPS number', () => {
  // THE REPRODUCTION, and the class assertion in one: `carry_consistent` is the
  // ONLY verdict allowed to put a GPS-backed number on the pill. Before the fix,
  // `gps=80` on the 5-frame geometry was decision `fit`, status `carry_tension`,
  // and the pill read "100 m" / "apex 6 m" — no "· no GPS" — for a shot that
  // carried 164.6 m and whose own pixels said 171.8 m.
  //
  // The control that keeps this honest is asserted first: with no GPS at all
  // these pixels produce a good number, so a pass below is the GPS being handled
  // rather than the fixture being unfittable.
  for (const o of TENSION_GEOMETRIES) {
    const truth = flatTension.truthSummary(o).carryM;
    const det = flatTensionClip(o);
    const px = traceClip(flatTension.traceInput({ detection: det }));
    assert.ok(px.spec, `${JSON.stringify(o)}: pixel-only must draw: ${px.reason}`);
    assert.ok(
      Math.abs(px.meta.flight!.carryM - truth) / truth < 0.1,
      `${JSON.stringify(o)}: pixel-only ${px.meta.flight!.carryM.toFixed(1)} vs truth ${truth.toFixed(1)}`
    );

    for (const carryM of TENSION_GPS_LADDER_M) {
      const r = traceClip(flatTension.traceInput({ detection: det, carryM, carrySigmaGpsM: 6 }));
      const what = `${JSON.stringify(o)} gps=${carryM}`;
      const status = r.meta.carry?.status ?? null;
      if (isGpsBackedNumber(r)) {
        assert.equal(
          status,
          'carry_consistent',
          `${what}: a GPS-backed number on verdict "${status}" — ` +
            'only `carry_consistent` says the pixels confirmed the reading'
        );
      }
      // 20 %, not the 15 % §3b uses, and the reason is one row rather than a
      // hedge: at 8 frames a GPS reading of 120 m scores z = 1.99 against
      // Z_TENSION = 2.0, so the verdict is `carry_consistent` — the pixels
      // genuinely cannot refute it — and the pill states "130 m", 18.8 % out.
      // That row is NOT this finding, and the test below it says what it is.
      assertNeverConfidentlyWrong(r, truth, what, 0.2);
    }
  }
});

test('GATE-1: the two halves of the fix are distinguishable — one rejects the carry, one withholds the number', () => {
  // Both are needed and they fire in different places, so both are pinned. If a
  // later change closes one and quietly relies on the other, this fails.
  const det = flatTensionClip({ frames: 5, fps: 60 });

  // (a) At the FIT level: an 80 m reading is now `carry_inconsistent` and the
  //     ladder falls back to pixels. The ordinary z is 3.2 — INSIDE the 4-sigma
  //     bar — and the pixel-sigma-free z is 4.7. Asserting both is what makes
  //     this a reproduction of GATE-1 rather than of the round before it.
  const rejected = traceClip(
    flatTension.traceInput({ detection: det, carryM: 80, carrySigmaGpsM: 6 })
  );
  assert.equal(rejected.decision, 'pixel_only_fallback');
  assert.match(rejected.spec?.labelSubText ?? '', /no GPS/);
  const reason = rejected.meta.reason ?? '';
  assert.match(reason, /^carry_inconsistent\(z=/, `the reason names the verdict: ${reason}`);
  const zs = /z=([\d.]+)sigma,z_no_pixel_sigma=([\d.]+)sigma/.exec(reason);
  assert.ok(zs, `both z-scores must be on the row a field test reads: ${reason}`);
  assert.ok(Number(zs[1]) < 4, `the lab's own z did NOT catch it: ${zs[1]}`);
  assert.ok(Number(zs[2]) > 4, `the pixel-sigma-free z did: ${zs[2]}`);

  // (b) At the LABEL level: a 100 m reading stays `carry_tension` — the second
  //     z-score is 3.7, inside the bar too — so the arc is still drawn from the
  //     joint fit, but the pill refuses to state the distance. The honest sigma
  //     is 58 m against the fit's own 21 m, and the term that makes it 58 is the
  //     DISAGREEMENT: the GPS dragged the carry from the pixel-only companion's
  //     171.8 m down to 113.6 m, and nothing here knows which of the two is
  //     wrong. 58 m is wider than the coarsest step the pill has, so no rounding
  //     describes the error and the number is withheld the way F4 withholds it.
  const withheld = traceClip(
    flatTension.traceInput({ detection: det, carryM: 100, carrySigmaGpsM: 6 })
  );
  assert.equal(withheld.meta.carry?.status, 'carry_tension');
  assert.ok(Math.abs(withheld.meta.carry?.zNoPixelSigma ?? 0) < 4, 'not rejected by (a)');
  assert.ok(withheld.spec, 'the arc is still drawn — only the number is withheld');
  assert.ok(withheld.spec.samples.length > 1, 'and it is a real polyline, not an empty one');
  assert.equal(withheld.spec.labelText, 'no distance');
  assert.equal(withheld.spec.labelSubText, 'GPS unchecked');
  const flag = withheld.flags.find((f) => f.startsWith('carry_tension_no_distance('));
  assert.ok(flag, `the row must say WHICH verdict withheld it: ${withheld.flags.join(';')}`);
  const sigma = /honest_sigma=(\d+)m/.exec(flag as string);
  assert.ok(sigma && Number(sigma[1]) > COARSEST_LABEL_STEP_FOR_TEST, `and how wide: ${flag}`);
});

test('GATE-1: the fix did not turn the GPS off — a correct carry on this fixture is used and labelled', () => {
  // The cost side of the trade, on the geometry the fix was written for. A GPS
  // reading within +-5 % of truth stays `carry_consistent` on all four
  // geometries, states a number, and keeps the "· no GPS" marker OFF because the
  // GPS really was used. If this fails, the fix has become "ignore the GPS" and
  // the joint fit is dead weight.
  for (const o of TENSION_GEOMETRIES) {
    const truth = flatTension.truthSummary(o).carryM;
    const det = flatTensionClip(o);
    for (const mul of [0.95, 1.0, 1.05]) {
      const r = traceClip(
        flatTension.traceInput({ detection: det, carryM: truth * mul, carrySigmaGpsM: 6 })
      );
      const what = `${JSON.stringify(o)} x${mul}`;
      assert.ok(r.spec, `${what}: a correct carry must still draw: ${r.reason}`);
      assert.equal(r.meta.carry?.status, 'carry_consistent', what);
      assert.match(r.spec.labelText ?? '', /^\d+ m$/, `${what}: the distance is stated`);
      assert.doesNotMatch(r.spec.labelSubText ?? '', /no GPS/, what);
      assertNeverConfidentlyWrong(r, truth, what);
    }
  }
});

test('GATE-1: a genuinely tight pixel carry still gets its number, GPS or no GPS', () => {
  // The second control, on the sibling fixture the fix must not have touched at
  // all: 12 detections at 60 fps, where the pixels pin the flight on their own.
  // With no carry it states a number and says "· no GPS"; with an agreeing carry
  // it states a number and drops the marker. Neither is allowed to become
  // "no distance" — that would mean the honest-sigma rule had leaked out of the
  // unconfirmed-verdict branch and started eating good clips.
  const px = traceClip(traceInput());
  assert.ok(px.spec);
  assert.match(px.spec.labelText ?? '', /^\d+ m$/);
  assert.match(px.spec.labelSubText ?? '', /no GPS/);

  const r = traceClip(traceInput({ carryM: px.meta.flight!.carryM, carrySigmaGpsM: 6 }));
  assert.ok(r.spec);
  assert.equal(r.meta.carry?.status, 'carry_consistent');
  assert.match(r.spec.labelText ?? '', /^\d+ m$/, 'a confirmed carry still states its distance');
  assert.doesNotMatch(r.spec.labelSubText ?? '', /no GPS/);
  assert.ok(
    !r.flags.some((f) => f.includes('_no_distance(')),
    `nothing may withhold the number here: ${r.flags.join(';')}`
  );
});

test('GATE-1: the residue is the LABEL VOCABULARY, not the carry verdict — named, not hidden', () => {
  // What GATE-1's fix does NOT reach, pinned so nobody has to rediscover it.
  //
  // At 8 detections a GPS reading of 120 m against a 164.6 m shot scores z = 1.99
  // against Z_TENSION = 2.0. The verdict is `carry_consistent` — correctly: the
  // pixel-only carry is 168.6 m with a sigma wide enough that 120 m is a two-sigma
  // reading, and nothing in this pipeline knows which of the two is wrong. The
  // pill then states "130 m", 18.8 % from truth.
  //
  // That is not the carry ladder failing. It is `labelStepM` saturating: the
  // drawn fit's OWN 1-sigma is 26.8 m, nearly three times the coarsest rounding
  // step the pill has, so the number is stated at a precision the fit never
  // claimed. Fixing it means giving every label — including every pixel-only one,
  // where the sigma is routinely 30-40 m — a "too uncertain to state" rung, which
  // is a behaviour change to what the golfer sees on most clips and needs its own
  // decision. It is listed as out of scope in `docs/tracer-v3/fixes.md`.
  //
  // The assertions are on the things that are TRUE, not on the wrong number, so
  // this test keeps passing when that decision is taken.
  const det = flatTensionClip({ frames: 8, fps: 60 });
  const r = traceClip(flatTension.traceInput({ detection: det, carryM: 120, carrySigmaGpsM: 6 }));
  assert.equal(r.meta.carry?.status, 'carry_consistent', 'the verdict is not the failure here');
  assert.ok(
    Math.abs(r.meta.carry?.z ?? 0) < Z_TENSION_FOR_TEST,
    `and it is inside the tension bar by the fit's own arithmetic: z=${r.meta.carry?.z}`
  );
  assert.ok(
    (r.meta.sigmaTotal?.carryM ?? 0) > COARSEST_LABEL_STEP_FOR_TEST,
    `the fit's own sigma already exceeds the coarsest label step: ${r.meta.sigmaTotal?.carryM}`
  );
  // And a guard: whatever else changes, this must not get WORSE.
  assertNeverConfidentlyWrong(r, flatTension.truthSummary({ frames: 8, fps: 60 }).carryM, 'residue', 0.2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. F3a — the lens and the pinch zoom the clip was shot at.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The same 202 m drive, but SHOT at `zoom`x — i.e. projected through a camera
 * whose focal length is `zoom` times the one the app will supply. This is what
 * a pinch-zoomed clip actually hands the detector.
 */
function zoomedClip(zoom: number): { detections: BallDetection[]; address: { x: number; y: number; r: number } } {
  const cam = new TracerCamera({
    fPx: F_PX * zoom,
    width: WIDTH,
    height: HEIGHT,
    pitchDownDeg: PITCH_DOWN_DEG,
    rollDeg: 0,
    hCamM: H_CAM_M,
    fPxIsPrior: true,
  });
  const flight = simulate({ v0: 62, thetaDeg: 13, phiDeg: 4, rpmBack: 3000, rpmSide: 0, z0: BALL_RADIUS_M });
  const detections: BallDetection[] = [];
  for (let i = 1; i <= 12; i++) {
    const frame = K_IMPACT + i;
    const s = flight.at(frame / FPS - T0_SEC);
    const world = {
      x: BALL_START.x + s.x,
      y: BALL_START.y + s.y,
      z: BALL_START.z - BALL_RADIUS_M + s.z,
    };
    const uv = cam.project([world])[0];
    const axes = cam.sphereImageAxes(world);
    detections.push({ frame, t: frame / FPS, x: uv.x, y: uv.y, r: Math.sqrt(axes.aPx * axes.bPx), conf: 0.8 });
  }
  const a = cam.sphereImageAxes(BALL_START);
  return { detections, address: { x: a.centrePx.x, y: a.centrePx.y, r: Math.sqrt(a.aPx * a.bPx) } };
}

test('F3a: a clip shot at 1.5x zoom is refused rather than drawn at the wrong scale', () => {
  const { detections, address } = zoomedClip(1.5);
  const detection = detectionResult(detections, { address });

  // FIRST, the hazard itself, so this test is evidence and not decoration. With
  // the row claiming 1x and no zoom — which is what EVERY row said before the
  // capture columns existed — the ladder cannot see the rescale, the fit
  // converges, and a 202 m drive is drawn with a confident, badly wrong number.
  const blind = traceClip(traceInput({ detection, capture: { lens: '1x', zoom: 0 } }));
  assert.ok(blind.spec, 'the reproduction requires this to draw; if it no longer does, re-read F3a');
  assert.ok(blind.meta.flight);
  assert.ok(
    blind.meta.flight.carryM < 160,
    `the whole point is that it is badly short: ${blind.meta.flight.carryM.toFixed(1)} m against a 202 m truth`
  );

  // NOW with the row recording what the clip was actually shot at.
  const guarded = traceClip(traceInput({ detection, capture: { lens: '1x', zoom: 0.35 } }));
  assert.match(refusal(guarded), /^lens_unsupported:/);
});

test('F3a: the 0.5x lens, an unknown lens and a missing capture block are all refused', () => {
  for (const capture of [
    { lens: '0.5x', zoom: 0 },
    { lens: '0.5x', zoom: 0.4 },
    { lens: null, zoom: null },
    { lens: '1x', zoom: null },
    null,
    undefined,
  ]) {
    const r = traceClip(traceInput({ capture }));
    assert.match(
      refusal(r),
      /^lens_unsupported:/,
      `capture=${JSON.stringify(capture)} must be refused — unknown optics and 1x are the same input downstream, and only one is safe`
    );
  }
});

test('F3a: the lens refusal is an absence of input, so forceTrace cannot bypass it', () => {
  const r = traceClip(traceInput({ capture: { lens: '0.5x', zoom: 0 }, knobs: { forceTrace: true } }));
  assert.match(refusal(r), /^lens_unsupported:/);
});

test('F3a: a clip actually shot at 1x with no pinch is unaffected', () => {
  const r = traceClip(traceInput({ capture: { lens: '1x', zoom: 0 } }));
  assert.ok(r.spec, `the supported capture must still draw: ${r.reason}`);
  assert.equal(r.decision, 'fit');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. F2 — the impact slack. A late first detection must not cost the clip.
// ═══════════════════════════════════════════════════════════════════════════

test('F2: a first detection three frames late still fits, instead of skipping', () => {
  // THE REPRODUCTION. The detector loses the ball for the first frames after
  // impact, when it is fastest and blurriest — the review's own case. Before
  // the fix, dropping three early detections turned an rms-0.02 px fit into
  // `implausible_flight:apex 52.7 m`, with `t0_at_lower_bound` in the ladder
  // log saying the optimiser was pinned where it should not have been.
  const all = flightDetections({ frames: 16 });
  const truth = traceClip(traceInput({ detection: detectionResult(all) }));
  assert.ok(truth.meta.flight);
  const truthCarry = truth.meta.flight.carryM;

  const late = detectionResult(all.slice(3)); // launchFrame is still correct
  const r = traceClip(traceInput({ detection: late }));
  assert.ok(r.spec, `a 3-frame-late first detection must still draw: ${r.reason}`);
  assert.equal(r.meta.selection.impactSlackFrames, 3, 'the departure cue is what supplies the slack');
  assert.ok(r.meta.fit && r.meta.fit.rmsPx < 1, `and it must fit properly: rms ${r.meta.fit?.rmsPx}`);
  assert.ok(
    Math.abs(r.meta.flight!.carryM - truthCarry) < 5,
    `carry ${r.meta.flight!.carryM.toFixed(1)} m should still be the same shot as ${truthCarry.toFixed(1)} m`
  );
  assert.ok(
    !r.meta.ladder.some((e) => e.flags.includes('t0_at_lower_bound')),
    `t0 must not be pinned at its bound: ${r.meta.ladder.map((e) => e.flags.join(',')).join(' | ')}`
  );
});

test('F2: with no departure cue the slack falls back to the audio frame plus one', () => {
  // tracer.py:248-252 — with no `launch_frame` the CSV/audio impact frame is
  // used as the launch frame and ONE EXTRA frame of slack is added, because an
  // audio transient is not a departure. On this fixture the audio frame is 100
  // and the first detection is 101, so the slack is (101 - 100) + 1 = 2.
  const dets = flightDetections({ frames: 12 });
  const r = traceClip(traceInput({
    detection: detectionResult(dets, { launchFrame: null }),
  }));
  assert.equal(r.meta.selection.impactSlackFrames, 2);
  assert.ok(r.spec, `the clean clip must still draw: ${r.reason}`);

  // With the cue present and exact, the slack is zero — the departure IS known,
  // so nothing is being allowed for.
  const cued = traceClip(traceInput({ detection: detectionResult(dets) }));
  assert.equal(cued.meta.selection.impactSlackFrames, 0);
});

test('F2: the slack never lets t0 land AFTER the first detection', () => {
  // Only the lower bound moves. If the upper one moved with it, the fit could
  // put the launch after the ball was already seen in the air.
  const all = flightDetections({ frames: 16 });
  const r = traceClip(traceInput({ detection: detectionResult(all.slice(3)) }));
  assert.ok(r.meta.launch);
  const firstDetSec = all[3].frame / FPS;
  assert.ok(
    r.meta.launch.t0Sec < firstDetSec,
    `t0 ${r.meta.launch.t0Sec} must precede the first detection at ${firstDetSec}`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. F4 — a shot straight down the camera axis.
// ═══════════════════════════════════════════════════════════════════════════

test('F4: a shot down the camera axis is flagged and loses its distance', () => {
  // THE REPRODUCTION. At phi = 0 the geometry loses the SCALE as well as the
  // direction: the fit comes back at 0.64 px rms with apex 35.5 m against a
  // truth of 24.2 m — a 47 % error, and before this fix nothing flagged it and
  // the pill read "210 m / apex 35 m". "Down the line at the target" is the
  // app's own capture instruction, so this is the intended case, not an edge.
  const r = traceClip(traceInput({ detection: detectionResult(flightDetections({ phiDeg: 0, frames: 14 })) }));
  assert.ok(r.spec, 'drawing the line is fine — it is the number that is not supportable');
  assert.ok(
    r.flags.some((f) => f.startsWith('axis_degenerate')),
    `expected axis_degenerate: ${r.flags.join(';')}`
  );
  assert.doesNotMatch(r.spec.labelText ?? '', /\d/, 'the pill must not state a distance');
  assert.doesNotMatch(r.spec.labelSubText ?? '', /\d/, 'nor an apex');
});

test('F4: one degree of azimuth is enough, and does not lose its label', () => {
  // The degeneracy is razor-sharp, so the flag must not spread to shots that
  // are fine — on real footage the phone is never perfectly on the shot line,
  // and a flag that fires everywhere is a flag nobody reads.
  for (const phiDeg of [0.5, 1, 2, 4, 8, 15]) {
    const r = traceClip(traceInput({ detection: detectionResult(flightDetections({ phiDeg, frames: 14 })) }));
    assert.ok(r.spec, `phi=${phiDeg}: ${r.reason}`);
    assert.ok(
      !r.flags.some((f) => f.startsWith('axis_degenerate')),
      `phi=${phiDeg} must not be flagged degenerate: ${r.flags.join(';')}`
    );
    assert.match(r.spec.labelText ?? '', /^\d+ m$/, `phi=${phiDeg} must keep its distance`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. F5 — the "no GPS" marker is about provenance, not about supply.
// ═══════════════════════════════════════════════════════════════════════════

test('F5: a pixel-only fallback never claims GPS backing', () => {
  // `hasGps` used to mean "a carry was supplied", not "a carry was used", so a
  // clip whose GPS had been tested and REJECTED dropped the honesty marker —
  // the one thing that marker exists to say.
  for (const carryM of [40, 60, 100, 500]) {
    const r = traceClip(traceInput({ carryM, carrySigmaGpsM: 6 }));
    assert.ok(r.spec, `carry=${carryM}: ${r.reason}`);
    if (r.decision === 'pixel_only_fallback' || r.flags.some((f) => f.startsWith('joint_fit_rejected'))) {
      assert.match(
        r.spec.labelSubText ?? '',
        /· no GPS$/,
        `carry=${carryM} was drawn from pixels alone and must say so: "${r.spec.labelSubText}"`
      );
    }
  }
});

test('F5: a clip with no carry at all still says no GPS', () => {
  const r = traceClip(traceInput({ carryM: null }));
  assert.ok(r.spec);
  assert.match(r.spec.labelSubText ?? '', /· no GPS$/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. F8 — landing_depression_off must mean something.
// ═══════════════════════════════════════════════════════════════════════════

test('F8: a legitimate short shot does not carry landing_depression_off', () => {
  // THE REPRODUCTION. The port kept only the lab's flat-ground expectation
  // (f*h/carry, which assumes the ball was hit from under the lens) and dropped
  // `expected_range_px` (f*h/R, the landing's real ground range) along with the
  // docstring saying the two differ by tens of px on a short shot. The ball
  // here is teed 4 m in front of the camera, so a ~12 m chip fired the flag at
  // 142.7 px observed against a 190.7 px flat expectation — while the range
  // expectation is 142.1 px and the residual is under a pixel.
  const chip = traceClip(traceInput({
    detection: detectionResult(flightDetections({ v0: 10, thetaDeg: 50, frames: 30 })),
  }));
  assert.ok(chip.spec, `the chip must still draw: ${chip.reason}`);
  assert.ok(
    !chip.flags.includes('landing_depression_off'),
    `a genuine short shot must not be flagged: ${chip.flags.join(';')}`
  );
  const lc = chip.meta.landingCheck;
  assert.ok(lc, 'the landing check must be recorded');
  assert.ok(lc.landingGroundRangeM !== null && lc.landingGroundRangeM > 0, 'the ground range must be reported');
  assert.ok(lc.expectedRangePx1080 !== null, 'and the expectation it is judged against');
  assert.ok(lc.residualVsRangePx1080 !== null && Math.abs(lc.residualVsRangePx1080) < 5);
  // The flat number is kept for comparison with the lab's own reports, and on a
  // short shot it is visibly the WRONG one — which is the whole finding.
  assert.ok(
    lc.expectedFlatPx1080 - (lc.expectedRangePx1080 as number) > 15,
    `the two expectations must differ by more than the flag's own threshold on a short shot: ` +
      `flat ${lc.expectedFlatPx1080.toFixed(1)} vs range ${(lc.expectedRangePx1080 as number).toFixed(1)}`
  );
});

test('F8: a driver, where the two expectations agree, is unchanged', () => {
  const drive = traceClip(traceInput());
  assert.ok(drive.spec);
  assert.ok(!drive.flags.includes('landing_depression_off'));
  const lc = drive.meta.landingCheck;
  assert.ok(lc && lc.expectedRangePx1080 !== null);
  assert.ok(
    Math.abs(lc.expectedFlatPx1080 - lc.expectedRangePx1080) < 1,
    'on a 200 m drive the ball being 4 m in front of the lens is worth well under a pixel'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. The invariant behind all of the above.
// ═══════════════════════════════════════════════════════════════════════════

test('every refusal carries the diagnostic blob a field test is read from', () => {
  // A row that says "skipped" and nothing else is a row nobody can act on.
  const cases = [
    traceInput({ detection: detectionResult([], { found: false }) }),
    traceInput({ pitchDownDeg: null }),
    traceInput({ capture: { lens: '0.5x', zoom: 0 } }),
    traceInput({ detection: detectionResult(flightDetections({ v0: 12, thetaDeg: 2, frames: 10 })) }),
    traceInput({ detection: detectionResult(capBlob()) }),
  ];
  for (const input of cases) {
    const r = traceClip(input);
    assert.equal(r.spec, null);
    assert.equal(r.meta.engine, 'v3');
    assert.equal(r.meta.decision, 'none');
    assert.ok(r.meta.reason, 'the reason must be on the meta blob, not only on the result');
    assert.equal(r.meta.reason, r.reason);
    assert.ok(Array.isArray(r.meta.flags));
    assert.ok(typeof r.meta.elapsedMs === 'number');
  }
});
