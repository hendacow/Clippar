/**
 * specDump.ts — emit the REAL render spec `traceClip` produces, so the native
 * renderer can be run on it. Same imported-clip conditions as ladder.ts.
 *
 *   node --import tsx docs/tracer-v3/bench/specDump.ts <det.json> <renderDurationSec> [shotType]
 *
 * Writes the spec (or `null`) as JSON on stdout. Nothing in the app imports this.
 */
import { readFileSync } from 'node:fs';
import { traceClip, fPxFromLandscapeFov } from '../../../lib/tracerV3';
import { config } from '../../../constants/config';

const det = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const renderDurationSec = Number(process.argv[3] || 0);
const shotType = (process.argv[4] as 'swing' | 'putt' | null) || 'swing';
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
  shotType,
  renderDurationSec,
  detectToRenderOffsetSec: 0,
});
process.stdout.write(JSON.stringify({ spec: r.spec, decision: r.decision, reason: r.reason ?? null }));
