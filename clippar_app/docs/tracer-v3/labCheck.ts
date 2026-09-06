/**
 * labCheck — an INDEPENDENT numeric check of the ported TS pipeline against the tracer lab.
 *
 * Written by the `verify` agent; the transcript of its output is in `verify.md` §5.
 *
 * WHY IT DOES NOT USE `tests/fixtures/tracerFitClips.ts`. That fixture is another agent's
 * TRANSCRIPTION of the lab's labels and cameras into the repo, and a transcription error is
 * precisely the failure this check exists to catch. Everything below is read at run time from
 * the lab itself — the same files `lib/fit.py` reads.
 *
 * THIS IS A SCRATCH TOOL, NOT A TEST. It is deliberately not under `tests/`, so
 * `npm run verify` never runs it: it needs a checkout of ~/projects/clippar/tracer-lab, which
 * CI does not have. It is in the `tsconfig` include glob, so it must still typecheck cleanly —
 * hence the real types below rather than `any`. Point it somewhere else with TRACER_LAB=/path,
 * and it prints a skip rather than throwing when the lab is not there.
 *
 *   $ node --import tsx docs/tracer-v3/labCheck.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { TracerCamera } from '../../lib/tracerCamera';
import { fitLaunch, type TrackPoint } from '../../lib/tracerFit';
import { traceClip, type BallDetection, type TracerDetectResultV3 } from '../../lib/tracerV3';

const LAB = process.env.TRACER_LAB ?? `${process.env.HOME}/projects/clippar/tracer-lab`;

// ── The lab's own file shapes (data/labels/*.json, experiments/camera/calibration.json) ──
interface LabLabel { frame: number; x: number | null; y: number | null; r?: number; visible?: boolean; quality: string }
interface LabFile {
  fps: number; width: number; height: number; impact_frame: number; last_visible_frame: number;
  address: { x: number; y: number; r: number }; labels: LabLabel[];
}
interface LabCameraClip {
  f_px: number; width: number; height: number; pitch_deg: number; roll_deg: number;
  h_cam_used_m: number; horizon_row_px: number;
}

/** experiments/fit/common.py: BUCKET and IMPACT_OVERRIDE. */
const BUCKET = { IMG_3631: 'driver', IMG_3649: 'driver' } as const;
type Clip = keyof typeof BUCKET;
const IMPACT_OVERRIDE: Partial<Record<Clip, number>> = { IMG_3649: 430 };

/**
 * Lab reference: pixel-only `full` model, ALL flight frames, on the CURRENT
 * (wave-3-corrected) labels. Read out of
 * experiments/fit2/results/carry_sweep_prior_all.csv, columns n / v0_px / carry_px /
 * carry_px_sigma / chi2_px_pxonly. `carrySigmaMc64` is a SINGLE 64-draw Monte-Carlo
 * sample and is noisy by construction — see `carrySigmaConverged`, which is the lab's
 * own code re-run here at mc_samples=4096.
 */
const REF: Record<Clip, { n: number; v0: number; carryM: number; carrySigmaMc64: number;
                          carrySigmaConverged: number; chi2Px: number }> = {
  IMG_3631: { n: 39, v0: 73.094, carryM: 244.40, carrySigmaMc64: 3.29, carrySigmaConverged: 3.11, chi2Px: 7.767 },
  IMG_3649: { n: 27, v0: 73.649, carryM: 220.00, carrySigmaMc64: 12.06, carrySigmaConverged: 11.44, chi2Px: 25.806 },
};

/** experiments/fit/report.md §2, for the parameters the CSV does not carry.
 *  IMG_3649's row there predates the label correction, so it is quoted, not asserted. */
const REF_TABLE: Record<Clip, { thetaDeg: number; phiDeg: number; rpmBack: number; tiltDeg: number;
                                t0MinusKimpFrames: number; rmsPx: number; apexM: number; hangS: number; stale: boolean }> = {
  IMG_3631: { thetaDeg: 12.1, phiDeg: 10.1, rpmBack: 3216, tiltDeg: -11.2, t0MinusKimpFrames: 0.32, rmsPx: 1.01, apexM: 34, hangS: 7.2, stale: false },
  IMG_3649: { thetaDeg: 7.6, phiDeg: -0.7, rpmBack: 2208, tiltDeg: -3.6, t0MinusKimpFrames: 0.74, rmsPx: 2.38, apexM: 15.7, hangS: 5.2, stale: true },
};

/** experiments/camera/calibrate.py MEAS: the ball diameter used to derive h_cam. It is a
 *  SECOND, independent measurement of the same ball as the label file's `address.r`. */
const CAL_DIAM_PX: Record<Clip, number> = { IMG_3631: 29.5, IMG_3649: 24.0 };
const LAB_HCAM_M: Record<Clip, number> = { IMG_3631: 1.104043, IMG_3649: 1.258102 };

