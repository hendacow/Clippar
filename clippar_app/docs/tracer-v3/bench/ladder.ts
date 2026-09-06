/**
 * ladder.ts — the REAL ladder (`lib/tracerV3.traceClip`), driven over a whole
 * batch of detector outputs in ONE node process.
 *
 *   node --import tsx docs/tracer-v3/bench/ladder.ts <jobs.json> > <out.json>
 *
 * `jobs.json` is an array of:
 *   { id, detFile, renderDurationSec, detectToRenderOffsetSec, shotType }
 *
 * IMPORTED-CLIP CONDITIONS, and each one is read out of the app rather than
 * chosen here (hooks/useEditorState.ts, the tracer batch, ~line 1560):
 *   pitchDownDeg          null   — an import carries no CoreMotion pitch
 *   capture.lens / .zoom  null   — the columns did not exist; forces
 *                                  geometry_unknown, so no distance is ever stated
 *   carryM / carrySigma   null   — no GPS carried on an import
 *   fPx                   fPxFromLandscapeFov(config.tracer.cameraHFovLandscapeDeg)
 *   allowUnknownGeometry  config.tracer.v3.traceUnknownGeometry
 *   assumedPitchDownDeg   config.tracer.v3.assumedPitchDownDeg
 *   shotType              WHAT THE APP'S OWN CLASSIFIER SAID — not the human
 *                         label. The app never sees the human label, so neither
 *                         does the bench.
 *
 * Nothing in the app imports this file.
 */
import { readFileSync } from 'node:fs';
import { traceClip, fPxFromLandscapeFov } from '../../../lib/tracerV3';
import { config } from '../../../constants/config';

interface Job {
  id: string;
  detFile: string;
  renderDurationSec: number;
  detectToRenderOffsetSec: number;
  shotType: 'swing' | 'putt' | null;
}

const jobs: Job[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out: unknown[] = [];

for (const j of jobs) {
  const t0 = Date.now();
  let row: Record<string, unknown>;
  try {
    const det = JSON.parse(readFileSync(j.detFile, 'utf8'));
    const W = det.width || 1080;
    const H = det.height || 1920;
    const r = traceClip({
      detection: det,
      pitchDownDeg: null,
      fPx: fPxFromLandscapeFov(config.tracer.cameraHFovLandscapeDeg, W, H),
      fPxSource: 'fov-metadata',
      capture: { lens: null, zoom: null },
      allowUnknownGeometry: config.tracer.v3.traceUnknownGeometry,
      assumedPitchDownDeg: config.tracer.v3.assumedPitchDownDeg,
      carryM: null,
      carrySigmaGpsM: null,
      shotType: j.shotType,
      renderDurationSec: j.renderDurationSec,
      detectToRenderOffsetSec: j.detectToRenderOffsetSec,
    });
    const m = r.meta;
    row = {
      id: j.id,
      drew: r.spec !== null,
      decision: r.decision,
      reason: r.reason ?? null,
      flags: m.flags ?? [],
      K: m.selection?.k ?? 0,
      nDet: (det.detections ?? []).length,
      rmsPx: m.fit?.rmsPx ?? null,
      detReason: det?.notes?.reason ?? null,
      detAddressPath: det?.notes?.address_path ?? null,
      pill: r.spec ? `${r.spec.labelText} / ${r.spec.labelSubText}` : null,
      ladderMs: Date.now() - t0,
    };
  } catch (e) {
    row = { id: j.id, drew: false, decision: 'error', reason: `ladder threw: ${e}`,
            flags: [], K: 0, nDet: 0, rmsPx: null, pill: null, ladderMs: Date.now() - t0 };
  }
  out.push(row);
}

process.stdout.write(JSON.stringify(out));
