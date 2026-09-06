/**
 * verifyLadder.ts — bench/ladder.ts plus the RENDER WINDOW, which ladder.ts does
 * not record. Written by the `verify` agent because the one thing the window
 * scan can newly break is the relationship between where the detector found the
 * ball and the four seconds the app is going to render, and that relationship is
 * invisible in a row that only says `drew: true`.
 *
 *   node --import tsx docs/tracer-v3/bench/verifyLadder.ts <jobs.json>
 *
 * Same jobs.json and same imported-clip conditions as ladder.ts. Nothing in the
 * app imports this file.
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
    const s = r.spec;
    row = {
      id: j.id,
      drew: s !== null,
      decision: r.decision,
      reason: r.reason ?? null,
      renderDurationSec: j.renderDurationSec,
      detectToRenderOffsetSec: j.detectToRenderOffsetSec,
      animStartSec: s?.animStartSec ?? null,
      animDurationSec: s?.animDurationSec ?? null,
      freezeCompleteToSec: (s as { freezeCompleteToSec?: number } | null)?.freezeCompleteToSec ?? null,
      // The number this file exists for: how much of the drawn animation lands
      // AFTER the source footage has run out and is therefore painted over a
      // held still frame.
      startsAfterFootageBy: s ? +(s.animStartSec - j.renderDurationSec).toFixed(3) : null,
      endsAfterFootageBy: s
        ? +(s.animStartSec + s.animDurationSec - j.renderDurationSec).toFixed(3) : null,
      impactDerivedMs: det?.notes?.impactDerivedMs ?? null,
      impactGivenMs: det?.notes?.impactGivenMs ?? null,
      impactShiftMs: det?.notes?.impactShiftMs ?? null,
      impactSourceNote: det?.notes?.impactSource ?? null,
      impactTriesUsed: det?.notes?.impactTriesUsed ?? null,
      nDet: (det.detections ?? []).length,
      firstDetSec: (det.detections ?? [])[0]?.t ?? null,
      lastDetSec: (det.detections ?? []).slice(-1)[0]?.t ?? null,
      pill: s ? `${s.labelText} / ${s.labelSubText}` : null,
    };
  } catch (e) {
    row = { id: j.id, drew: false, decision: 'error', reason: `ladder threw: ${e}` };
  }
  out.push(row);
}

process.stdout.write(JSON.stringify(out));
