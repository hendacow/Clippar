/**
 * THE DERIVED IMPACT MEETS THE APP'S TRIM WINDOW.
 *
 * WHY THIS FILE EXISTS. `tests/tracerV3ImpactScan.test.ts` asserts that the
 * Swift scan derives an impact and reports it. It says nothing about what the
 * TypeScript side then has to survive, and after the window scan that is the
 * load-bearing part:
 *
 *   The detector is now free to relocate the impact up to `scanRadiusMs`
 *   (+-3.5 s) away from the one the app handed it. The app's TRIM WINDOW is
 *   NOT relocated with it — it is built from the app's own swing detector
 *   (`planHighlightTrim`, pre-roll 2.5 s / post-roll 1.5 s) before the tracer
 *   runs at all. So the flight the detector found can legitimately fall
 *   outside the four seconds that will actually be rendered.
 *
 * That is a real, measured failure mode and not a hypothetical: in the
 * impact-error sweep (26 clips x 11 offsets, docs/tracer-v3/bench.md) the
 * +3000 ms column collapses to 1/26 with 13 clips refusing on
 * `render_spec:animStartSec ... out of range`. Every other column has zero.
 * The collapse is the TRIM WINDOW, not the detection — the detector relocates
 * the impact correctly at that offset too.
 *
 * The product rule says a skip is fine and a wrong draw is not. So the thing
 * that must be pinned is: over the WHOLE range the scan can move the impact,
 * the ladder either emits a spec that satisfies every renderer invariant, or
 * it refuses with a reason. Never a negative start, never a zero-length
 * animation, never a throw, and never a draw whose pixels moved because the
 * WINDOW moved.
 *
 * `TracerRenderV3.swift` hard-rejects `tSec[0] !== 0`, non-increasing `tSec`,
 * and `tSec.last !== animDurationSec`; on a phone those are an export that
 * fails rather than a trace that looks wrong, which is why they are asserted
 * on the emitted spec rather than assumed.
 *
 * These are EXECUTABLE tests against the real `traceClip`, not source-text
 * assertions — the sibling file already covers the Swift the node runner
 * cannot execute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { traceClip, type TraceClipResult } from '../lib/tracerV3';
import { FPS, K_IMPACT, traceInput } from './fixtures/tracerV3Clip';

const here = dirname(fileURLToPath(import.meta.url));
const coreSrc = readFileSync(
  join(here, '..', 'modules/shot-detector/ios/TracerDetectCore.swift'), 'utf8');

/** The app's own trim window, read from `planHighlightTrim`'s callers. */
const PRE_ROLL_SEC = 2.5;
const POST_ROLL_SEC = 1.5;
const WINDOW_SEC = PRE_ROLL_SEC + POST_ROLL_SEC;

/** Where the fixture's flight actually starts, in the DETECTOR's timeline. */
const FLIGHT_START_SEC = (K_IMPACT + 1) / FPS;

/**
 * How far the scan is allowed to move the impact, read out of the Swift rather
 * than hard-coded, so widening `scanRadiusMs` widens this test with it instead
 * of leaving it quietly under-covering the new range.
 */
function scanRadiusSec(): number {
  const m = /scanRadiusMs\s*=\s*([0-9.]+)/.exec(coreSrc);
  assert.ok(m, 'scanRadiusMs must be declared in TracerDetectCore.swift');
  return Number(m[1]) / 1000;
}

/**
 * The renderer's contract, checked on anything that draws. Every one of these
 * is a hard reject in TracerRenderV3.swift, i.e. a failed export on a phone.
 */
function assertSpecIsRenderable(r: TraceClipResult, where: string): void {
  const s = r.spec;
  assert.ok(s, `${where}: expected a spec`);
  assert.ok(s.animStartSec >= 0, `${where}: animStartSec ${s.animStartSec} must be >= 0`);
  assert.ok(s.animDurationSec > 0, `${where}: animDurationSec must be > 0`);
  assert.ok(Number.isFinite(s.animStartSec) && Number.isFinite(s.animDurationSec),
    `${where}: the window must be finite`);
  assert.ok(s.samples.length >= 2, `${where}: at least two samples`);
  assert.equal(s.samples[0].tSec, 0, `${where}: tSec[0] must be exactly 0`);
  for (let i = 1; i < s.samples.length; i++) {
    assert.ok(s.samples[i].tSec > s.samples[i - 1].tSec,
      `${where}: tSec must strictly increase (index ${i})`);
  }
  assert.equal(s.samples[s.samples.length - 1].tSec, s.animDurationSec,
    `${where}: the last sample must land on animDurationSec`);
  for (const p of s.samples) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y),
      `${where}: every sample must be finite`);
  }
}

