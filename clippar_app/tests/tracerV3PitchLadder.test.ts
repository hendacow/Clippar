/**
 * The camera-pitch ladder and the residual gate that closed with it
 * (`docs/tracer-v3/tune.md`).
 *
 * Both changes live in `lib/tracerV3.ts` and both are about the same thing: an
 * IMPORTED clip carries no CoreMotion pitch, so the camera the fit works from is
 * a guess, and everything the fit says about the world — apex, hang, v0 — is a
 * consequence of that guess rather than a measurement. The ladder stops one
 * arbitrary guess from deciding, and the quorum stops the ladder from becoming a
 * way to draw over anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { traceClip, type TraceClipInput } from '../lib/tracerV3';
import * as clip from './fixtures/tracerV3Clip';
import * as axisFallback from './fixtures/tracerV3AxisFallback';

/** The same fixture, delivered the way an IMPORT arrives: no pitch, no optics. */
function imported(
  F: typeof clip | typeof axisFallback,
  detection: TraceClipInput['detection'],
  assumedPitchDownDeg = 4
): TraceClipInput {
  return F.traceInput({
    detection,
    pitchDownDeg: null,
    capture: { lens: null, zoom: null },
    allowUnknownGeometry: true,
    assumedPitchDownDeg,
  });
}

const ladderFlag = (flags: string[]): string | undefined =>
  flags.find((f) => f.startsWith('pitch_ladder('));
const assumedFlag = (flags: string[]): string | undefined =>
  flags.find((f) => f.startsWith('pitch_assumed('));

// ─── poor_fit lost its length conjunct ──────────────────────────────────────

test('poor_fit refuses a SHORT track whose fit misses it, which is the hole IMG_0323 walked through', () => {
  // This is the axis-fallback fixture's own pre-7-Sep default launch, and its
  // header used to cite the hole approvingly: 7 frames at 7.66 px @1080p, under
  // MAX_RMS_PX (8) and under the old `nPoints >= 10` conjunct, so it drew.
  // The real clip that made this matter is IMG_0323 — a phone strapped to a golf
  // trolley being wheeled down a fairway, three moving blobs, 5.6 px @1080p, an
  // arc over no golf shot at all. Synthetic here because the bench corpus is not
  // in the repo; the mechanism is identical.
  const det = axisFallback.detectionResult(
    axisFallback.flightDetections({ thetaDeg: 45, phiDeg: 3, frames: 7 })
  );
  const r = traceClip(axisFallback.traceInput({ detection: det }));
  assert.equal(r.spec, null, 'a 7-frame track at 7.7 px @1080p must not draw');
  assert.match(r.reason ?? '', /^poor_fit:/);
  assert.ok(r.meta.fit!.nPoints < 10, `and it must be SHORT — that is the point: ${r.meta.fit!.nPoints}`);
});

test('poor_fit still leaves a short track that the fit actually follows alone', () => {
  // The cost control. Dropping the length conjunct must not refuse every short
  // track — only the ones the fit does not follow. Four frames at well under the
  // bar still draw.
  const r = traceClip(clip.traceInput({ detection: clip.detectionResult(clip.flightDetections({ frames: 4 })) }));
  assert.ok(r.spec, `a clean 4-frame track must still draw: ${r.reason}`);
  assert.ok(r.meta.fit!.rmsPx <= 4.0, `and it is clean because the fit follows it: ${r.meta.fit!.rmsPx}`);
});

// ─── the ladder only exists for a GUESSED pitch ─────────────────────────────

test('a clip that carries a CoreMotion pitch never enters the ladder', () => {
  const r = traceClip(clip.traceInput());
  assert.ok(r.spec, `the measured-pitch control must draw: ${r.reason}`);
  assert.equal(ladderFlag(r.flags), undefined, `no ladder on a measured pitch: ${r.flags.join(';')}`);
  assert.equal(assumedFlag(r.flags), undefined, 'nor an assumed-pitch flag');
});

test('with the unknown-geometry allowance OFF an import still refuses, and no ladder runs', () => {
  const r = traceClip(
    clip.traceInput({
      pitchDownDeg: null,
      capture: { lens: null, zoom: null },
      allowUnknownGeometry: false,
      assumedPitchDownDeg: 4,
    })
  );
  assert.equal(r.spec, null);
  assert.equal(ladderFlag(r.flags), undefined, `${r.flags.join(';')}`);
});

// ─── what the ladder does ───────────────────────────────────────────────────

