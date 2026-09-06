/**
 * The SEAMS of the V3 tracer: the kill switch, the engine switch, the native
 * bridge, the storage migration and the one coordinate conversion.
 *
 * WHY SOURCE TEXT. The surfaces these tests guard import react-native,
 * expo-sqlite and a native module, none of which the node test runner can
 * transform — the same reason `tests/tracerClaims.test.ts`,
 * `tests/tempExportWiring.test.ts` and `tests/privacyManifest.test.ts` assert on
 * source. Where a fact CAN be checked at runtime (the fail-closed variant gate,
 * the GPS config mirror, the render-spec key set) it is, because a runtime
 * assertion cannot be defeated by a reformat.
 *
 * WHAT THEY EXIST FOR. Henry's brief was "make it a config so it's super easy to
 * revert". The product requirement that follows is absolute: with
 * `config.tracer.enabled === false` the app must behave byte-identically to
 * today — no GPS session, no permission prompt, no detection, no render, no UI.
 * Every test below is one way that could quietly stop being true.
 *
 * ONE DELIBERATE EXCEPTION, and it is written here because a doc comment that
 * overstates a guarantee is how the config file's own revert note came to be
 * false (gate NEW-3): `capture_lens` and `capture_zoom` ARE written, non-null,
 * on every clip save with the tracer off. A clip saved without them is one the
 * ladder must refuse forever, so gating them would poison every clip recorded
 * before the flag was flipped. See `constants/config.ts`'s revert note, which
 * now says the same thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config, tracerAllowedOnBinary } from '../constants/config';
import { DEFAULT_GPS_CONFIG, gpsSession } from '../lib/gpsSession';
import { resolveV3Knobs, traceClip, type TracerRenderSpecV3 } from '../lib/tracerV3';
import { traceInput } from './fixtures/tracerV3Clip';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const configSrc = read('constants/config.ts');
const editorSrc = read('hooks/useEditorState.ts');
const cameraSrc = read('hooks/useCamera.ts');
const recordSrc = read('app/(tabs)/record.tsx');
const profileSrc = read('app/(tabs)/profile.tsx');
const bridgeSrc = read('modules/shot-detector/index.ts');
const swiftSrc = read('modules/shot-detector/ios/ShotDetectorModule.swift');
const swiftRenderSrc = read('modules/shot-detector/ios/TracerRenderV3.swift');
const storageSrc = read('lib/storage.ts');
const gpsHookSrc = read('hooks/useGpsSession.ts');
const tracerV3Src = read('lib/tracerV3.ts');

/** Strip comments so prose about a guard does not read as the guard. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// ── 1. The revert switch ────────────────────────────────────────────────────

test('the master kill switch is still a plain literal the claims tests can pin', () => {
  // tests/tracerClaims.test.ts matches `enabled: <literal> as boolean` so that
  // renaming the key cannot silently turn the paywall/onboarding guards into
  // dead code. The dev-variant enablement is therefore a post-definition flip,
  // not a computed property; if someone "tidies" that into a call expression,
  // this test and that one fail together, which is the point.
  assert.match(configSrc, /tracer:\s*\{[\s\S]*?enabled:\s*(true|false) as boolean/);
});

test('the dev-variant flip is fail-closed in both directions', () => {
  // A production binary. The one thing a user would SEE from a wrong answer
  // here is a location permission dialog, so this is defence in depth over the
  // same double gate lib/devPro.ts uses.
  assert.equal(tracerAllowedOnBinary('production', 'com.clippar.app'), false);
  assert.equal(tracerAllowedOnBinary('staging', 'com.clippar.app.staging'), false);
  assert.equal(tracerAllowedOnBinary(undefined, 'com.clippar.app'), false);
  assert.equal(tracerAllowedOnBinary(null, null), false);
  assert.equal(tracerAllowedOnBinary('Development', 'com.clippar.app.dev'), false, 'exact match only');
  // The OTA foot-gun: `extra.variant` is stamped at publish time, so a stray
  // `APP_VARIANT=development eas update --branch production` puts a dev manifest
  // on a production binary. The bundle id is baked in and no OTA can change it.
  assert.equal(tracerAllowedOnBinary('development', 'com.clippar.app'), false);
  // The dev binary itself.
  assert.equal(tracerAllowedOnBinary('development', 'com.clippar.app.dev'), true);
  // No native module to ask (web / a build predating expo-application): the
  // manifest check is all there is, and it is not reachable from a store binary.
  assert.equal(tracerAllowedOnBinary('development', undefined), true);
});

test('under node the tracer reads OFF, which is what makes the off-path testable', () => {
  // expo-constants cannot load here, so the variant is unknown, so the flip does
  // not fire. That is the fail-closed answer and every "with it off" assertion
  // below depends on it.
  assert.equal(config.tracer.enabled, false);
});

test('the engine switch exists, defaults to v3, and keeps v1 reachable', () => {
  assert.equal(config.tracer.engine, 'v3');
  assert.match(configSrc, /engine:\s*'v3' as 'v1' \| 'v3'/);
});

// ── 2. Nothing runs with the flag off ───────────────────────────────────────

test('the tracer batch returns before touching anything when the flag is off', () => {
  const code = codeOnly(editorSrc);
  assert.match(
    code,
    /const processAllTracers = useCallback\(async \(\) => \{\s*if \(!config\.tracer\.enabled[^)]*\) return;/,
    'processAllTracers must bail on !config.tracer.enabled as its FIRST statement'
  );
});

test('the V3 body of the batch is gated on the engine switch', () => {
  const code = codeOnly(editorSrc);
  assert.match(code, /if \(config\.tracer\.engine === 'v3'\) \{/, 'the V3 per-clip body must be engine-gated');
  // ... and it must still call the V3 pair, not the v1 one.
  assert.match(code, /await detectShotV3\(/);
  assert.match(code, /await renderTracerV3\(/);
  // The v1 path must still be there: the engine switch is an A/B, not a
  // replacement, and losing v1 would make the switch a one-way door.
  assert.match(code, /await detectBallLaunch\(/);
  assert.match(code, /await renderTracer\(/);
});

test('no GPS session is mounted unless BOTH the flag and the engine say so', () => {
  const record = codeOnly(recordSrc);
  // The record screen passes the engine check...
  assert.match(record, /useGpsSession\(config\.tracer\.engine === 'v3'\)/);
  // ... and the hook itself ANDs the master switch, so a caller passing `true`
  // by mistake still cannot put a location dialog in front of a production user.
  const hook = codeOnly(gpsHookSrc);
  assert.match(hook, /enabled && config\.tracer\.enabled && Platform\.OS !== 'web'/);
  // Nothing may request location permission outside that gate.
  assert.doesNotMatch(record, /requestForegroundPermissionsAsync/);
});

test('the capture path writes the new GPS columns only on the V3 engine', () => {
  const code = codeOnly(cameraSrc);
  assert.match(
    code,
    /const tracerV3Gps = config\.tracer\.enabled && config\.tracer\.engine === 'v3';/,
    'the session-fix block must be gated on enabled AND engine'
  );
  // The stored series and the recording start are what let the batch re-derive
  // the fix at IMPACT; both must be behind the same gate.
  assert.match(code, /recording_start_ts: tracerV3Gps \?/);
  assert.match(code, /gpsSession\.estimateAtStop\(stopTs\)/);
  assert.match(code, /gpsSession\.seriesAround\(stopTs\)/);
});

test('the tracer never logs a coordinate', () => {
  // PRIV-001: Sentry captures console breadcrumbs, so a logged lat/lon ships a
  // golfer's position with the next handled error. The V3 GPS log prints counts
  // and accuracies only.
  const code = codeOnly(cameraSrc);
  const gpsLog = /\[TRACER-GPS\][\s\S]{0,400}?\)\;/.exec(code);
  assert.ok(gpsLog, 'expected the [TRACER-GPS] diagnostic');
  assert.doesNotMatch(gpsLog[0], /lat|lon|latitude|longitude/i);
});

// ── 3. The native bridge ────────────────────────────────────────────────────

test('both V3 native functions are registered, off the main thread', () => {
  assert.match(swiftSrc, /AsyncFunction\("detectShotV3"\) \{ \(videoUri: String, impactTimeMs: Double, optionsJson: String, promise: Promise\) in/);
  assert.match(swiftSrc, /AsyncFunction\("renderTracerV3"\) \{ \(videoUri: String, specJson: String, promise: Promise\) in/);
  // Both are synchronous and seconds-long; on the main thread they freeze the UI.
  const detect = /AsyncFunction\("detectShotV3"\)[\s\S]{0,400}/.exec(swiftSrc)![0];
  const render = /AsyncFunction\("renderTracerV3"\)[\s\S]{0,400}/.exec(swiftSrc)![0];
  assert.match(detect, /DispatchQueue\.global\(qos: \.userInitiated\)\.async/);
  assert.match(render, /DispatchQueue\.global\(qos: \.userInitiated\)\.async/);
});

test('the JS wrappers forward the exact native arity', () => {
  // Expo Modules matches AsyncFunction arity EXACTLY — a wrapper that omits an
  // optional argument does not call a shorter overload, it fails to find the
  // function at all.
  const code = codeOnly(bridgeSrc);
  assert.match(code, /nativeModule\.detectShotV3\(videoUri, impactTimeMs, optionsJson\)/);
  assert.match(code, /nativeModule\.renderTracerV3\(videoUri, JSON\.stringify\(spec\)\)/);
});

test('an older binary without the V3 pair skips cleanly instead of crashing', () => {
  const code = codeOnly(bridgeSrc);
  assert.match(code, /typeof nativeModule\.detectShotV3 !== "function"/);
  assert.match(code, /typeof nativeModule\.renderTracerV3 !== "function"/);
  // The detector's absence must produce the SAME shape as a failed detection,
  // so the ladder needs no special case for it.
  assert.match(code, /reason: 'native-unavailable'/);
  // And the batch checks once per batch rather than 18 times per round.
  assert.match(code, /export function isTracerV3Available\(\)/);
  assert.match(codeOnly(editorSrc), /const v3Available = config\.tracer\.engine === 'v3' \? isTracerV3Available\(\) : false;/);
});

test('the render spec the ladder emits uses only keys the Swift parser reads', () => {
  // A key the renderer does not read is a silently ignored setting; a key it
  // reads under a different name is a silently ignored setting that LOOKS wired.
  const swiftKeys = new Set(
    Array.from(swiftRenderSrc.matchAll(/obj\["([a-zA-Z]+)"\]/g)).map((m) => m[1])
  );
  // Produce a real spec rather than reading the interface: what matters is the
  // JSON that actually ships.
  const spec = buildRealSpec();
  for (const key of Object.keys(spec)) {
    assert.ok(swiftKeys.has(key), `spec key "${key}" is not read by TracerRenderV3.swift`);
  }
  // ... and the four keys the renderer cannot work without are always present.
  for (const key of ['samples', 'animStartSec', 'animDurationSec', 'depths']) {
    assert.ok(key in spec, `spec is missing "${key}"`);
  }
});

/** A real spec, produced by the ladder from the shared synthetic clip. */
function buildRealSpec(): TracerRenderSpecV3 {
  const result = traceClip(traceInput());
  assert.ok(result.spec, `the wiring fixture must produce a spec; got ${result.reason}`);
  return result.spec;
}