/** A refusal, with the reason. A skip with no reason is unreadable in the field. */
function refusalReason(r: TraceClipResult, where: string): string {
  assert.equal(r.spec, null, `${where}: expected a SKIP, got a drawn arc`);
  assert.equal(r.decision, 'none', `${where}: a skip must decide 'none'`);
  assert.ok(r.reason, `${where}: a skip must carry a reason`);
  return r.reason as string;
}

// ── 1. The two ends of the window, both bypass settings ─────────────────────

test('an impact relocated BEFORE the trimmed clip starts is refused, not drawn at a negative time', () => {
  // The detector found the ball 2.3 s earlier than the app's swing detector did,
  // so the flight sits before the first frame that will be rendered. The old
  // failure would have been an animation starting at -2.3 s.
  for (const knobs of [undefined, { forceTrace: true }]) {
    const r = traceClip(traceInput({
      renderDurationSec: WINDOW_SEC,
      detectToRenderOffsetSec: FLIGHT_START_SEC + 2.3,
      knobs,
    }));
    const why = refusalReason(r, `forceTrace=${!!knobs}`);
    assert.match(why, /render_spec:animStartSec/,
      `expected the window refusal, got: ${why}`);
    assert.match(why, /out of range/);
  }
});

test('an impact relocated PAST the end of the trimmed clip draws onto a HELD FRAME — the bound is the freeze cap, not a refusal', () => {
  // MEASURED, and it is the one thing this file found that the bench does not
  // show. `buildSpec` deliberately measures the draw against the COMPOSED end,
  // which includes the freeze tail, so an animation may legally START after the
  // last real frame of the trimmed clip and be painted entirely over a held
  // still. With the app's 4 s window (2.5 pre / 1.5 post) that happens as soon
  // as the scan moves the impact more than ~1.5 s FORWARD of the app's own.
  //
  // Reproduced on real detections, not just this fixture: replaying the cached
  // sweep detections with the window built the way the APP builds it (around the
  // hint, which is what actually happens — the app's trim is planned before the
  // tracer runs) gives 17 clips at a -3000 ms hint whose arc starts 1.47-1.52 s
  // past the last real frame, and 18 more at -2000 ms. See
  // docs/tracer-v3/verify-window-scan.md §4.
  //
  // WHY IT IS NOT A LIVE BUG. It needs the app's swing detector to fire EARLY by
  // >= 1.5 s, and on the 26 clips with a confirmed impact it never fires more
  // than 0.18 s early — its error is one-sided LATE (max +4.09 s), and the late
  // direction fails safe with the `animStartSec out of range` refusal above.
  //
  // WHAT THIS TEST PINS. Not that it refuses — it does not, and pretending
  // otherwise would be a test that lies. It pins the two things that keep the
  // damage finite and would have to change for this to become a live bug: the
  // draw is capped by `freezeMaxSec`, and it never runs past the composed end.
  // If someone widens `scanRadiusMs`, raises `freezeMaxSec`, or the app's
  // estimator starts firing early, this is the file that says so.
  const knobs = { freezeMaxSec: 6.0, freezeTailSec: 0.6, freezeComplete: true };
  const r = traceClip(traceInput({
    renderDurationSec: 1.0,
    detectToRenderOffsetSec: 0,
    knobs,
  }));
  assertSpecIsRenderable(r, 'past the end');
  assert.ok(r.spec!.animStartSec > 1.0,
    'the fixture must actually put the draw past the end of the footage');
  // The cap: the draw can never begin later than the composed end minus 0.4 s,
  // and the composed end can never exceed the footage plus `freezeMaxSec`.
  assert.ok(r.spec!.animStartSec < 1.0 + knobs.freezeMaxSec - 0.4 + 1e-9,
    `a draw ${r.spec!.animStartSec}s in must stay inside the capped freeze`);
  // And with the freeze OFF there is no held frame to draw onto, so it refuses.
  const noFreeze = traceClip(traceInput({
    renderDurationSec: 1.0, detectToRenderOffsetSec: 0,
    knobs: { ...knobs, freezeComplete: false },
  }));
  assert.match(refusalReason(noFreeze, 'freeze off'), /render_spec:anim window too short/);
});

