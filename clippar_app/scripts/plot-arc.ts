/**
 * plot-arc.ts — device-free visual check of the tracer arc geometry.
 *
 *   npx tsx scripts/plot-arc.ts
 *
 * Renders v1 (lib/tracerMath.buildArcSpec, BLUE) vs v2 (lib/tracerV2.
 * buildArcSpecV2, RED) for a set of scenarios, with the horizon line, into PNGs
 * via ImageMagick `magick -draw "polyline ..."` (ImageMagick's SVG renderer
 * silently drops <polyline>, so we draw imperatively). Prints an apex-y table.
 *
 * Coords are normalized, bottom-left origin, y-up — image y is flipped on draw.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  buildArcSpec,
  isTracerSkip,
  computeHorizonY,
  portraitHFovDeg,
  projectLanding,
} from '../lib/tracerMath';
import { computeShotCarry, buildArcSpecV2, type ShotFix } from '../lib/tracerV2';
import { config } from '../constants/config';

const R = 6371000;
const DEG = Math.PI / 180;
function destination(lat: number, lon: number, bearingDeg: number, distM: number) {
  const d = distM / R, th = bearingDeg * DEG, f1 = lat * DEG, l1 = lon * DEG;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lat: f2 / DEG, lon: l2 / DEG };
}
function quad(p0: any, c: any, p1: any, n: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y });
  }
  return out;
}

const TEE = { lat: -27.44463, lon: 153.01504 };
const HEADING = 270;
const PITCH = 5, HFOVL = 62;
const scenarios = [
  { name: 'straight-60m', bearing: 270, carry: 60 },
  { name: 'straight-100m', bearing: 270, carry: 100 },
  { name: 'straight-140m', bearing: 270, carry: 140 },
  { name: 'straight-200m', bearing: 270, carry: 200 },
  { name: 'right-25deg-120m', bearing: 295, carry: 120 },
  { name: 'left-25deg-120m', bearing: 245, carry: 120 },
];

const W = 480, H = 854; // 9:16-ish canvas
const OUT_DIR = '/tmp/tracer-arc-plots';
mkdirSync(OUT_DIR, { recursive: true });

const toImg = (p: { x: number; y: number }) => `${(p.x * W).toFixed(1)},${((1 - p.y) * H).toFixed(1)}`;
function polylineDraw(pts: { x: number; y: number }[], color: string, width: number) {
  return ['-stroke', color, '-strokewidth', String(width), '-fill', 'none', '-draw', `polyline ${pts.map(toImg).join(' ')}`];
}

const rows: string[] = [];
rows.push('scenario            | v1 apexY | v2 apexY | horizonY | v2 launchY | v2 landY');
rows.push('--------------------|----------|----------|----------|------------|---------');
const pngPaths: string[] = [];

for (const s of scenarios) {
  const landing = destination(TEE.lat, TEE.lon, s.bearing, s.carry);
  // v1
  const v1 = buildArcSpec({
    latN: TEE.lat, lonN: TEE.lon, latN1: landing.lat, lonN1: landing.lon,
    gpsAccuracyMN: 6, gpsAccuracyMN1: 6, cameraHeadingDeg: HEADING,
    cameraHeadingCalibration: 3, cameraPitchDownDeg: PITCH, hFovLandscapeDeg: HFOVL,
    clipDurationSec: 9, impactTimeMs: 2500, autoTrimStartMs: 0, detection: null,
  } as any);
  // v2 (prior-driven, GPS-backbone straight shot — the case that read flat)
  const vFovP = HFOVL, hFovP = portraitHFovDeg(HFOVL);
  const horizonY = computeHorizonY(PITCH, vFovP);
  const camH = config.tracer.v2.bagMountHeightM;
  const carry = computeShotCarry(
    { lat: TEE.lat, lon: TEE.lon, effAccM: 3 } as ShotFix,
    { lat: landing.lat, lon: landing.lon, effAccM: 3 } as ShotFix,
    HEADING, { headingCalibration: 3 } as any,
  );
  const landingPx = projectLanding({ deltaDeg: carry.deltaDeg ?? 0, carryM: carry.carryM, horizonY, hFovPortraitDeg: hFovP, vFovPortraitDeg: vFovP, tripodHeightM: camH } as any);
  const v2 = buildArcSpecV2({
    fit: { degenerate: true, reason: 'D2', points: [] } as any, carry, landing: landingPx,
    horizonY, vFovPortraitDeg: vFovP, camHeightM: camH, animStartSec: 2.55, maxAnimSec: 6.0,
    poseAnchor: { x: 0.5, y: 0.2 }, detectedDirection: null, rollDeg: 0,
  });

  const v2pts = v2.samples.map((p) => ({ x: p.x, y: p.y }));
  const v2apexY = Math.max(...v2pts.map((p) => p.y));
  let v1pts: { x: number; y: number }[] = [];
  let v1apexY = NaN;
  if (!isTracerSkip(v1)) {
    const sp: any = (v1 as any).spec;
    v1pts = [...quad(sp.p0, sp.c1, sp.a, 40), ...quad(sp.a, sp.c2, sp.p3, 40)];
    v1apexY = Math.max(...v1pts.map((p) => p.y));
  }
  rows.push(
    `${s.name.padEnd(19)} | ${v1apexY.toFixed(3).padStart(8)} | ${v2apexY.toFixed(3).padStart(8)} | ${horizonY.toFixed(3).padStart(8)} | ${v2pts[0].y.toFixed(3).padStart(10)} | ${landingPx.y.toFixed(3)}`,
  );

  // Render PNG: black bg, green horizon line, v1 blue, v2 red.
  const hy = ((1 - horizonY) * H).toFixed(1);
  const args = [
    '-size', `${W}x${H}`, 'xc:#07100a',
    '-stroke', '#5a7', '-strokewidth', '1', '-draw', `line 0,${hy} ${W},${hy}`,
    ...(v1pts.length ? polylineDraw(v1pts, '#4aa3ff', 3) : []),
    ...polylineDraw(v2pts, '#ff3b1f', 3),
    // launch + landing dots for v2
    '-fill', '#ffd9a0', '-stroke', 'none', '-draw', `circle ${v2pts[0].x * W},${(1 - v2pts[0].y) * H} ${v2pts[0].x * W + 5},${(1 - v2pts[0].y) * H}`,
    '-draw', `circle ${landingPx.x * W},${(1 - landingPx.y) * H} ${landingPx.x * W + 5},${(1 - landingPx.y) * H}`,
    `${OUT_DIR}/${s.name}.png`,
  ];
  execFileSync('magick', args);
  pngPaths.push(`${OUT_DIR}/${s.name}.png`);
}

// Combine into one 3x2 comparison image (v1=blue, v2=red, horizon=green) using
// append (no montage labels → no font dependency).
const montage = `${OUT_DIR}/_montage.png`;
const row1 = `${OUT_DIR}/_row1.png`, row2 = `${OUT_DIR}/_row2.png`;
execFileSync('magick', [...pngPaths.slice(0, 3), '+append', row1]);
execFileSync('magick', [...pngPaths.slice(3, 6), '+append', row2]);
execFileSync('magick', [row1, row2, '-append', montage]);

console.log('\n' + rows.join('\n'));
console.log(`\nPNGs: ${OUT_DIR}/  (montage: ${montage})`);