// ── 4. Storage: additive and idempotent ─────────────────────────────────────

test('the new columns are additive ALTER TABLE statements in the shared list', () => {
  assert.match(storageSrc, /'ALTER TABLE local_clips ADD COLUMN recording_start_ts INTEGER'/);
  assert.match(storageSrc, /'ALTER TABLE local_clips ADD COLUMN gps_fix_series TEXT'/);
  assert.match(storageSrc, /'ALTER TABLE local_clips ADD COLUMN gps_fix_meta TEXT'/);
});

test('the migration list never drops or rewrites anything', () => {
  const block = /async function migrateEditorColumns\(\)[\s\S]*?\n\}/.exec(storageSrc);
  assert.ok(block, 'migrateEditorColumns not found');
  assert.doesNotMatch(block[0], /DROP\s+(TABLE|COLUMN)/i);
  assert.doesNotMatch(block[0], /DELETE\s+FROM/i);
  // Idempotent by construction: each statement is swallowed if the column is
  // already there, which is what makes re-running on an existing DB safe.
  assert.match(block[0], /try \{ await db\.execAsync\(sql \+ ';'\); \} catch \{\}/);
});

test('the re-derived impact fix is written with its provenance in one statement', () => {
  // A position without its provenance cannot be told apart from the v1 one-shot
  // fix, so they must never be written separately and never disagree.
  assert.match(
    storageSrc,
    /UPDATE local_clips SET gps_latitude = \?, gps_longitude = \?, gps_accuracy_m = \?, gps_fix_meta = \? WHERE id = \?/
  );
});

