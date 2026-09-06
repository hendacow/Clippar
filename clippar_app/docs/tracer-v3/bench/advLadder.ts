/**
 * advLadder.ts — the REAL ladder over ADVERSARIAL inputs, with `forceTrace`
 * both OFF and ON, in one node process.
 *
 *   node --import tsx docs/tracer-v3/bench/advLadder.ts <jobs.json>
 *
 * Same imported-clip conditions as bench/ladder.ts (no pitch, no lens, no GPS),
 * because that is what a clip picked out of the camera roll actually carries.
 * The only difference is that each job is run twice: once as shipped, once with
 * the dev bypass on, because a refusal that `forceTrace` can walk through is a
 * refusal only until someone leaves the switch on.
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
  for (const force of [false, true]) {
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
        knobs: force ? { forceTrace: true } : undefined,
      });
      row = {
        id: j.id,
        forceTrace: force,
        drew: r.spec !== null,
        decision: r.decision,
        reason: r.reason ?? null,
        flags: r.meta.flags ?? [],
        K: r.meta.selection?.k ?? 0,
        nDet: (det.detections ?? []).length,
        rmsPx: r.meta.fit?.rmsPx ?? null,
        detReason: det?.notes?.reason ?? null,
        detAddressPath: det?.notes?.address_path ?? null,
        impactDerivedMs: det?.notes?.impactDerivedMs ?? null,
        impactShiftMs: det?.notes?.impactShiftMs ?? null,
        impactSourceNote: det?.notes?.impactSource ?? null,
        pill: r.spec ? `${r.spec.labelText} / ${r.spec.labelSubText}` : null,
        ladderMs: Date.now() - t0,
      };
    } catch (e) {
      row = { id: j.id, forceTrace: force, drew: false, decision: 'error',
              reason: `ladder threw: ${e}`, flags: [], K: 0, nDet: 0, rmsPx: null,
              pill: null, ladderMs: Date.now() - t0 };
    }
    out.push(row);
  }
}

process.stdout.write(JSON.stringify(out));