test('the ladder starts at the configured prior, so a clip that passes there is drawn there', () => {
  const r = traceClip(imported(clip, clip.detectionResult(clip.flightDetections())));
  assert.ok(r.spec, `the import must draw: ${r.reason}`);
  const fl = ladderFlag(r.flags);
  assert.ok(fl, `expected a pitch_ladder flag: ${r.flags.join(';')}`);
  assert.match(fl as string, /used=4\.0deg/, `the prior is the first rung: ${fl}`);
  assert.equal(assumedFlag(r.flags), 'pitch_assumed(4.0deg)', 'and the camera flag agrees with it');
  // It stops as soon as the quorum is met, so a clip that passes at the prior
  // costs two fits, not six.
  assert.match(fl as string, /agreed=2,tried=2\b/, `it must stop at the quorum: ${fl}`);
});

test('the prior is honoured — a different assumedPitchDownDeg moves the whole ladder', () => {
  const det = clip.detectionResult(clip.flightDetections());
  const r = traceClip(imported(clip, det, 0));
  assert.ok(r.spec, `${r.reason}`);
  assert.match(ladderFlag(r.flags) as string, /used=0\.0deg/);
  assert.equal(assumedFlag(r.flags), 'pitch_assumed(0.0deg)');
});

test('the ladder rescues a flight the single guessed pitch refuses', () => {
  // The mechanism, on a fixture whose TRUE pitch (6 deg) is outside what
  // `dPitchDeg` can reach from a bad guess. At an assumed 20 deg — 14 deg wrong,
  // inside the range a phone on a bag can be off by — the single-pitch code has
  // no rung that fits. The ladder walks down from there and finds one.
  const det = clip.detectionResult(clip.flightDetections());
  const single = traceClip(imported(clip, det, 20));
  const fl = ladderFlag(single.flags);
  assert.ok(fl, `${single.flags.join(';')}`);
  // Either it drew at a rung below the prior, or it refused — both are honest,
  // but the flag must say how many rungs agreed, because that is the evidence.
  assert.match(fl as string, /agreed=\d+,tried=\d+,of=6,quorum=2/);
});

// ─── the quorum is a refusal, not a rescue ──────────────────────────────────

test('a track that is a flight at exactly ONE assumed pitch is refused, not drawn', () => {
  // Found by sweeping the fixture's own launch space (v0 x theta x frames) for a
  // clip whose acceptance is a knife edge in the camera angle. It DRAWS at the
  // prior — so the pre-ladder code would have drawn it — and at none of the five
  // other rungs. The camera was never measured, so one agreeing rung is a
  // coincidence of the optimiser rather than evidence about the ball.
  const det = clip.detectionResult(clip.flightDetections({ v0: 10, thetaDeg: 45, frames: 16 }));

  const r = traceClip(imported(clip, det));
  assert.equal(r.spec, null, 'the ladder must refuse it');
  assert.match(r.reason ?? '', /^pitch_unstable:/);
  assert.match(ladderFlag(r.flags) as string, /agreed=1,tried=6,of=6,quorum=2/);
  assert.match(r.reason ?? '', /the camera angle was never measured/);
  // The precondition, read off the refusal itself: the one rung that agreed IS
  // the configured prior, so the pre-ladder code — which only ever ran that rung
  // — would have drawn this. The quorum is what is refusing it, not some other
  // gate that happens to fire. (It cannot be checked by re-running with
  // `pitchDownDeg: 4`, because a MEASURED 4 deg is a different fit: the pitch
  // nuisance is off and its sigma is 0.5 deg rather than 12.)
  assert.match(r.reason ?? '', /only at an assumed camera pitch of 4\.0 deg/, r.reason ?? '');
});

test('the quorum refusal names the pitch that agreed, so a field row is diagnosable', () => {
  const det = clip.detectionResult(clip.flightDetections({ v0: 10, thetaDeg: 45, frames: 16 }));
  const r = traceClip(imported(clip, det));
  assert.match(r.reason ?? '', /assumed camera pitch of -?\d+\.\d deg/);
  assert.match(r.reason ?? '', /4, 2, 0, -2, -4, -6 deg/, `the rungs tried must be on the row: ${r.reason}`);
});

test('a refusal that is not the quorum keeps the PRIOR rung’s own reason', () => {
  // A clip with no detections at all fails identically at every rung, and the
  // row must carry the reason the shipped assumption produced rather than
  // whichever rung happened to run last.
  const r = traceClip(imported(clip, clip.detectionResult([])));
  assert.equal(r.spec, null);
  assert.equal(r.reason, 'no_detections');
  assert.doesNotMatch(r.reason ?? '', /pitch_unstable/);
});

test('the ladder never invents a distance — an import still states none', () => {
  const r = traceClip(imported(clip, clip.detectionResult(clip.flightDetections())));
  assert.ok(r.spec, `${r.reason}`);
  assert.equal(r.spec.labelText, 'no distance');
  assert.ok(
    r.flags.some((f) => f.startsWith('geometry_unknown')),
    `an import is geometry_unknown whatever rung drew it: ${r.flags.join(';')}`
  );
});