// ── 5. The GPS config mirror ────────────────────────────────────────────────

test('config.tracer.gps and DEFAULT_GPS_CONFIG have not drifted apart', () => {
  // lib/gpsSession.ts keeps DEFAULT_GPS_CONFIG as a "test-stable mirror" of the
  // shipped block so its own assertions do not move when the config is retuned.
  // That only works while the two AGREE — otherwise the tests pin numbers the
  // app no longer uses, which is worse than having no mirror at all.
  assert.deepEqual(gpsSession.cfg, DEFAULT_GPS_CONFIG);
});

test('the bag offset is the lab\'s number, under the lab\'s name', () => {
  // tracer-lab/lib/fit.py CarryModel.bag_offset_m = 3.0. The v2 branch called
  // the same quantity filmSpotOffsetVarM; the rename is what stops it being
  // retuned independently of the fit that consumes it.
  assert.equal(config.tracer.gps.bagOffsetM, 3);
  assert.match(configSrc, /bagOffsetM: 3,/);
});

test('every V3 knob in the config block actually reaches the ladder', () => {
  // resolveV3Knobs reads the block STRUCTURALLY and ignores anything it does not
  // recognise, which is what lets a partial block fall back per-key — and is
  // also how a typo in constants/config.ts becomes a knob that silently does
  // nothing. This pins the names on both sides.
  const knobs = resolveV3Knobs(config.tracer);
  assert.equal(knobs.occlusion, config.tracer.v3.occlusion);
  assert.equal(knobs.freezeComplete, config.tracer.v3.freezeComplete);
  assert.equal(knobs.freezeTailSec, config.tracer.v3.freezeTailSec);
  assert.equal(knobs.freezeMaxSec, config.tracer.v3.freezeMaxSec);
  assert.equal(knobs.labelRounding, config.tracer.v3.labelRounding);
  assert.equal(knobs.forceTrace, config.tracer.v3.forceTrace);
  assert.equal(knobs.fitMaxIterations, config.tracer.v3.fitMaxIterations);
  assert.equal(knobs.fitPitchAllowed, config.tracer.v3.fitPitchAllowed);
  assert.equal(knobs.pitchSigmaDeg, config.tracer.v3.pitchSigmaDeg);
  assert.equal(knobs.implausibleCap, config.tracer.v3.implausibleCap);
});

