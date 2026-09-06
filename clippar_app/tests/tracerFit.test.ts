import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TracerCamera, type CameraParams, type Px } from '../lib/tracerCamera';
import { BALL_RADIUS_M, CLUB_PRIORS, simulate } from '../lib/tracerPhysics';
import {
  fitLaunch,
  flightPixels,
  labelStepM,
  predictTrack,
  roundLabelM,
  type FitOptions,
  type FitResult,
  type TrackPoint,
} from '../lib/tracerFit';
import { clipFixture } from './fixtures/tracerFitClips';

// The lab's validation is what this suite transfers. Every reference number below is quoted
// from tracer-lab, with the file it came from, so a drifting port fails here and not on a phone:
//   holdout medians/maxima  → experiments/fit2/results/holdout.csv, variant `full`
//   synthetic K=5 tolerances → experiments/fit/test_fit.py + report §8
//   carry semantics          → experiments/fit2/report.md §2 (the sweep tables)

// ─── helpers ───

/** numpy's median: the mean of the two middle values for an even-length sample. */
function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

/** Deterministic Gaussian noise, so "1 px noise" means the same thing on every run. */
function gaussians(seed: number, n: number): number[] {
  let a = (seed + 1) >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

// ─── synthetic scene (tracer-lab experiments/fit/test_fit.py) ───

const FPS = 30;
const K_IMP = 200;
/** ~IMG_3640's geometry. */
const SYNTH_CAMERA: CameraParams = {
  fPx: 1504,
  width: 1080,
  height: 1920,
  hCamM: 1.31,
  pitchDownDeg: 5.6,
  rollDeg: 0,
  fPxIsPrior: true,
};
const SYNTH_ADDRESS: Px = { x: 348.65, y: 1110.38 };
const TRUE = { v0: 60, thetaDeg: 12, phiDeg: 3, rpmBack: 3000, tiltDeg: 8, t0Sec: (K_IMP + 0.4) / FPS };

function synth(
  o: {
    truth?: typeof TRUE;
    frames?: number[];
    noisePx?: number;
    seed?: number;
  } = {}
): TrackPoint[] {
  const truth = o.truth ?? TRUE;
  const frames = o.frames ?? [201, 202, 203, 204, 205];
  const noisePx = o.noisePx ?? 1;
  const cam = new TracerCamera(SYNTH_CAMERA);
  const fl = simulate({
    v0: truth.v0,
    thetaDeg: truth.thetaDeg,
    phiDeg: truth.phiDeg,
    rpmBack: truth.rpmBack,
    rpmSide: -truth.rpmBack * Math.tan((truth.tiltDeg * Math.PI) / 180),
    z0: BALL_RADIUS_M,
  });
  const start = cam.ballCentreFromPixel(SYNTH_ADDRESS);
  const pts = frames.map((k) => {
    const p = fl.at(k / FPS - truth.t0Sec);
    return { x: p.x + start.x, y: p.y + start.y, z: p.z + start.z - BALL_RADIUS_M };
  });
  const uv = cam.project(pts);
  const noise = gaussians(o.seed ?? 0, 2 * frames.length);
  return frames.map((k, i) => ({
    frame: k,
    x: uv[i].x + noisePx * noise[2 * i],
    y: uv[i].y + noisePx * noise[2 * i + 1],
  }));
}

type FitTweaks = Omit<Partial<FitOptions>, 'track' | 'camera' | 'addressPx' | 'impactFrame' | 'fps'>;

function fitSynth(track: TrackPoint[], extra: FitTweaks = {}): FitResult {
  return fitLaunch({
    track,
    camera: new TracerCamera(SYNTH_CAMERA),
    addressPx: SYNTH_ADDRESS,
    impactFrame: K_IMP,
    fps: FPS,
    bucket: 'driver',
    ...extra,
  });
}

// ─── 1. Synthetic round trip ───

test('synthetic K=5 at 1 px noise recovers the launch inside the lab tolerances', () => {
  const r = fitSynth(synth());
  assert.ok(r.ok, `fit not ok: ${r.flags.join(';')}`);
  assert.ok(Math.abs(r.params.v0 - TRUE.v0) / TRUE.v0 < 0.05, `v0 ${r.params.v0}`);
  assert.ok(Math.abs(r.params.thetaDeg - TRUE.thetaDeg) < 1.5, `theta ${r.params.thetaDeg}`);
  assert.ok(Math.abs(r.params.phiDeg - TRUE.phiDeg) < 1.0, `phi ${r.params.phiDeg}`);
  assert.ok(Math.abs(r.params.t0Sec - TRUE.t0Sec) * FPS < 0.15, `t0 ${r.params.t0Sec * FPS - K_IMP}`);
  assert.ok(r.rmsPx < 2.0, `rms ${r.rmsPx}`);
  // The formal sigma must cover the actual error for the well-identified parameters.
  for (const k of ['v0', 'thetaDeg', 'phiDeg'] as const) {
    const s = r.sigma[k];
    assert.ok(s != null && Math.abs(r.params[k] - TRUE[k]) < 3 * s + 1e-9, `${k}: ${r.params[k]} +-${s}`);
  }
});

test('synthetic K=5 speed accuracy over 20 noise seeds matches the lab (median |dv0| 3.0 %, max 6.4 %)', () => {
  const errs: number[] = [];
  for (let seed = 0; seed < 20; seed++) {
    const r = fitSynth(synth({ seed }), { mcSamples: 0 });
    errs.push(Math.abs(r.params.v0 - TRUE.v0) / TRUE.v0);
  }
  const med = median(errs);
  const max = Math.max(...errs);
  // Same guards the lab's own test uses. Measured here: reported in docs/tracer-v3/ts-fit.md.
  assert.ok(med < 0.04, `median |dv0| = ${(100 * med).toFixed(1)} %`);
  assert.ok(max < 0.10, `max |dv0| = ${(100 * max).toFixed(1)} %`);
});

test('reduced model with no noise is an exact round trip', () => {
  const truth = { ...TRUE, rpmBack: CLUB_PRIORS.driver.rpmBack[1], tiltDeg: 0 };
  const r = fitSynth(synth({ truth, noisePx: 0 }), { fixSpin: true, mcSamples: 0 });
  assert.ok(Math.abs(r.params.v0 - truth.v0) / truth.v0 < 0.003, `v0 ${r.params.v0}`);
  assert.ok(Math.abs(r.params.thetaDeg - truth.thetaDeg) < 0.05, `theta ${r.params.thetaDeg}`);
  assert.ok(Math.abs(r.params.phiDeg - truth.phiDeg) < 0.05, `phi ${r.params.phiDeg}`);
  assert.ok(r.rmsPx < 0.05, `rms ${r.rmsPx}`);
});

test('a 25-frame clean track identifies spin; a 5-frame one says it cannot', () => {
  const frames = Array.from({ length: 25 }, (_, i) => K_IMP + 1 + i);
  const long = fitSynth(synth({ frames }));
  assert.ok(Math.abs(long.params.rpmBack - TRUE.rpmBack) / TRUE.rpmBack < 0.25, `rpm ${long.params.rpmBack}`);
  assert.ok(Math.abs(long.params.tiltDeg - TRUE.tiltDeg) < 4, `tilt ${long.params.tiltDeg}`);
  assert.ok(!long.flags.includes('spin_unidentified(sigma>50%)'), long.flags.join(';'));

  const short = fitSynth(synth({ frames: [201, 202, 203] }));
  assert.ok(
    short.flags.some((f) => f.startsWith('spin_unidentified') || f.startsWith('underdetermined')),
    short.flags.join(';')
  );
});

test('predictTrack reproduces the fitted track in sample and preserves the caller frame order', () => {
  const track = synth({ noisePx: 0 });
  const r = fitSynth(track, { mcSamples: 0 });
  const frames = track.map((p) => p.frame);
  const pred = predictTrack(r, frames, FPS);
  pred.forEach((p, i) => {
    assert.ok(Math.hypot(p.x - track[i].x, p.y - track[i].y) < 0.5, `frame ${frames[i]}`);
  });
  // Shuffled input must come back in the caller's order, not sorted order.
  const shuffled = [frames[3], frames[0], frames[4], frames[1], frames[2]];
  const predShuffled = predictTrack(r, shuffled, FPS);
  shuffled.forEach((f, i) => {
    const j = frames.indexOf(f);
    assert.ok(Math.abs(predShuffled[i].x - pred[j].x) < 1e-9);
    assert.ok(Math.abs(predShuffled[i].y - pred[j].y) < 1e-9);
  });
});

// ─── 2. Hold-out on real clips: the test that proves the port is faithful ───

/**
 * Fit on the first K labelled frames, measure the reprojection error on ALL later ones.
 * K is nominal at 30 fps, so the 60 fps clips use 2K frames (the same span of time) — the lab's
 * own convention in experiments/fit2/holdout.py.
 *
 * Reference: tracer-lab/experiments/fit2/results/holdout.csv, variant `full`, median / max px in
 * the clip's native pixels (4K clips: halve for 1080p-equivalent).
 */
const HOLDOUT_REFERENCE: Record<string, Record<number, { medianPx: number; maxPx: number }>> = {
  IMG_3631: {
    3: { medianPx: 22.4, maxPx: 39.28 },
    5: { medianPx: 4.94, maxPx: 16.88 },
    8: { medianPx: 7.75, maxPx: 17.59 },
    12: { medianPx: 3.98, maxPx: 7.14 },
  },
  IMG_3649: {
    3: { medianPx: 22.28, maxPx: 57.05 },
    5: { medianPx: 7.6, maxPx: 19.01 },
    8: { medianPx: 3.55, maxPx: 9.93 },
    12: { medianPx: 6.55, maxPx: 6.57 },
  },
  IMG_3632: {
    3: { medianPx: 20.21, maxPx: 36.51 },
    5: { medianPx: 7.01, maxPx: 16.86 },
    8: { medianPx: 8.15, maxPx: 17.29 },
    12: { medianPx: 11.37, maxPx: 13.11 },
  },
};

function holdout(clip: string, kNominal: number) {
  const f = clipFixture(clip);
  const kFrames = Math.round(kNominal * (f.fps / 30));
  const used = f.track.slice(0, kFrames);
  const later = f.track.slice(kFrames);
  const fit = fitLaunch({
    track: used,
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  });
  const pred = predictTrack(fit, later.map((p) => p.frame), f.fps);
  const err = pred.map((p, i) => Math.hypot(p.x - later[i].x, p.y - later[i].y));
  return { fit, medianPx: median(err), maxPx: Math.max(...err), nLater: later.length };
}

for (const clip of Object.keys(HOLDOUT_REFERENCE)) {
  test(`hold-out ${clip}: reprojection on later frames matches the lab's measured table`, () => {
    for (const kStr of Object.keys(HOLDOUT_REFERENCE[clip])) {
      const k = Number(kStr);
      const ref = HOLDOUT_REFERENCE[clip][k];
      const got = holdout(clip, k);
      // A faithful port reproduces the lab row; a broken one lands at 20-100 px on every row.
      // The tolerance is deliberately tight — 11 of these 12 rows currently match to 0.01 px.
      const tol = Math.max(1.0, 0.1 * ref.medianPx);
      assert.ok(
        Math.abs(got.medianPx - ref.medianPx) <= tol,
        `${clip} K=${k}: median ${got.medianPx.toFixed(2)} px vs lab ${ref.medianPx} px (n=${got.nLater})`
      );
      const tolMax = Math.max(2.0, 0.1 * ref.maxPx);
      assert.ok(
        Math.abs(got.maxPx - ref.maxPx) <= tolMax,
        `${clip} K=${k}: max ${got.maxPx.toFixed(2)} px vs lab ${ref.maxPx} px`
      );
    }
  });
}

test('hold-out IMG_3631 K=5 also reproduces the lab launch numbers, not just the residual', () => {
  // experiments/fit2/results/holdout.csv: v0 75.28, theta 11.72, phi 10.02, carry 251.5, t0 +0.337 fr
  const f = clipFixture('IMG_3631');
  const { fit } = holdout('IMG_3631', 5);
  assert.ok(Math.abs(fit.params.v0 - 75.28) < 0.5, `v0 ${fit.params.v0}`);
  assert.ok(Math.abs(fit.params.thetaDeg - 11.72) < 0.2, `theta ${fit.params.thetaDeg}`);
  assert.ok(Math.abs(fit.params.phiDeg - 10.02) < 0.2, `phi ${fit.params.phiDeg}`);
  assert.ok(Math.abs(fit.summary.carryM - 251.5) < 3, `carry ${fit.summary.carryM}`);
  assert.ok(Math.abs(fit.params.t0Sec * f.fps - f.impactFrame - 0.337) < 0.02, `t0 ${fit.params.t0Sec}`);
});

// ─── 3. t0 is bounded to the impact-frame interval ───

test('t0 is bounded to [impactFrame, impactFrame+1] and reports when it sits on the bound', () => {
  for (const clip of ['IMG_3631', 'IMG_3649', 'IMG_3632']) {
    const f = clipFixture(clip);
    const { fit } = holdout(clip, 5);
    const t0Frames = fit.params.t0Sec * f.fps;
    assert.ok(
      t0Frames >= f.impactFrame - 1e-9 && t0Frames <= f.impactFrame + 1 + 1e-9,
      `${clip}: t0 at frame ${t0Frames}, impact ${f.impactFrame}`
    );
  }
  // IMG_3632 K=5 sits on the lower bound in the lab too (t0 offset +0.062 fr is inside, but the
  // K=3 fit is pinned) — the flag exists so the ladder can treat it as "re-check the impact frame".
  const pinned = holdout('IMG_3632', 3).fit;
  assert.ok(pinned.flags.includes('t0_at_lower_bound'), pinned.flags.join(';'));
});

// ─── 4. GPS carry semantics (fit2 §2) ───

/** `Z_INCONSISTENT` in lib/tracerFit.ts. Duplicated deliberately: it is not exported, and a test
 *  that read the constant it is checking would pass whatever that constant became. */
const Z_INCONSISTENT_FOR_TEST = 4.0;

function carryCase(clip: string, kNominal: number | null, errFrac: number, kind: 'nextShot' | 'carry') {
  const f = clipFixture(clip);
  const camera = new TracerCamera(f.camera);
  const track = kNominal === null ? f.track : f.track.slice(0, Math.round(kNominal * (f.fps / 30)));
  const common = {
    track,
    camera,
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  const pixelOnly = fitLaunch(common);
  const joint = fitLaunch({
    ...common,
    carryM: pixelOnly.summary.carryM * (1 + errFrac),
    carryModel: kind,
    pixelOnly,
  });
  return { pixelOnly, joint };
}

test('a track-consistent GPS distance is carry_consistent and does not move the fit', () => {
  const { pixelOnly, joint } = carryCase('IMG_3631', null, 0, 'carry');
  assert.equal(joint.carryStatus, 'carry_consistent');
  assert.ok(Math.abs(joint.carryZ ?? NaN) < 0.5, `z ${joint.carryZ}`);
  assert.ok(Math.abs(joint.params.v0 - pixelOnly.params.v0) / pixelOnly.params.v0 < 0.02);
});

test('5-10 % carry error must NOT false-alarm — the legacy rule fired here and was refuted', () => {
  // skeptic-physics §6 found the wave-2 flat-sigma rule firing `carry_inconsistent` at +-10 % on
  // exactly this clip. With the f_px systematic honestly inside sigma_D it must be quiet.
  for (const e of [-0.1, -0.05, 0.05, 0.1]) {
    for (const kind of ['carry', 'nextShot'] as const) {
      const { joint } = carryCase('IMG_3631', null, e, kind);
      assert.equal(
        joint.carryStatus,
        'carry_consistent',
        `e=${(100 * e).toFixed(0)} % ${kind}: ${joint.carryStatus} z=${joint.carryZ}`
      );
    }
  }
});

test('a 30 %-wrong distance is flagged on a long 4K driver track', () => {
  // fit2 §2: at the metadata f_px prior a 30 % error is a 2.0-2.4 sigma TENSION, not a rejection.
  // `carry_inconsistent` needs ~55 %. Asserting "flagged", and that it is not silently consistent.
  for (const e of [-0.3, 0.3]) {
    const { joint } = carryCase('IMG_3631', null, e, 'carry');
    assert.ok(
      joint.carryStatus === 'carry_tension' || joint.carryStatus === 'carry_inconsistent',
      `e=${(100 * e).toFixed(0)} %: ${joint.carryStatus} z=${joint.carryZ}`
    );
    assert.ok(Math.abs(joint.carryZ ?? 0) > 2, `z ${joint.carryZ}`);
    assert.ok(joint.flags.some((fl) => fl.startsWith('carry_tension') || fl.startsWith('carry_inconsistent')));
  }
});

test('the next-shot model is asymmetric by design: roll explains a LONGER distance, not a shorter one', () => {
  const long = carryCase('IMG_3631', null, 0.3, 'nextShot').joint;
  const short = carryCase('IMG_3631', null, -0.3, 'nextShot').joint;
  assert.equal(long.carryStatus, 'carry_consistent');
  assert.ok(short.carryStatus === 'carry_tension' || short.carryStatus === 'carry_inconsistent');
});

test('a loose pixel-only carry reports carry_as_scale rather than claiming a consistency test', () => {
  // IMG_3649 K=5: the pixel-only carry is 224 +- 35 m, i.e. 16 % — above the 15 % threshold, so
  // the GPS is setting the depth scale and no agreement is being asserted. This is the case the
  // verdict was DESIGNED for, and gate NEW-1 must not have taken it away: the carry here agrees
  // with the pixels exactly (errFrac 0), so there is nothing to reject.
  const { pixelOnly, joint } = carryCase('IMG_3649', 5, 0, 'carry');
  assert.ok(pixelOnly.summarySigma.carryM / pixelOnly.summary.carryM > 0.15);
  assert.equal(joint.carryStatus, 'carry_as_scale');
  assert.ok(
    Math.abs(joint.carryZNoPixelSigma ?? 99) < 2,
    `an agreeing carry must agree on BOTH z-scores, got ${joint.carryZNoPixelSigma}`
  );
});

test('GATE NEW-1(a): a loose pixel carry no longer PRE-EMPTS the inconsistency test', () => {
  // THE REPRODUCTION at the fit level, on a real clip rather than a synthetic one.
  //
  // The port tested `carry_as_scale` FIRST (fit.py:907-920 does the same), so once the pixel-only
  // carry sigma passed 15 % the GPS distance became the depth scale however wrong it was — `z` was
  // computed, printed into the flag, and then ignored. On IMG_3649 K=5 the pixel carry is 224 m; a
  // GPS reading HALF that is a different shot, and it used to come back `carry_as_scale`.
  //
  // The half that makes this a real finding rather than a threshold quibble: at -50 % the LAB's own
  // z is 2.5, well inside the 4-sigma bar, because the loose pixel sigma sits in its own
  // denominator and divides the test away. Only the z with that term dropped — the same
  // substitution F1(a) established for a non-finite sigma — sees it, at 4.1 sigma.
  const { pixelOnly, joint } = carryCase('IMG_3649', 5, -0.5, 'carry');
  assert.ok(pixelOnly.summarySigma.carryM / pixelOnly.summary.carryM > 0.15, 'still the as-scale case');
  assert.equal(joint.carryStatus, 'carry_inconsistent');
  assert.ok(
    Math.abs(joint.carryZ ?? 0) < Z_INCONSISTENT_FOR_TEST,
    `the lab's own z must NOT be what caught it, or this test proves nothing: z=${joint.carryZ}`
  );
  assert.ok(
    Math.abs(joint.carryZNoPixelSigma ?? 0) > Z_INCONSISTENT_FOR_TEST,
    `the pixel-sigma-free z is what catches it: ${joint.carryZNoPixelSigma}`
  );
  // Both halves of the diagnosis reach the row a field test reads.
  assert.ok(
    joint.flags.some((fl) => fl.startsWith('carry_inconsistent(') && fl.includes('z_no_pixel_sigma=')),
    `the flag must show both z-scores: ${joint.flags.join(';')}`
  );
  assert.ok(
    joint.flags.some((fl) => fl.startsWith('pixel_carry_too_loose_to_check_gps(')),
    `and why the as-scale rung did not save it: ${joint.flags.join(';')}`
  );
});

test('GATE-1: the pixel-sigma-free z is tested with NO threshold on `rel`, on a real clip', () => {
  // THE REPRODUCTION at the fit level, one rung BELOW the one NEW-1(a) closed.
  //
  // NEW-1(a) shipped the second z-score behind `asScale &&`, i.e. it was computed on every fit and
  // LOOKED AT only when the pixel-only carry sigma passed 15 % of the carry. The gate agent walked
  // under that threshold: on its clip `rel` was 14.16 %, the ordinary z was 2.8 and the
  // pixel-sigma-free z was 4.3, and the reading came back `carry_tension` and was drawn.
  //
  // IMG_3649 at K=6 is the same band on REAL data, which is why this test is here and not only on
  // the synthetic fixture: rel = 14.3 %, so `asScale` is FALSE and the previous round's fix could
  // never have fired; the lab's own z is 2.65, INSIDE the 4-sigma bar; and the pixel-sigma-free z
  // is 4.06, outside it. All three halves are asserted, so the test cannot pass for the wrong
  // reason — if `rel` ever drifts above 15 % this fails on the first assertion rather than
  // silently becoming a duplicate of the NEW-1(a) test above.
  for (const [clip, k] of [
    ['IMG_3649', 6],
    ['IMG_3632', 6],
  ] as const) {
    const { pixelOnly, joint } = carryCase(clip, k, -0.5, 'carry');
    const rel = pixelOnly.summarySigma.carryM / pixelOnly.summary.carryM;
    assert.ok(
      rel < 0.15,
      `${clip} K=${k}: this must NOT be the as-scale case, or it proves nothing — rel=${(100 * rel).toFixed(1)} %`
    );
    assert.ok(
      Math.abs(joint.carryZ ?? 0) < Z_INCONSISTENT_FOR_TEST,
      `${clip} K=${k}: the lab's own z must not be what caught it: z=${joint.carryZ}`
    );
    assert.ok(
      Math.abs(joint.carryZNoPixelSigma ?? 0) > Z_INCONSISTENT_FOR_TEST,
      `${clip} K=${k}: the pixel-sigma-free z is what catches it: ${joint.carryZNoPixelSigma}`
    );
    assert.equal(joint.carryStatus, 'carry_inconsistent', `${clip} K=${k}`);
    // And both numbers reach the row a field test is read from, unconditionally now — the whole
    // finding was a number the code computed and nobody looked at.
    assert.ok(
      joint.flags.some(
        (fl) => fl.startsWith('carry_inconsistent(') && fl.includes('z=') && fl.includes('z_no_pixel_sigma=')
      ),
      `${clip} K=${k}: the flag must show both z-scores: ${joint.flags.join(';')}`
    );
  }
});

test('GATE-1: the unconditional test is still bounded — a 40 % error in the same band is tension, not a refusal', () => {
  // The other half of the trade, and the reason this is not "any GPS reading is thrown away".
  // Same clip, same K, same `rel` — a -40 % reading scores 3.25 on the pixel-sigma-free z, inside
  // the bar, and keeps working as a carry. The lab's calibration (~55 % at the metadata f_px
  // prior) is preserved rather than quietly tightened, and dropping `asScale &&` moved the
  // boundary for nobody who was inside it.
  const { pixelOnly, joint } = carryCase('IMG_3649', 6, -0.4, 'carry');
  assert.ok(pixelOnly.summarySigma.carryM / pixelOnly.summary.carryM < 0.15, 'the same band');
  assert.ok(
    Math.abs(joint.carryZNoPixelSigma ?? 0) < Z_INCONSISTENT_FOR_TEST,
    `z_no_pixel_sigma=${joint.carryZNoPixelSigma}`
  );
  assert.notEqual(joint.carryStatus, 'carry_inconsistent');
});

test('GATE NEW-1(a): the deviation is bounded — a 30 % error is still the as-scale case, not a refusal', () => {
  // The fix must not become "any loose track throws its GPS away". The lab's calibration says a
  // ~55 % error is what `carry_inconsistent` is for at the metadata f_px prior, and that band is
  // preserved: -30 % on the same loose clip is still `carry_as_scale`, so the joint fit keeps
  // working for the readings it was built to use.
  const { joint } = carryCase('IMG_3649', 5, -0.3, 'carry');
  assert.equal(joint.carryStatus, 'carry_as_scale');
});

test('the joint fit is seeded from the pixel-only optimum and never lands in a worse pixel minimum', () => {
  // fit2 §1: without this seeding IMG_3632 gave chi2_px 16.2 against the pixel-only 4.0 and a
  // FALSE carry_inconsistent. The seed source and the chi2 comparison are both asserted.
  const f = clipFixture('IMG_3632');
  const camera = new TracerCamera(f.camera);
  const common = {
    track: f.track,
    camera,
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  const pixelOnly = fitLaunch(common);
  for (const d of [pixelOnly.summary.carryM, 126]) {
    const joint = fitLaunch({ ...common, carryM: d, carryModel: 'carry', pixelOnly });
    assert.ok(
      !joint.flags.some((fl) => fl.startsWith('joint_fit_worse_pixel_minimum')),
      `D=${d}: ${joint.flags.join(';')}`
    );
    assert.ok(
      joint.chi2Px < pixelOnly.chi2Px + 4,
      `D=${d}: chi2_px ${joint.chi2Px.toFixed(1)} vs pixel-only ${pixelOnly.chi2Px.toFixed(1)}`
    );
  }
});

test('a missing pixel-only carry sigma FLAGS carry_untested but still runs the test (F1)', () => {
  // This test used to assert `carryStatus === 'carry_untested'`, i.e. that a
  // missing Monte Carlo made the port skip the consistency test entirely. The
  // adversarial review (docs/tracer-v3/review.md, F1) showed that is the
  // opposite of conservative: `fixSpin` makes the pixel-only covariance
  // singular, so a wrong GPS carry was USED, untested, and drawn as a confident
  // distance. fit.py:889 substitutes sigma = 0 and computes z anyway, which
  // costs only the PERMISSIVE `carry_as_scale` rung and keeps the protective
  // one. The contract asserted here is now that behaviour: the flag survives as
  // a caveat, the verdict is still reached.
  const f = clipFixture('IMG_3631');
  const base = {
    track: f.track,
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
    mcSamples: 0,
  };

  // A carry that agrees with the pixels: consistent, and the caveat is recorded.
  const agree = fitLaunch({ ...base, carryM: 240 });
  assert.ok(
    agree.flags.includes('carry_untested(no_usable_pixel_only_carry_sigma)'),
    `the caveat must survive: ${agree.flags.join(';')}`
  );
  assert.ok(agree.carryZ !== null, 'the consistency test must have RUN, not been skipped');
  assert.equal(agree.carryStatus, 'carry_consistent');

  // The F1 reproduction at the fit level: the SAME missing sigma with a carry
  // that cannot be true must come back inconsistent, not untested.
  const wrong = fitLaunch({ ...base, carryM: 40 });
  assert.ok(
    wrong.flags.includes('carry_untested(no_usable_pixel_only_carry_sigma)'),
    'the caveat is still recorded'
  );
  assert.equal(wrong.carryStatus, 'carry_inconsistent');
  assert.ok(
    wrong.flags.some((fl) => fl.startsWith('carry_inconsistent')),
    `a 40 m carry against a ~244 m pixel track must be flagged: ${wrong.flags.join(';')}`
  );
});

// ─── 5. Determinism and runtime ───

/** Everything a caller can act on, as a comparable snapshot. */
function snapshot(r: FitResult) {
  return JSON.stringify({
    ok: r.ok,
    params: r.params,
    summary: r.summary,
    summarySigma: r.summarySigma,
    sigmaTotal: r.sigmaTotal,
    budget: r.budget,
    sigma: r.sigma,
    rmsPx: r.rmsPx,
    maxResidPx: r.maxResidPx,
    residualPx: r.residualPx,
    carryStatus: r.carryStatus,
    carryZ: r.carryZ,
    carrySigmaM: r.carrySigmaM,
    labelStepM: r.labelStepM,
    carryLabelM: r.carryLabelM,
    flags: r.flags,
    chi2Px: r.chi2Px,
    cost: r.cost,
    seedSource: r.seedSource,
  });
}

test('the same inputs give byte-identical output twice, pixel-only and joint', () => {
  const f = clipFixture('IMG_3631');
  const common = {
    track: f.track.slice(0, 10),
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  assert.equal(snapshot(fitLaunch(common)), snapshot(fitLaunch(common)));
  const withCarry = { ...common, carryM: 245, carryModel: 'nextShot' as const };
  assert.equal(snapshot(fitLaunch(withCarry)), snapshot(fitLaunch(withCarry)));
});

test('a full fit runs well inside the per-clip budget on a phone', () => {
  // Measured on the dev machine and reported in docs/tracer-v3/ts-fit.md; the assertion is the
  // budget, not the measurement. This is a one-off per shot, after the detector.
  const f = clipFixture('IMG_3631');
  const common = {
    track: f.track.slice(0, 10),
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  const pixelOnly = fitLaunch(common);
  assert.ok(pixelOnly.runtimeMs < 400, `pixel-only fit took ${pixelOnly.runtimeMs.toFixed(0)} ms`);
  // The joint fit computes its own pixel-only companion first, so this is the whole shot's cost.
  const joint = fitLaunch({ ...common, carryM: 245, carryModel: 'nextShot' });
  assert.ok(joint.runtimeMs < 400, `joint fit took ${joint.runtimeMs.toFixed(0)} ms`);
});

test('maxIterations really caps the work', () => {
  const f = clipFixture('IMG_3631');
  const common = {
    track: f.track.slice(0, 10),
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
    mcSamples: 0,
  };
  const capped = fitLaunch({ ...common, maxIterations: 1 });
  const full = fitLaunch(common);
  assert.ok(capped.nFev < full.nFev, `${capped.nFev} vs ${full.nFev}`);
  assert.ok(capped.cost > full.cost, `${capped.cost} vs ${full.cost}`);
  assert.ok(capped.flags.includes('optimizer_not_converged'), capped.flags.join(';'));
});

// ─── 6. The error budget and honest labelling ───

test('camera pitch propagates 1:1 into the launch-angle budget (skeptic-physics §3)', () => {
  const f = clipFixture('IMG_3631');
  const common = {
    track: f.track.slice(0, 10),
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  const coreMotion = fitLaunch({ ...common, pitchSigmaDeg: 0.5 });
  const treeLine = fitLaunch({ ...common, pitchSigmaDeg: 1.5 });
  assert.equal(coreMotion.budget.thetaDeg.pitch, 0.5);
  assert.equal(treeLine.budget.thetaDeg.pitch, 1.5);
  // total is the quadrature sum of its own terms, and nothing else.
  for (const r of [coreMotion, treeLine]) {
    for (const k of Object.keys(r.budget)) {
      const t = r.budget[k];
      assert.ok(Math.abs(t.total - Math.hypot(t.formal, t.pitch, t.fpx)) < 1e-9, k);
    }
    assert.equal(r.sigmaTotal.thetaDeg, r.budget.thetaDeg.total);
  }
  assert.ok(treeLine.sigmaTotal.thetaDeg > coreMotion.sigmaTotal.thetaDeg);
});

test('device intrinsics shrink the speed and carry budget, and drop the fpx_is_prior flag', () => {
  const f = clipFixture('IMG_3631');
  const common = {
    track: f.track.slice(0, 10),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  const prior = fitLaunch({ ...common, camera: new TracerCamera(f.camera) });
  const device = fitLaunch({
    ...common,
    camera: new TracerCamera({ ...f.camera, fPxIsPrior: false }),
  });
  assert.ok(prior.flags.some((fl) => fl.startsWith('fpx_is_prior')), prior.flags.join(';'));
  assert.ok(!device.flags.some((fl) => fl.startsWith('fpx_is_prior')), device.flags.join(';'));
  // 12 % -> 2 % of v0. The lab's budget table: 8.8 m/s at the prior, 1.7 with device intrinsics.
  assert.ok(Math.abs(prior.budget.v0.fpx - 0.12 * prior.params.v0) < 1e-9);
  assert.ok(Math.abs(device.budget.v0.fpx - 0.02 * device.params.v0) < 1e-9);
  assert.ok(device.sigmaTotal.carryM < prior.sigmaTotal.carryM);
});

test('the carry label is rounded no finer than its own uncertainty', () => {
  assert.equal(labelStepM(1.0), 1);
  assert.equal(labelStepM(2.5), 1);
  assert.equal(labelStepM(2.51), 5);
  assert.equal(labelStepM(7.5), 5);
  assert.equal(labelStepM(7.51), 10);
  assert.equal(labelStepM(Number.NaN), 10);
  assert.equal(roundLabelM(243.7, 30), 240);
  assert.equal(roundLabelM(243.7, 5), 245);
  assert.equal(roundLabelM(243.7, 1), 244);

  // On real footage at the metadata f_px the driver carry sigma is ~30 m, so the label is 10 m.
  const { fit } = holdout('IMG_3631', 5);
  assert.equal(fit.labelStepM, 10);
  assert.equal(fit.carryLabelM % 10, 0);
  assert.ok(fit.sigmaTotal.carryM > 20, `sigma(carry) ${fit.sigmaTotal.carryM}`);
});

// ─── 7. Refusals: inputs that cannot produce a fit throw rather than fabricating one ───

test('inputs from which no fit can be formed throw, and say why', () => {
  const f = clipFixture('IMG_3631');
  const camera = new TracerCamera(f.camera);
  const base = {
    track: f.track.slice(0, 5),
    camera,
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  assert.throws(() => fitLaunch({ ...base, track: [] }), /empty track/);
  assert.throws(() => fitLaunch({ ...base, fps: 0 }), /fps/);
  // A track that starts ON the impact frame: the ball is still at address there.
  assert.throws(
    () => fitLaunch({ ...base, impactFrame: f.track[0].frame }),
    /not after impactFrame/
  );
  // An address pixel above the horizon does not back-project onto the ground.
  const aboveHorizon = { x: camera.params.width / 2, y: camera.horizonRow() - 50 };
  assert.throws(() => fitLaunch({ ...base, addressPx: aboveHorizon }), /ground plane/);
});

test('a track point with no confidence is treated as a confident one', () => {
  const f = clipFixture('IMG_3631');
  const common = {
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
    mcSamples: 0,
  };
  const sure = f.track.slice(0, 10).map((p) => ({ frame: p.frame, x: p.x, y: p.y, conf: 1 }));
  const unlabelled = sure.map(({ frame, x, y }) => ({ frame, x, y }));
  assert.equal(
    JSON.stringify(fitLaunch({ ...common, track: sure }).params),
    JSON.stringify(fitLaunch({ ...common, track: unlabelled }).params)
  );
});

// ─── 8. flightPixels: what the renderer consumes ───

test('flightPixels walks the whole flight in clip time with a usable depth', () => {
  const f = clipFixture('IMG_3631');
  const { fit } = holdout('IMG_3631', 5);
  const s = flightPixels(fit, { fps: f.fps, hz: 120 });
  assert.ok(s.length > 100, `${s.length} samples`);
  assert.ok(Math.abs(s[0].tSec - fit.params.t0Sec) < 1e-9, 'first sample is at impact');
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].tSec > s[i - 1].tSec - 1e-12, `tSec not increasing at ${i}`);
  }
  assert.ok(Math.abs(s[s.length - 1].tSec - (fit.params.t0Sec + fit.summary.hangS)) < 1e-9);
  assert.ok(s.every((p) => p.depthM > 0 && Number.isFinite(p.depthM)));
  assert.ok(s.every((p) => Math.abs(p.frame - p.tSec * f.fps) < 1e-9));
  // The ball starts in front of the camera and at the address pixel.
  assert.ok(s[0].inFront);
  assert.ok(Math.hypot(s[0].x - f.addressPx.x, s[0].y - f.addressPx.y) < 1, 'starts at address');
  // Depth grows monotonically for a driver hit away from the camera.
  assert.ok(s[s.length - 1].depthM > s[0].depthM * 5);

  const clipped = flightPixels(fit, { fps: f.fps, hz: 60, tEndSec: 1.0 });
  assert.ok(clipped[clipped.length - 1].tSec <= fit.params.t0Sec + 1.0 + 1e-9);
});

// ─── 9. The failure modes the pipeline has to be able to see ───

test('an impact frame off by one shows up as a large residual, it does not pass silently', () => {
  // skeptic-physics §3: a one-frame impact error moves speed by 16-37 % and theta by 1-4 deg, and
  // it is ALWAYS visible in the residual (rms 6-30 px, t0 pinned on a bound). The ladder has to
  // read `large_pixel_residual` + `t0_at_*_bound` as "re-check the impact frame", so both must fire.
  const f = clipFixture('IMG_3631');
  const common = {
    track: f.track.slice(0, 10),
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  };
  const good = fitLaunch(common);
  assert.ok(!good.flags.includes('large_pixel_residual'), good.flags.join(';'));

  const early = fitLaunch({ ...common, impactFrame: f.impactFrame - 1 });
  assert.ok(
    early.flags.includes('large_pixel_residual') || early.flags.some((fl) => fl.startsWith('t0_at_')),
    `rms ${early.rmsPx.toFixed(1)} px, flags ${early.flags.join(';')}`
  );
  assert.ok(early.rmsPx > 3 * good.rmsPx, `${early.rmsPx.toFixed(2)} vs ${good.rmsPx.toFixed(2)}`);
});

test('a one-point track is answered, but flagged prior-driven', () => {
  // The lab's IMG_3650 case: two pixel equations against six unknowns. The launch DIRECTION comes
  // from the image; the speed and carry come entirely from the prior, and the flags say so.
  const f = clipFixture('IMG_3631');
  const r = fitLaunch({
    track: f.track.slice(0, 1),
    camera: new TracerCamera(f.camera),
    addressPx: f.addressPx,
    impactFrame: f.impactFrame,
    fps: f.fps,
    bucket: f.bucket,
  });
  assert.ok(r.flags.some((fl) => fl.startsWith('underdetermined')), r.flags.join(';'));
  assert.ok(r.flags.some((fl) => fl.startsWith('few_frames')), r.flags.join(';'));
  assert.ok(Number.isFinite(r.summary.carryM) && r.summary.carryM > 0);
});