function loadClip(clip: Clip) {
  const lab = JSON.parse(readFileSync(`${LAB}/data/labels/${clip}.json`, 'utf8')) as LabFile;
  const cal = (JSON.parse(readFileSync(`${LAB}/experiments/camera/calibration.json`, 'utf8')) as
    { clips: Record<string, LabCameraClip> }).clips[clip];
  // common.py flight_labels(): visible, x present, frame <= FLIGHT_LAST (no entry for these two).
  const visible = lab.labels.filter((l): l is LabLabel & { x: number; y: number } =>
    (l.visible ?? true) && l.x !== null && l.y !== null);
  // conf 1 = the lab's `quality: "sure"` (sigma = width/1080 px), conf 0 = `"approx"` (3x).
  // tracerFit maps conf linearly as px*(1+2(1-conf)), so 1 -> 1x and 0 -> 3x: the lab's rule.
  const track: TrackPoint[] = visible.map((l) => ({ frame: l.frame, x: l.x, y: l.y, conf: l.quality === 'sure' ? 1 : 0 }));
  const camera = new TracerCamera({
    fPx: cal.f_px, width: cal.width, height: cal.height, pitchDownDeg: cal.pitch_deg,
    rollDeg: cal.roll_deg, hCamM: cal.h_cam_used_m,
    fPxIsPrior: true, // lab footage carries no intrinsics — fit2's `prior` configuration
  });
  return { lab, cal, camera, track, visible, impactFrame: IMPACT_OVERRIDE[clip] ?? lab.impact_frame };
}

const pct = (a: number, b: number): string => `${((100 * (a - b)) / b).toFixed(3)} %`;
const pad = (v: number, dp: number, w = 8): string => v.toFixed(dp).padStart(w);