test('the detector knobs the bridge forwards all exist in the config block', () => {
  // These are NOT ladder knobs — they are forwarded to Swift as optionsJson, so
  // a rename here is a silently-ignored detector setting rather than a compile
  // error on the native side.
  const code = codeOnly(bridgeSrc);
  for (const key of [
    'detectPreFrames',
    'detectPostFrames',
    'detectMaxFrames',
    'detectConfFloor',
    'detectMinTrackEmit',
  ] as const) {
    assert.ok(key in config.tracer.v3, `config.tracer.v3.${key} is missing`);
    assert.ok(code.includes(`config.tracer.v3.${key}`), `the bridge never forwards ${key}`);
  }
  // The lab's own numbers, quoted: detect.py P['conf_floor'] and
  // P['min_track_emit'].
  assert.equal(config.tracer.v3.detectConfFloor, 0.4);
  assert.equal(config.tracer.v3.detectMinTrackEmit, 3);
});

// ── 6. The one coordinate conversion ────────────────────────────────────────

test('nothing outside lib/tracerV3.ts flips the y axis of a detection', () => {
  // SHARED CONVENTION 1: detector, camera and fit are TOP-LEFT pixels; the
  // render spec is BOTTOM-LEFT normalized. Exactly one function converts. A
  // second `1 - y/height` anywhere is how the two conventions start disagreeing
  // by a whole frame height.
  const flip = /1\s*-\s*[^;\n]*\/\s*(height|h|detection\.height)\b/;
  assert.doesNotMatch(codeOnly(editorSrc), flip, 'useEditorState must not normalize coordinates');
  assert.doesNotMatch(codeOnly(bridgeSrc), flip, 'the native bridge must not normalize coordinates');
  assert.doesNotMatch(codeOnly(cameraSrc), flip, 'useCamera must not normalize coordinates');
});