test('the bypass changes nothing at either end of the window', () => {
  // `forceTrace` bypasses JUDGEMENTS about a shot. A window is not a judgement,
  // so both ends must behave identically with the switch on and off.
  for (const input of [
    { renderDurationSec: WINDOW_SEC, detectToRenderOffsetSec: FLIGHT_START_SEC + 2.3 },
    { renderDurationSec: 1.0, detectToRenderOffsetSec: 0 },
    { renderDurationSec: 0.5, detectToRenderOffsetSec: FLIGHT_START_SEC * 4 },
  ]) {
    const off = traceClip(traceInput(input));
    const on = traceClip(traceInput({ ...input, knobs: { forceTrace: true } }));
    assert.equal(off.spec === null, on.spec === null,
      `forceTrace changed draw/skip at ${JSON.stringify(input)}`);
    assert.equal(off.reason, on.reason);
    if (off.spec && on.spec) {
      assert.equal(off.spec.animStartSec, on.spec.animStartSec);
      assert.equal(off.spec.samples.length, on.spec.samples.length);
    }
  }
});

// ── 2. The whole range the scan can produce, as one property ────────────────

test('over the ENTIRE range the scan can relocate the impact, every outcome is legal', () => {
  // This is the test that actually covers the feature: the scan may move the
  // impact anywhere within +-scanRadiusMs, and the app's window does not move
  // with it. Sweep the resulting mismatch in 50 ms steps across the full range
  // (and a margin beyond it) and require, at EVERY point, either a renderable
  // spec or a reasoned refusal. No throws, no negative starts, no silent
  // zero-length animations.
  const radius = scanRadiusSec();
  assert.ok(radius >= 2, `sanity: the scan must be a real window, got ${radius} s`);
  const lo = -(radius + 1);
  const hi = radius + 1;
  let drew = 0;
  let skipped = 0;
  const reasons = new Set<string>();
  const seq: boolean[] = [];
  for (let off = lo; off <= hi + 1e-9; off += 0.05) {
    const shift = Math.round(off * 1000) / 1000;
    let r: TraceClipResult;
    try {
      r = traceClip(traceInput({
        renderDurationSec: WINDOW_SEC,
        detectToRenderOffsetSec: FLIGHT_START_SEC + shift,
      }));
    } catch (e) {
      assert.fail(`traceClip threw at offset shift ${shift}s: ${e}`);
    }
    seq.push(r.spec !== null);
    if (r.spec) {
      assertSpecIsRenderable(r, `shift ${shift}s`);
      drew++;
    } else {
      reasons.add(refusalReason(r, `shift ${shift}s`).split(':')[0]);
      skipped++;
    }
  }
  assert.ok(drew > 0, 'sanity: some part of the range must still draw, or the fixture is wrong');
  assert.ok(skipped > 0, 'sanity: some part of the range must refuse, or the window is not enforced');
  assert.equal(drew + skipped, Math.round((hi - lo) / 0.05) + 1);
  // The only ways out are the two window refusals. A NEW reason appearing here
  // means the mismatch is being absorbed somewhere else, which is the thing this
  // file exists to notice.
  for (const why of reasons) {
    assert.equal(why, 'render_spec', `unexpected refusal class in the window sweep: ${why}`);
  }
  // ...and the drawable band is CONTIGUOUS. More than one run of `true` would
  // mean the outcome flips back and forth as the impact moves, which no reading
  // of a trim window supports and which makes a field failure unreasonable-about.
  let runs = 0;
  for (let i = 0; i < seq.length; i++) if (seq[i] && !seq[i - 1]) runs++;
  assert.equal(runs, 1, `the drawable band must be contiguous, found ${runs} runs`);
});

// ── 3. The arc follows the BALL, not the window ─────────────────────────────