function main(): void {
  if (!existsSync(`${LAB}/data/labels`)) {
    console.log(`SKIP: no tracer lab at ${LAB} (set TRACER_LAB=/path/to/tracer-lab).`);
    return;
  }
  for (const clip of Object.keys(BUCKET) as Clip[]) {
    const { lab, cal, camera, track, visible, impactFrame } = loadClip(clip);
    const ref = REF[clip], tbl = REF_TABLE[clip];
    const addressPx = { x: lab.address.x, y: lab.address.y };

    // ── A. the fit alone, pixel-only, all flight frames (carry_sweep.py's `px = fit_launch(...)`)
    const t0 = Date.now();
    const r = fitLaunch({ track, camera, addressPx, impactFrame, fps: lab.fps, bucket: BUCKET[clip] });
    const ms = Date.now() - t0;
    const t0Frames = r.params.t0Sec * lab.fps - impactFrame;

    console.log(`\n═══ ${clip} — A. lib/tracerFit.fitLaunch, pixel-only, all flight frames ═══`);
    console.log(`  n points        TS ${track.length}   lab ${ref.n}   ${track.length === ref.n ? 'MATCH' : 'MISMATCH'}` +
                `   (impactFrame ${impactFrame}, ${lab.fps} fps, ${lab.width}x${lab.height}, fPx ${cal.f_px.toFixed(1)})`);
    console.log(`  --- vs experiments/fit2/results/carry_sweep_prior_all.csv (same labels) ---`);
    console.log(`  v0    m/s       TS ${pad(r.params.v0, 3)}   lab ${pad(ref.v0, 3)}   ${pct(r.params.v0, ref.v0)}`);
    console.log(`  carry m         TS ${pad(r.summary.carryM, 2)}   lab ${pad(ref.carryM, 2)}   ${pct(r.summary.carryM, ref.carryM)}`);
    console.log(`  chi2_px         TS ${pad(r.chi2Px, 3)}   lab ${pad(ref.chi2Px, 3)}   ${pct(r.chi2Px, ref.chi2Px)}`);
    console.log(`  sigma(carry) m  TS ${pad(r.summarySigma.carryM, 2)}   lab ${pad(ref.carrySigmaMc64, 2)} at mc=64 (a single noisy draw)`);
    const conv = fitLaunch({ track, camera, addressPx, impactFrame, fps: lab.fps, bucket: BUCKET[clip], mcSamples: 4096 });
    console.log(`     converged    TS ${pad(conv.summarySigma.carryM, 2)}   lab ${pad(ref.carrySigmaConverged, 2)} at mc=4096   ` +
                `${pct(conv.summarySigma.carryM, ref.carrySigmaConverged)}`);
    console.log(`  --- vs experiments/fit/report.md §2${tbl.stale ? '   (WAVE-2 ROW, superseded labels — quoted only)' : ''} ---`);
    console.log(`  theta deg  TS ${pad(r.params.thetaDeg, 2)}  lab ${pad(tbl.thetaDeg, 1)}      phi deg   TS ${pad(r.params.phiDeg, 2)}  lab ${pad(tbl.phiDeg, 1)}`);
    console.log(`  rpm_back   TS ${pad(r.params.rpmBack, 0)}  lab ${pad(tbl.rpmBack, 0)}      tilt deg  TS ${pad(r.params.tiltDeg, 2)}  lab ${pad(tbl.tiltDeg, 1)}`);
    console.log(`  t0-k_imp   TS ${pad(t0Frames, 2)}  lab ${pad(tbl.t0MinusKimpFrames, 2)}      rms px    TS ${pad(r.rmsPx, 2)}  lab ${pad(tbl.rmsPx, 2)}`);
    console.log(`  apex m     TS ${pad(r.summary.apexM, 1)}  lab ${pad(tbl.apexM, 1)}      hang s    TS ${pad(r.summary.hangS, 2)}  lab ${pad(tbl.hangS, 1)}`);
    console.log(`  sigma_total(carry) ${r.sigmaTotal.carryM.toFixed(1)} m -> label step ${r.labelStepM} m, label ${r.carryLabelM} m` +
                `   ok=${r.ok} seed=${r.seedSource} nFev=${r.nFev} ${ms} ms`);
    console.log(`  flags: ${r.flags.join(' ; ') || '(none)'}`);

    // Feed the lab's own pixel carry back in as a GPS distance: the joint fit must not fight it.
    const rj = fitLaunch({ track, camera, addressPx, impactFrame, fps: lab.fps, bucket: BUCKET[clip],
                           carryM: ref.carryM, carrySigmaGpsM: 5, carryModel: 'carry', pixelOnly: r });
    console.log(`  carry=lab pixel carry -> status=${rj.carryStatus} z=${rj.carryZ?.toFixed(2)} ` +
                `sigma_D=${rj.carrySigmaM?.toFixed(1)}m v0=${rj.params.v0.toFixed(2)} carry=${rj.summary.carryM.toFixed(1)}m`);

    // ── B. the whole app path, `traceClip`, driven from the same real track.
    // The app has no calibration file, so it derives h_cam from the ADDRESS BALL. Run it twice:
    // once with the label file's radius, once with the diameter the lab's calibration measured
    // for the SAME ball — the gap between them is the port's sensitivity to that one number.
    const detections: BallDetection[] = visible.map((l) => ({
      frame: l.frame, t: l.frame / lab.fps, x: l.x, y: l.y, r: l.r ?? 3,
      conf: l.quality === 'sure' ? 0.9 : 0.3,
    }));
    console.log(`  ─── B. lib/tracerV3.traceClip (the app's own entry point) ───`);
    for (const [tag, addressR] of [['label r', lab.address.r], ['calibration r', CAL_DIAM_PX[clip] / 2]] as const) {
      const detection: TracerDetectResultV3 = {
        found: true, method: 'blob-kalman', fps: lab.fps, width: lab.width, height: lab.height,
        impactFrameGiven: impactFrame, impactFrameUsed: impactFrame, launchFrame: detections[0].frame,
        address: { x: lab.address.x, y: lab.address.y, r: addressR },
        detections, notes: { source: 'lab-labels' }, msPerFrame: 0,
      };
      const res = traceClip({
        detection, pitchDownDeg: cal.pitch_deg, rollDeg: cal.roll_deg, fPx: cal.f_px,
        fPxSource: 'fov-metadata', renderDurationSec: (lab.last_visible_frame + 60) / lab.fps,
      });
      const m = res.meta, spec = res.spec;
      const head = `  ${tag.padEnd(14)} r=${addressR.toFixed(2)}px  decision=${res.decision}  ` +
        `hCam=${m.camera?.hCamM?.toFixed(4)}m (${pct(m.camera?.hCamM ?? 0, LAB_HCAM_M[clip])})  ` +
        `v0=${m.launch?.v0.toFixed(2)} (${pct(m.launch?.v0 ?? 0, ref.v0)})  ` +
        `carry=${m.flight?.carryM.toFixed(1)}m (${pct(m.flight?.carryM ?? 0, ref.carryM)})`;
      console.log(head);
      if (!spec) { console.log(`      spec: NONE — ${res.reason}`); continue; }
      const xs = spec.samples.map((p) => p.x), ys = spec.samples.map((p) => p.y), ts = spec.samples.map((p) => p.tSec);
      const inRange = xs.every((v) => v >= 0 && v <= 1) && ys.every((v) => v >= 0 && v <= 1);
      const monotonic = ts.every((v, i) => i === 0 || v > ts[i - 1]);
      // Landing vs horizon — the wave-5 render check, in the render's own coordinates.
      const horizonY = 1 - (cal.horizon_row_px + 0.5) / lab.height;
      const landY = ys[ys.length - 1];
      console.log(`      spec n=${spec.samples.length} tSec[0]=${ts[0]} strictly-increasing=${monotonic} ` +
        `x∈[${xs.reduce((a, b) => Math.min(a, b)).toFixed(4)},${xs.reduce((a, b) => Math.max(a, b)).toFixed(4)}] ` +
        `y∈[${ys.reduce((a, b) => Math.min(a, b)).toFixed(4)},${ys.reduce((a, b) => Math.max(a, b)).toFixed(4)}] in-range=${inRange}`);
      console.log(`      label="${spec.labelText ?? ''}" sub="${spec.labelSubText ?? ''}"  ` +
        `landing y=${landY.toFixed(4)} vs horizon ${horizonY.toFixed(4)} -> ${landY < horizonY ? 'BELOW (good)' : 'ABOVE (bad)'}`);
      console.log(`      flags: ${res.flags.join(' ; ') || '(none)'}`);
    }
  }
}

main();
