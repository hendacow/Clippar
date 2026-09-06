/**
 * End-to-end bench: the REAL native detector's output (captured on macOS by the
 * harness around the shipped Swift) through the REAL ladder, exactly as the app
 * runs it. Answers "would this clip have drawn an arc, and if not, why".
 *
 *   node --import tsx docs/tracer-v3/e2eHarness.ts <detection.json> <label> [pitchDeg]
 *
 * Not part of the app; nothing imports it. It exists so a field failure can be
 * reproduced on this machine in seconds instead of by rebuilding and re-shooting.
 */
import { readFileSync } from 'node:fs';
import { traceClip, fPxFromLandscapeFov } from '../../lib/tracerV3';
import { config } from '../../constants/config';

const [file, label, pitchArg] = process.argv.slice(2);
const det = JSON.parse(readFileSync(file, 'utf8'));
const W = det.width || 1080;
const H = det.height || 1920;

const r = traceClip({
  detection: det,
  // '' means UNKNOWN (an import). Number('') is 0, which would read as a measured
  // level camera and silently disable the assumed-pitch path this bench exists to test.
  pitchDownDeg: pitchArg !== undefined && pitchArg !== '' ? Number(pitchArg) : null,
  fPx: fPxFromLandscapeFov(config.tracer.cameraHFovLandscapeDeg, W, H),
  fPxSource: 'fov-metadata',
  capture: { lens: null, zoom: null },          // an import: geometry unknown
  allowUnknownGeometry: config.tracer.v3.traceUnknownGeometry,
  assumedPitchDownDeg: config.tracer.v3.assumedPitchDownDeg,
  carryM: null,
  carrySigmaGpsM: null,
  shotType: null,
  renderDurationSec: Number(process.argv[5] ?? 12),
});

const m = r.meta;
const pill = r.spec ? `${r.spec.labelText} / ${r.spec.labelSubText}` : '—';
console.log(
  JSON.stringify({
    label,
    drew: r.spec !== null,
    decision: r.decision,
    reason: m.reason ?? null,
    K: m.selection?.k ?? 0,
    nDet: (det.detections ?? []).length,
    rmsPx: m.fit?.rmsPx ?? null,
    flags: (m.flags ?? []).slice(0, 6).join(' '),
    pill,
  })
);