test('the conversion is exported from exactly one place and is used by the spec builder', () => {
  assert.match(tracerV3Src, /export function pxToNormalizedBottomLeft\(/);
  assert.match(codeOnly(tracerV3Src), /pxToNormalizedBottomLeft\(\{ x: s\.x, y: s\.y \}, width, height\)/);
});

// ── 7. The dev surface ──────────────────────────────────────────────────────

test('the dev-settings entry point is gated on the dev VARIANT, not on __DEV__', () => {
  // __DEV__ is false in a Release dev build (eas.json `dev-standalone`), which
  // is the binary an actual field test runs on — gating on it would hide the
  // screen exactly when it is needed.
  const code = codeOnly(profileSrc);
  assert.match(code, /\{isDevVariant\(\) &&[\s\S]{0,400}tracer-dev-settings/);
});

test('the dev-settings row also honours the one-line revert', () => {
  // The product requirement is that with config.tracer.enabled false there is
  // NO UI. isDevVariant() alone does not carry that: setting
  // ENABLE_TRACER_ON_DEV_VARIANT = false leaves the flag false on a DEV binary,
  // where isDevVariant() is still true — so the row survived the revert with
  // every toggle behind it inert. Both conditions, or the contract is a claim.
  const code = codeOnly(profileSrc);
  assert.match(
    code,
    /\{isDevVariant\(\) && config\.tracer\.enabled && \([\s\S]{0,600}tracer-dev-settings/,
    'app/(tabs)/profile.tsx must gate the tracer dev-settings row on BOTH the dev ' +
      'variant and config.tracer.enabled, so the one-line revert leaves no UI behind'
  );
});

test('the debug bypasses always BOOT off, whatever was persisted last round', () => {
  // constants/config.ts is the boot state; the dev screen may only turn a bypass
  // on again explicitly. A crash mid-round must not leave one armed.
  assert.match(configSrc, /debugForceTrace: false as boolean/);
  assert.match(configSrc, /gpsOnlyTrace: false as boolean/);
  assert.match(configSrc, /forceTrace: false as boolean/);
  assert.equal(config.tracer.v3.forceTrace, false);
});

// ── 8. Capture optics: the lens a clip was shot on (review F3a) ─────────────

test('the capture-optics columns are additive ALTER TABLE statements too', () => {
  // The V3 fit's world scale is f_px, and native getCameraFovDeg() only knows
  // the 1x wide lens's FORMAT field of view. The record screen has a 0.5x
  // toggle and pinch zoom, so a clip shot at 1.5x was drawn as "140 m" for a
  // 202 m shot. These two columns are the only record of which it was.
  assert.match(storageSrc, /'ALTER TABLE local_clips ADD COLUMN capture_lens TEXT'/);
  assert.match(storageSrc, /'ALTER TABLE local_clips ADD COLUMN capture_zoom REAL'/);
});

test('the capture path records the lens and the PEAK zoom of every clip', () => {
  const camera = codeOnly(cameraSrc);
  // Written on the same INSERT as the other capture fields.
  assert.match(camera, /capture_lens: captureOptics\?\.lens \?\? undefined,/);
  assert.match(camera, /capture_zoom: captureOptics\?\.zoom \?\? undefined,/);
  // NOT gated on config.tracer: a clip saved without these is one the ladder
  // must refuse forever, so withholding them behind the flag would poison every
  // clip recorded before it was flipped.
  const optics = /let captureOptics[\s\S]{0,400}?\}\n/.exec(camera);
  assert.ok(optics, 'expected the capture-optics read in useCamera');
  assert.doesNotMatch(optics[0], /tracerV3Gps|config\.tracer/);

  const record = codeOnly(recordSrc);
  // The PEAK over the recording, not the value at the stop press: unlike the
  // lens toggle, pinch is deliberately not blocked mid-clip.
  assert.match(record, /getCaptureOptics: useCallback\(\s*\(\) => \(\{ lens: zoomMode, zoom: captureZoomPeak\.current \}\)/);
  assert.match(record, /runOnJS\(applyZoom\)\(/, 'the pinch gesture must raise the peak, not call setZoom directly');
  assert.match(record, /if \(v > captureZoomPeak\.current\) captureZoomPeak\.current = v;/);
});

test('GATE NEW-2: the optics are frozen at the stop press, not read during finalization', () => {
  // THE FINDING. `getCaptureOptics()` was called inside the save, which runs in
  // the 5-10 s window between the stop press and the recordAsync promise
  // resolving. In that window the 0.5x/1x pill and the flip button were still
  // live (they were gated on `isRecording`, which stopRecording clears on its
  // FIRST line), and both call `resetPinchZoom()`, which sets
  // `captureZoomPeak.current = 0` — a ref, one object, read live by the
  // still-running save. So "put the framing back" in the seconds after a stop
  // recorded `zoom: 0` for a clip shot zoomed, the F3a lens gate passed the
  // row, and the clip drew -28 % with nothing downstream able to tell.
  //
  // READ FROM SOURCE, NOT PRESSED ON A DEVICE. Nobody has run this on a phone.
  const camera = codeOnly(cameraSrc);

  // 1. The snapshot exists and is taken in stopRecording.
  assert.match(camera, /const capturedOpticsRef = useRef<\{ lens: string; zoom: number \} \| null>\(null\);/);
  const stop = /const stopRecording = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(camera);
  assert.ok(stop, 'expected stopRecording to still be a dependency-free callback');
  assert.match(stop[1], /capturedOpticsRef\.current = getCaptureOpticsRef\.current\?\.\(\) \?\? null;/);
  // Taken BEFORE the eager state flip, so nothing that runs after the press can
  // reach it — including the flip itself re-enabling the controls.
  assert.ok(
    stop[1].indexOf('capturedOpticsRef.current =') < stop[1].indexOf('setIsRecording(false)'),
    'the snapshot must be taken before the recording flag is cleared'
  );

  // 2. The save reads the snapshot, and consumes it so it cannot leak forward.
  assert.match(
    camera,
    /let captureOptics: \{ lens: string; zoom: number \} \| null = capturedOpticsRef\.current;\n\s*capturedOpticsRef\.current = null;/
  );

  // 3. And the controls that could rewrite it are gated on the WHOLE busy
  //    window, the house pattern tests/trainingMode.test.ts asserts for every
  //    other round-mutating control on this screen.
  const record = codeOnly(recordSrc);
  assert.match(record, /const recordingBusy = camera\.isRecording \|\| camera\.isFinalizing;/);
  for (const fn of ['flipCamera', 'selectZoom']) {
    const body = new RegExp(`const ${fn} = useCallback\\(([\\s\\S]*?)\\n  \\);`).exec(record);
    assert.ok(body, `expected ${fn} to be a useCallback`);
    assert.match(body[1], /if \(recordingBusy\) return;/, `${fn} must check recordingBusy`);
    assert.doesNotMatch(body[1], /if \(camera\.isRecording\) return;/);
  }
  // The two Pressables themselves, so the control is unreachable as well as inert.
  assert.match(record, /onPress=\{\(\) => selectZoom\(m\)\}\s*\n\s*disabled=\{recordingBusy\}/);
  assert.match(record, /onPress=\{flipCamera\}\s*\n\s*disabled=\{recordingBusy\}/);
});

test('the batch always hands the ladder the capture optics, nulls included', () => {
  // Omitting the field is a REFUSAL in lib/tracerV3.ts, and that is the point:
  // a row written before capture_lens existed must reach the refusal rather
  // than be silently treated as 1x.
  assert.match(
    codeOnly(editorSrc),
    /capture: \{ lens: row\.capture_lens, zoom: row\.capture_zoom \}/,
    'processAllTracers must pass the row\'s capture optics to traceClip'
  );
});

test('GATE NEW-3: the revert note and the code agree about the two capture columns', () => {
  // The finding was an honesty one, and it is the second time this exact comment
  // has drifted: the same change set that ungated `capture_lens` / `capture_zoom`
  // left the revert note saying `saveLocalClip` "binds those columns to NULL on
  // every save" and that reverting writes "no new columns". Both were false the
  // day they were written. Two files in one change set disagreeing about the
  // same fact is how a brain becomes confidently wrong, so the disagreement is
  // now the thing that fails a test rather than the thing a later agent finds.
  const camera = codeOnly(cameraSrc);
  const ungated = /capture_lens: captureOptics\?\.lens \?\? undefined,/.test(camera);
  assert.ok(ungated, 'the precondition: the columns are still written from the save');

  const revert = /THE ONE-LINE REVERT:[\s\S]*?const ENABLE_TRACER_ON_DEV_VARIANT/.exec(configSrc);
  assert.ok(revert, 'expected the revert note above ENABLE_TRACER_ON_DEV_VARIANT');
  assert.doesNotMatch(revert[0], /NULL on every save/, 'they are not bound to NULL');
  assert.doesNotMatch(revert[0], /no new columns? WRITTEN/i, 'they ARE written');
  assert.match(revert[0], /capture_lens/, 'the note must name what survives the revert');
  assert.match(revert[0], /capture_zoom/);
  assert.match(revert[0], /WRITTEN, non-null/, 'and say plainly that they are written');
});

test('GATE-3: the revert note lists everything that survives, and each item is true in the code', () => {
  // The THIRD drift of this one comment, and the reason it now has a test of its
  // own rather than a footnote. It said "byte-identical" (review F9/F10), then
  // "no new columns WRITTEN" (gate NEW-3), then "FOUR things survive" while the
  // list was six long (gate GATE-3). Each version read as exhaustive, which is
  // exactly what makes a short list worse than no list.
  //
  // So both halves are asserted: the note names the two items it used to omit,
  // AND those items are genuinely still there in the source it describes. If
  // someone removes the singleton or the model bundle, this fails and the note
  // gets shortened deliberately instead of drifting again.
  const revert = /THE ONE-LINE REVERT:[\s\S]*?const ENABLE_TRACER_ON_DEV_VARIANT/.exec(configSrc);
  assert.ok(revert, 'expected the revert note above ENABLE_TRACER_ON_DEV_VARIANT');
  assert.doesNotMatch(revert[0], /FOUR things survive/, 'the count was short by two');
  assert.match(revert[0], /SIX things survive/);
  for (let i = 1; i <= 6; i++) {
    assert.match(revert[0], new RegExp(`^//\\s+${i}\\. `, 'm'), `item ${i} must be listed`);
  }

  // Item 5, in the code: the singleton is constructed at module scope, so it is
  // built on import whatever the flag says. The flag is read INSIDE it.
  const gpsSrc = codeOnly(read('lib/gpsSession.ts'));
  assert.match(
    gpsSrc,
    /^export const gpsSession = new GpsSession\(/m,
    'the singleton must still be module-level, or item 5 is stale'
  );
  assert.match(revert[0], /gpsSession/, 'and the note must name it');

  // Item 6, in the code: the model bundle and the CoreML link are in the podspec,
  // and the two V3 entry points are registered in the module, all ungated.
  const podspec = read('modules/shot-detector/ios/ShotDetector.podspec');
  assert.match(podspec, /GolfBallDetector\.mlpackage/, 'the model still ships in every binary');
  assert.match(podspec, /s\.frameworks[^\n]*CoreML/, 'and CoreML is still linked');
  assert.match(swiftSrc, /AsyncFunction\("detectShotV3"\)/);
  assert.match(swiftSrc, /AsyncFunction\("renderTracerV3"\)/);
  assert.match(revert[0], /mlpackage/i, 'and the note must name the payload');
  assert.match(revert[0], /CoreML/);
});

test('an unknown lens is a refusal in the ladder, not a default', () => {
  // The runtime half of the test above — the type makes `capture` optional, so
  // only this says what omitting it MEANS.
  const skipped = traceClip(traceInput({ capture: undefined }));
  assert.equal(skipped.spec, null);
  assert.match(String(skipped.reason), /^lens_unsupported:/);
});

// ── 9. The debug bypass does not survive the screen (review F6) ─────────────

test('the V3 force-trace bypass is never persisted, so opening the screen cannot re-arm it', () => {
  const dev = read('app/profile/tracer-dev-settings.tsx');
  const code = codeOnly(dev);
  // The bypass boots off (asserted above) — but it used to be written to the
  // settings table and rehydrated on EVERY mount of this screen, which is the
  // one screen a golfer opens mid-round to ask "why did that skip?". A street
  // test three days earlier therefore re-armed itself.
  assert.doesNotMatch(code, /tracer_v3_force_trace/, 'the V3 bypass must not have a settings key at all');
  const toggle = /const toggleV3ForceTrace = [\s\S]{0,500}?\n  \}/.exec(code);
  assert.ok(toggle, 'expected toggleV3ForceTrace');
  assert.doesNotMatch(toggle[0], /setSetting|persistBool/, 'it must be in-memory for the session only');
  // The two v1 bypasses are unchanged: they are the v2 screen's, and this
  // finding was about the V3 one.
  assert.match(code, /getSetting\(SETTING_DEBUG_FORCE_TRACE\)/);
});
