/**
 * THE IMPACT SCAN — the detector derives the impact from the video instead of
 * trusting the one it is handed.
 *
 * WHY THIS FILE EXISTS. Every frame the native detector reads is anchored to the
 * impact it is given: the background stack, the three address frames, the
 * departure scan and the launch search. Measured on Henry's own footage
 * (IMG_0601, 6 Sep, a macOS harness around the real Swift) the true impact
 * returns 44 detections and HALF A SECOND either side returns ZERO.
 *
 * And the impact the app hands it is not close enough. The app has TWO
 * estimators: `visionDetectAndTrim` (swing-vision) runs FIRST at both import
 * call sites in hooks/useEditorState.ts and `config.detection.swingVision` is
 * true, so `detectAndTrim` is only the fallback. Both were compiled and run over
 * the 36 lab clips against the labelled audio impacts:
 *     swing-vision   median 0.17 s, 24/36 within 0.5 s, worst 5.70 s
 *     detectAndTrim  median 0.84 s, 13/36 within 0.5 s, worst 4.93 s
 * The primary is much better and still leaves ONE CLIP IN THREE beyond the half
 * second that is total failure.
 *
 * So the scan finds the static ball once at the head of a bounded window and
 * follows its own patch forward until it leaves and does not come back. Measured
 * on the 8 hand-labelled lab clips, fed the app's own impact: every derived
 * impact within 3 frames of the hand label, 7/8 emitted, 184 detections and a
 * mean address error of 1.71 px — against 7/8, 183 and 1.91 px for the detector
 * fed the HAND-LABELLED impact. See docs/tracer-v3/impact-scan.md.
 *
 * WHY SOURCE TEXT. The scan is Swift the node test runner cannot execute, the
 * same reason tests/tracerV3Wiring.test.ts asserts on source. Each assertion
 * below is one way the design could quietly stop being true while still
 * compiling — a search that stops being bounded, a second scorer growing beside
 * the address finder, a refusal being softened to lift the hit rate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { traceClip } from '../lib/tracerV3';
import { traceInput } from './fixtures/tracerV3Clip';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const driver = read('modules/shot-detector/ios/TracerDetect.swift');
const core = read('modules/shot-detector/ios/TracerDetectCore.swift');

/** Strip comments so prose ABOUT a guard does not read as the guard. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/^[ \t]*\/\/\/.*$/gm, '');

const driverCode = codeOnly(driver);
const coreCode = codeOnly(core);

// ── 1. The scan exists and is the entry point ───────────────────────────────

test('the public entry point runs the impact scan before the detector', () => {
  assert.match(driverCode, /static func scanForImpact\(/, 'the scan must exist');
  assert.match(
    driverCode,
    /private static func detectOnce/,
    'the single-attempt worker must stay private behind the searching entry point'
  );
  // The scan must actually be called from the entry point, not merely declared.
  const entry = driverCode.slice(driverCode.indexOf('public static func detect(assetURL: URL, impactTimeMs: Double,\n                              options: TracerDetectOptions)'));
  assert.match(entry, /hits = scanForImpact\(/, 'detect() must call the scan');
  assert.match(entry, /detectOnce\(assetURL: assetURL, impactTimeMs: Double\(hit\.impactFrame\)/,
    'detect() must anchor the real detector on what the scan derived');
});

// ── 2. It is BOUNDED. A 4.5 s import must not walk off either end ───────────

test('the scan window is clamped to what the clip can actually hold', () => {
  // IMG_0594 is 4.47 s and the previous +-3 s widening died on it with SIGTRAP.
  assert.match(driverCode, /let kMinImpact = f30\(26\)/, 'impacts must leave room for the background stack');
  assert.match(driverCode, /let kMaxImpact = totalFrames - f30\(8\)/, 'impacts must leave room for a departure');
  assert.match(driverCode, /if kMaxImpact <= kMinImpact \{/, 'a clip too short to scan must bail, not clamp to nonsense');
  assert.match(driverCode, /let scanLo = max\(kMinImpact, hintFrame - radius\)/);
  assert.match(driverCode, /let scanHi = min\(kMaxImpact, hintFrame \+ radius\)/);
  assert.match(driverCode, /if scanHi < scanLo \{/, 'an empty window must bail');
  // ...and the anchor frames must sit at or after the start of the clip.
  assert.match(driverCode, /let anchorBase = max\(0, scanLo - f30\(30\)\)/);
  // The follow pass must stop inside the clip too.
  assert.match(driverCode, /let seriesHi = min\(totalFrames - 1,/);
});

test('the search radius is a real window, not the whole clip and not a token one', () => {
  const decl = /scanRadiusMs\s*=\s*([0-9.]+)/.exec(coreCode);
  assert.ok(decl, 'scanRadiusMs must be declared');
  const radiusMs = Number(decl[1]);
  // The field failures were 1.5-3 s out (IMG_0596 2.4 s, IMG_0598 1.5 s) and the
  // app hint's measured worst case is 4.93 s, so anything under ~2 s is theatre.
  assert.ok(radiusMs >= 2000, `scanRadiusMs must reach at least +-2 s, got ${radiusMs}`);
  // ...and unbounded is not a window: at some point it stops being "the shot the
  // app meant" and becomes "any ball anywhere in the video".
  assert.ok(radiusMs <= 10000, `scanRadiusMs must stay a WINDOW, got ${radiusMs}`);
});

// ── 3. One pass, not seventeen ──────────────────────────────────────────────

test('the SCAN is what settles a clip, and the brute force is only a fallback', () => {
  const tries = /scanMaxTries\s*=\s*(\d+)/.exec(coreCode);
  assert.ok(tries, 'scanMaxTries must be declared');
  assert.ok(Number(tries[1]) <= 4, `at most a handful of scan-derived passes, got ${tries[1]}`);

  // The extra "try the impact you were given" pass rescued a clip the scan could not
  // ZERO times across 100 clips, and cost a full detector pass on every clip that
  // exhausted the scan's candidates. Turning it back on is a decision that needs a
  // measurement, not a hunch — and it does NOT gate reporting on the given impact,
  // which still happens when the scan finds no departing ball at all.
  const given = /scanTryGivenLast\s*=\s*(true|false)/.exec(coreCode);
  assert.ok(given, 'scanTryGivenLast must be declared');
  assert.equal(given[1], 'false', 'the extra given-impact pass must ship OFF — it rescued nothing');

  // THE SCAN DOES NOT STRICTLY DOMINATE THE LADDER, and this test exists so nobody
  // deletes the ladder on the assumption that it does. Measured on 36 lab clips,
  // same binary, same hints: ladder only 19/36 emitted for 404 detector passes;
  // scan only 17/36 for 61. The scan gains IMG_3640 and loses IMG_3622, IMG_3623,
  // IMG_3645 — on two of those it never saw the ball's departure at all.
  const ladder = /scanFallbackLadder\s*=\s*(true|false)/.exec(coreCode);
  assert.ok(ladder, 'scanFallbackLadder must be declared');
  assert.equal(ladder[1], 'true',
    'the brute force must stay reachable as a FALLBACK — it emits 3 clips the scan alone misses');
  // ...but it must be a fallback, reached only after the scan, not the first thing tried.
  const entry = driverCode.slice(driverCode.indexOf('func stamp('));
  assert.ok(
    entry.indexOf('for hit in hits.prefix') < entry.indexOf('if params.scanFallbackLadder'),
    'the scan must run BEFORE the ladder, or the one-pass saving is gone'
  );
  assert.match(entry, /triedFrames\.contains\(where: \{ abs\(\$0 - f\) <= 1 \}\)/,
    'the ladder must skip an impact the scan already handed to the detector');
});

test('the follow pass reads only the pixels under the candidates', () => {
  // The whole cost argument. If this ever goes back to rotating and luma-planing
  // every frame of a seven-second window, the scan stops being affordable.
  assert.match(driverCode, /func forEachRaw\(/, 'the raw (unrotated) pump must exist');
  assert.match(driverCode, /static func boxLumaMeans\(/, 'the box reader must exist');
  const scan = driverCode.slice(driverCode.indexOf('static func scanForImpact('),
                                driverCode.indexOf('public static func detect(assetURL: URL, impactTimeMs: Double,\n                              options: TracerDetectOptions)'));
  assert.match(scan, /pump2\.forEachRaw \{/, 'the follow pass must use the raw pump');
  assert.doesNotMatch(scan, /pump2[\s\S]{0,200}tracerLumaPlane/,
    'the follow pass must not build a full luma plane per frame');
  // All four rotations must be inverted, or a portrait clip reads the wrong pixels.
  for (const c of ['case 90:', 'case 180:', 'case 270:']) {
    assert.ok(driverCode.slice(driverCode.indexOf('static func boxLumaMeans(')).includes(c),
      `boxLumaMeans must invert rotation ${c}`);
  }
});

// ── 4. It reuses the address machinery rather than growing a second scorer ──

test('the scan finds candidates with the EXISTING address finder', () => {
  const scan = driver.slice(driver.indexOf('static func scanForImpact('));
  assert.match(scan, /tracerAddressCandidates\(/, 'the scan must use the shipped address finder');
  assert.match(scan, /TracerVisionPose\.pose\(/, 'with the same pose');
  assert.match(scan, /tracerGolferGeometry\(/, 'and the same golfer geometry');
  assert.match(scan, /TracerBallModel\.shared\.detect\(/, 'and the same Core ML ball model');
  assert.match(scan, /tracerBallContrast\(/, 'and the same contrast measure for the reference');
});

test('the departure test keeps every rule the ten-frame version had', () => {
  const dep = coreCode.slice(coreCode.indexOf('public func tracerScanDeparture('),
                             coreCode.indexOf('public struct AddressInfo'));
  assert.match(dep, /params\.departFrac \* cRef/, 'same step threshold');
  assert.match(dep, /params\.departDriftMax \* step/, 'same drift rule');
  assert.match(dep, /if n - i <= persist \{ break \}/, 'a change with nothing after it must still fail');
  assert.match(dep, /persistent = false/, 'the change must still persist');
  // ...and the two rules a long window makes possible.
  assert.match(dep, /returnRate > params\.scanReturnFrac/, 'a patch that comes back is not a ball that left');
  assert.match(dep, /params\.scanPreNoiseFrac \* Double\(i - preLo\)/, 'the pre-window must be mostly quiet');
  // The original ten-frame test must still be there for detectOnce.
  assert.match(coreCode, /public func tracerDepartureFrame\(/, 'the original departure test must survive');
});

test('the never-returns and quiet-pre rules are set to values that can actually refuse', () => {
  const ret = Number(/scanReturnFrac\s*=\s*([0-9.]+)/.exec(coreCode)![1]);
  const pre = Number(/scanPreNoiseFrac\s*=\s*([0-9.]+)/.exec(coreCode)![1]);
  const persist = Number(/scanPersist\s*=\s*(\d+)/.exec(coreCode)![1]);
  assert.ok(ret > 0 && ret <= 0.25, `scanReturnFrac must refuse a patch that comes back, got ${ret}`);
  // NOT zero, and the reason is measured: on IMG_3629 the ball's own patch reads
  // 223 for a single frame at 98 (a waggle) and 223 again, then departs at f169.
  assert.ok(pre > 0 && pre <= 0.35, `scanPreNoiseFrac must tolerate a waggle but not noise, got ${pre}`);
  assert.ok(persist >= 4, `the departure must hold for real, got ${persist} frames`);
});

// ── 5. It must not fabricate ────────────────────────────────────────────────

test('a window with no departing ball emits nothing — no refusal was softened', () => {
  // The two refusals that stop a fabricated arc must be untouched in detectOnce.
  assert.match(driver, /address refused: weak contrast and outside the pose ROI/);
  assert.match(driver, /no persistent departure in impact/);
  // ...and the scan itself must return an empty list rather than a guess.
  const scan = driverCode.slice(driverCode.indexOf('static func scanForImpact('));
  assert.match(scan, /guard !cands\.isEmpty else \{[\s\S]{0,200}return \[\]/,
    'no static patch anywhere must return nothing, not a fallback position');
  // The hint-proximity term must stay a TIE-BREAK. A term that can zero a
  // candidate out is a gate, and a gate on the hint is the bug being fixed.
  assert.match(scan, /let prox = 0\.35 \+ 0\.65 \* exp\(/,
    'the hint preference must be bounded well away from zero');
});

test('the emission rule and the address weak-contrast refusal are unchanged', () => {
  assert.match(coreCode, /public var minTrackEmit = 3/);
  assert.match(coreCode, /public var confFloor = 0\.4/);
  assert.match(coreCode, /public var addrWeakC = 8\.0/);
  assert.match(coreCode, /public var acceptFirst = 0\.35/);
  assert.match(coreCode, /public var departFrac = 0\.45/);
});

// ── 6. It reports both numbers, and they survive to the field row ───────────

test('every row carries the impact it was given AND the impact it derived', () => {
  for (const key of ['impactGivenMs', 'impactDerivedMs', 'impactShiftMs', 'impactSource',
                     'impactTriesUsed', 'scanCandidates', 'scanDepartures']) {
    assert.match(driverCode, new RegExp(`n\\["${key}"\\]|notes\\["${key}"\\]`),
      `${key} must be on the row`);
  }
  // Both the success and the failure path go through the same stamp.
  const entry = driverCode.slice(driverCode.indexOf('func stamp('));
  assert.match(entry, /n\["impactGivenMs"\] = Int\(impactTimeMs\.rounded\(\)\)/);
});

test('notes stay JSON primitives — the JS side types them as string | number | boolean', () => {
  // `notes` is `Record<string, string | number | boolean>` in lib/tracerV3.ts and
  // is JSON.stringified into tracer_meta. A null or an array here is a lie about
  // the shape, which is how a field row becomes unreadable.
  //
  // ONE KNOWN PRE-EXISTING EXCEPTION, named rather than hidden:
  // `notes["addressContrast"]` has always been `... ?? NSNull()`. It predates the
  // scan, nothing here changed it, and widening the JS type or changing that line
  // is a separate decision in someone else's file. Every key the scan adds is
  // held to the contract.
  const scanKeys = [
    'impactGivenMs', 'impactDerivedMs', 'impactShiftMs', 'impactSource', 'impactTriesUsed',
    'scanCandidates', 'scanDepartures', 'scanFrames', 'impactScan', 'oneOffMsImpactScan',
    'scanHits', 'scanCandidateList',
  ];
  const notesAssignments = driver.match(/\b(?:n|notes)\["[A-Za-z_]+"\] = [^\n]+/g) ?? [];
  assert.ok(notesAssignments.length > 10, 'sanity: the scan writes notes');
  const seen = new Set<string>();
  for (const line of notesAssignments) {
    const key = /\["([A-Za-z_]+)"\]/.exec(line)![1];
    if (!scanKeys.includes(key)) continue;
    seen.add(key);
    assert.doesNotMatch(line, /NSNull\(\)/, `notes must omit a key rather than null it: ${line}`);
    assert.doesNotMatch(line, /\]\s*$/, `a notes value must not be an array literal: ${line}`);
  }
  for (const k of ['impactGivenMs', 'impactSource', 'scanCandidates']) {
    assert.ok(seen.has(k), `${k} must actually be written`);
  }
});

test('the ladder carries the derived impact through to the field row', () => {
  const input = traceInput();
  const withScan = {
    ...input,
    detection: {
      ...input.detection,
      notes: {
        ...input.detection.notes,
        impactGivenMs: 8202,
        impactDerivedMs: 5600,
        impactShiftMs: -2602,
        impactSource: 'scan',
        impactTriesUsed: 1,
      },
    },
  };
  const base = traceClip(input);
  const scanned = traceClip(withScan);
  // The new notes are diagnostics. They must reach the row and must NOT change
  // a single decision the ladder makes.
  assert.equal(scanned.meta.detectorNotes.impactDerivedMs, 5600);
  assert.equal(scanned.meta.detectorNotes.impactShiftMs, -2602);
  assert.equal(scanned.meta.detectorNotes.impactSource, 'scan');
  assert.equal(scanned.meta.decision, base.meta.decision);
  assert.equal(scanned.meta.reason, base.meta.reason);
  assert.deepEqual(scanned.meta.flags, base.meta.flags);
  assert.equal(scanned.spec === null, base.spec === null);
});

// ── 7. Reversible without a native rebuild ──────────────────────────────────

test('the pre-scan behaviour is reachable from the options JSON', () => {
  // Henry's standing requirement is that anything like this is trivially
  // revertible. `{"scanEnabled": false, "scanFallbackLadder": true}` is exactly
  // what shipped before, with no rebuild.
  assert.match(driverCode, /if let v = b\("scanEnabled"\) \{ params\.scanEnabled = v \}/);
  assert.match(driverCode, /if let v = b\("scanFallbackLadder"\) \{ params\.scanFallbackLadder = v \}/);
  assert.match(driverCode, /if params\.scanFallbackLadder \{/, 'the old ladder must still be runnable');
  assert.match(coreCode, /public var scanEnabled = true/);
});
