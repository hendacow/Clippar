/**
 * horizon.ts — where does the DRAWN arc actually end, relative to the horizon?
 *
 *   node --import tsx docs/tracer-v3/bench/horizon.ts <jobs.json>
 *
 * Henry, 5 Sep: *"it needs to land on the horizon in relation to how far the ball
 * was hit"*. `traceClip` already computes exactly that on every clip it draws —
 * `meta.landingCheck`, from `landingHorizonCheck` — but nothing had ever read it
 * over the corpus, so nobody knew whether the requirement was met.
 *
 * A landing ABOVE the horizon is geometrically impossible for a ball coming down
 * on the camera's ground plane, so `aboveHorizon` is a bug flag, not a measurement.
 * `depressionPx1080` is how far BELOW the horizon the drawn end sits, in 1080p-
 * equivalent pixels: 0 means exactly on it.
 *
 * Same imported-clip conditions as ladder.ts. Nothing in the app imports this.
 */
import { readFileSync } from 'node:fs';
import { traceClip, fPxFromLandscapeFov } from '../../../lib/tracerV3';
import { config } from '../../../constants/config';

interface Job { id: string; det: string; dur: number; corpus: string; class: string; res: string }
const jobs: Job[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out: Record<string, unknown>[] = [];

for (const j of jobs) {
  const det = JSON.parse(readFileSync(j.det, 'utf8'));
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
    shotType: 'swing',
    renderDurationSec: j.dur,
    detectToRenderOffsetSec: 0,
  });
  const lc = (r.meta as { landingCheck?: Record<string, unknown> }).landingCheck;
  const fl = (r.meta as { flight?: { carryM: number; apexM: number; hangS: number } }).flight;
  out.push({
    id: j.id, corpus: j.corpus, class: j.class, res: j.res, height: H,
    drew: r.spec !== null,
    horizonRow: lc?.horizonRow ?? null,
    landingPx: lc?.landingPx ?? null,
    depressionPx1080: lc?.depressionPx1080 ?? null,
    aboveHorizon: lc?.aboveHorizon ?? null,
    carryM: fl?.carryM ?? null,
    apexM: fl?.apexM ?? null,
    hangS: fl?.hangS ?? null,
    residualVsRangePx1080: lc?.residualVsRangePx1080 ?? null,
    flags: r.flags.filter((f) => f.startsWith('landing') || f.startsWith('arc_end')),
  });
}
process.stdout.write(JSON.stringify(out));