test('moving the window moves WHEN the arc is drawn, never WHERE', () => {
  // The detections are stamped in absolute clip time, so relocating the impact
  // must not move a single pixel of the trace. If it ever does, the arc is being
  // anchored to the hint instead of to the ball, and a clip whose impact the scan
  // corrected would get an arc drawn in the wrong place — the exact failure the
  // product rule forbids.
  const a = traceClip(traceInput({
    renderDurationSec: WINDOW_SEC, detectToRenderOffsetSec: FLIGHT_START_SEC - 2.4,
  }));
  const b = traceClip(traceInput({
    renderDurationSec: WINDOW_SEC, detectToRenderOffsetSec: FLIGHT_START_SEC - 1.2,
  }));
  assertSpecIsRenderable(a, 'window A');
  assertSpecIsRenderable(b, 'window B');
  assert.equal(a.spec!.samples.length, b.spec!.samples.length);
  for (let i = 0; i < a.spec!.samples.length; i++) {
    assert.equal(a.spec!.samples[i].x, b.spec!.samples[i].x, `sample ${i} x moved`);
    assert.equal(a.spec!.samples[i].y, b.spec!.samples[i].y, `sample ${i} y moved`);
    // tSec is recomputed as (t - offset - t0Clip), so a different offset
    // changes the last bits of the subtraction. 1 ns is 30 000x finer than a
    // 60 fps frame and 1e7 times finer than the renderer's own key spacing.
    assert.ok(Math.abs(a.spec!.samples[i].tSec - b.spec!.samples[i].tSec) < 1e-9,
      `sample ${i} tSec moved by ${a.spec!.samples[i].tSec - b.spec!.samples[i].tSec}`);
  }
  // ...and the animation start moved by exactly the window shift.
  assert.ok(Math.abs((a.spec!.animStartSec - b.spec!.animStartSec) - 1.2) < 1e-9,
    'animStartSec must absorb the whole window shift');
  // The fit itself is untouched: same decision, same flags, same distance claim.
  assert.equal(a.decision, b.decision);
  assert.deepEqual(a.meta.flags, b.meta.flags);
  assert.equal(a.spec!.labelText, b.spec!.labelText);
  assert.equal(a.spec!.labelSubText, b.spec!.labelSubText);
});

// ── 4. The derived impact is a DIAGNOSTIC, never an input to a decision ─────

test('the derived-impact notes cannot change a decision, whatever they say', () => {
  // The ladder reads the detections, not the notes. A corrupted, absurd or
  // missing `impactDerivedMs` must therefore be inert. This matters because the
  // notes are the only place the relocation is recorded, and a future change
  // that started GATING on them would make a diagnostic load-bearing without
  // anyone deciding to.
  const base = traceClip(traceInput());
  const notesToTry: Record<string, string | number | boolean>[] = [
    { impactDerivedMs: 0, impactShiftMs: -8202, impactSource: 'scan', impactTriesUsed: 3 },
    { impactDerivedMs: 999_999, impactShiftMs: 999_999, impactSource: 'offset-ladder' },
    { impactSource: 'none', impactTriesUsed: 17 },
    {},
  ];
  for (const notes of notesToTry) {
    const input = traceInput();
    const r = traceClip({
      ...input,
      detection: { ...input.detection, notes: { ...input.detection.notes, ...notes } },
    });
    const label = JSON.stringify(notes);
    assert.equal(r.decision, base.decision, `decision moved on ${label}`);
    assert.equal(r.reason, base.reason, `reason moved on ${label}`);
    assert.deepEqual(r.meta.flags, base.meta.flags, `flags moved on ${label}`);
    assert.equal(r.spec === null, base.spec === null, `draw/skip moved on ${label}`);
    if (r.spec && base.spec) {
      assert.equal(r.spec.animStartSec, base.spec.animStartSec, `animStartSec moved on ${label}`);
      assert.equal(r.spec.labelText, base.spec.labelText, `pill moved on ${label}`);
    }
  }
});

// ── 5. Bounding, restated where it is cheap to check ────────────────────────

test('the scan cost is bounded by construction, not by luck', () => {
  // IMG_0594 (4.47 s) died with SIGTRAP when the search was widened without a
  // clamp, and imports are routinely short. Three numbers keep the work finite;
  // any of them going unbounded is a hang on a phone, which is worse than a skip.
  const tries = /scanMaxTries\s*=\s*(\d+)/.exec(coreSrc);
  const cands = /scanMaxCandidates\s*=\s*(\d+)/.exec(coreSrc);
  const persist = /scanPersist\s*=\s*(\d+)/.exec(coreSrc);
  assert.ok(tries && cands && persist, 'the three bounds must all be declared');
  assert.ok(Number(tries[1]) >= 1 && Number(tries[1]) <= 4,
    `full detector passes from the scan must stay in 1..4, got ${tries[1]}`);
  assert.ok(Number(cands[1]) >= 1 && Number(cands[1]) <= 64,
    `candidates followed per frame must stay bounded, got ${cands[1]}`);
  assert.ok(Number(persist[1]) >= 1, `the departure must have to persist, got ${persist[1]}`);
});
