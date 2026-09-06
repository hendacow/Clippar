/**
 * Hold-out fixtures for lib/tracerFit.ts — three real clips from the tracer lab.
 *
 * WHY these numbers live here and not in the lab: the app repo must test
 * standalone (`npm run verify` runs on a fresh CI checkout that has never seen
 * ~/projects/clippar/tracer-lab). Everything below is COPIED, unmodified, from
 * the lab so the port can be checked against measured ground truth:
 *
 *   track / addressPx / fps / impactFrame  ← tracer-lab/data/labels/<CLIP>.json
 *                                            (visible labels with an x, in frame order)
 *   camera                                 ← tracer-lab/experiments/camera/calibration.json
 *                                            clips.<CLIP>.{f_px, width, height, pitch_deg,
 *                                            roll_deg, h_cam_used_m}
 *   bucket                                 ← tracer-lab/experiments/fit/common.py BUCKET
 *   impactFrame for IMG_3649               ← common.py IMPACT_OVERRIDE (430, not the
 *                                            labelled 431 — skeptic-physics §4 proved the
 *                                            ball is already airborne at 431)
 *
 * `conf` encodes the lab's two-tier label weighting, which lib/tracerFit.ts maps back to
 * a pixel sigma: conf 1 = the lab's `quality: "sure"` (sigma = width/1080 px),
 * conf 0 = `quality: "approx"` (3x that). See TRACK_SIGMA_APPROX_MULTIPLIER there.
 *
 * The reference numbers these clips are asserted against are in
 * tracer-lab/experiments/fit2/results/holdout.csv (variant `full`) and are quoted
 * next to each assertion in tests/tracerFit.test.ts.
 */
import type { Bucket } from '../../lib/tracerPhysics';
import type { CameraParams } from '../../lib/tracerCamera';
import type { TrackPoint } from '../../lib/tracerFit';

export interface ClipFixture {
  clip: string;
  bucket: Bucket;
  fps: number;
  /** Ball at address in this frame, displaced in the next one (the lab's convention). */
  impactFrame: number;
  addressPx: { x: number; y: number };
  camera: CameraParams;
  /** Visible labelled flight frames, top-left pixels of the display-oriented frame. */
  track: TrackPoint[];
}

export const CLIP_FIXTURES: ClipFixture[] = [
  {
    clip: 'IMG_3631',
    bucket: 'driver',
    fps: 60.0,
    impactFrame: 425,
    addressPx: { x: 736.7, y: 2808.7 },
    camera: {
      fPx: 3008.458516,
      width: 2160,
      height: 3840,
      pitchDownDeg: -2.99672133,
      rollDeg: -0.5,
      hCamM: 1.10404349,
      fPxIsPrior: true,
    },
    track: [
      { frame: 426, x: 707.7, y: 2601.2, conf: 1 },
      { frame: 427, x: 677.8, y: 2386.0, conf: 1 },
      { frame: 428, x: 656.2, y: 2237.4, conf: 1 },
      { frame: 429, x: 640.1, y: 2128.9, conf: 1 },
      { frame: 430, x: 629.0, y: 2045.3, conf: 1 },
      { frame: 431, x: 620.1, y: 1982.8, conf: 1 },
      { frame: 432, x: 610.7, y: 1928.6, conf: 1 },
      { frame: 433, x: 603.1, y: 1883.8, conf: 1 },
      { frame: 434, x: 596.4, y: 1845.5, conf: 1 },
      { frame: 435, x: 591.2, y: 1813.0, conf: 1 },
      { frame: 436, x: 586.7, y: 1785.1, conf: 1 },
      { frame: 437, x: 582.5, y: 1760.2, conf: 1 },
      { frame: 438, x: 578.4, y: 1737.7, conf: 1 },
      { frame: 439, x: 575.3, y: 1717.8, conf: 1 },
      { frame: 440, x: 571.8, y: 1700.0, conf: 1 },
      { frame: 441, x: 568.6, y: 1683.5, conf: 1 },
      { frame: 442, x: 565.7, y: 1668.7, conf: 1 },
      { frame: 443, x: 563.0, y: 1655.5, conf: 1 },
      { frame: 444, x: 560.7, y: 1642.9, conf: 1 },
      { frame: 445, x: 558.3, y: 1631.0, conf: 1 },
      { frame: 446, x: 556.4, y: 1620.9, conf: 1 },
      { frame: 447, x: 554.1, y: 1610.5, conf: 1 },
      { frame: 448, x: 551.5, y: 1601.2, conf: 1 },
      { frame: 449, x: 550.0, y: 1592.5, conf: 1 },
      { frame: 450, x: 548.1, y: 1584.4, conf: 1 },
      { frame: 451, x: 546.1, y: 1576.7, conf: 1 },
      { frame: 452, x: 544.9, y: 1569.5, conf: 1 },
      { frame: 453, x: 543.3, y: 1562.9, conf: 1 },
      { frame: 454, x: 541.5, y: 1556.4, conf: 1 },
      { frame: 455, x: 539.9, y: 1550.3, conf: 1 },
      { frame: 456, x: 538.3, y: 1543.9, conf: 1 },
      { frame: 457, x: 536.9, y: 1538.4, conf: 1 },
      { frame: 458, x: 535.2, y: 1532.8, conf: 0 },
      { frame: 459, x: 534.2, y: 1527.6, conf: 0 },
      { frame: 460, x: 532.5, y: 1522.9, conf: 0 },
      { frame: 461, x: 531.2, y: 1518.2, conf: 0 },
      { frame: 462, x: 529.2, y: 1513.1, conf: 0 },
      { frame: 465, x: 526.4, y: 1500.4, conf: 0 },
      { frame: 466, x: 524.6, y: 1496.6, conf: 0 },
    ],
  },
  {
    clip: 'IMG_3649',
    bucket: 'driver',
    fps: 60.0,
    impactFrame: 430,
    addressPx: { x: 642.3, y: 2749.0 },
    camera: {
      fPx: 3008.458516,
      width: 2160,
      height: 3840,
      pitchDownDeg: -2.86386943,
      rollDeg: 0.0,
      hCamM: 1.25810176,
      fPxIsPrior: true,
    },
    track: [
      { frame: 431, x: 669.0, y: 2698.0, conf: 0 },
      { frame: 432, x: 750.0, y: 2513.7, conf: 1 },
      { frame: 433, x: 799.1, y: 2395.2, conf: 1 },
      { frame: 434, x: 841.8, y: 2298.8, conf: 1 },
      { frame: 435, x: 869.0, y: 2228.1, conf: 1 },
      { frame: 436, x: 894.6, y: 2169.9, conf: 1 },
      { frame: 437, x: 916.2, y: 2119.9, conf: 1 },
      { frame: 438, x: 933.0, y: 2082.0, conf: 1 },
      { frame: 439, x: 943.6, y: 2052.8, conf: 1 },
      { frame: 440, x: 955.4, y: 2024.4, conf: 1 },
      { frame: 441, x: 965.9, y: 1999.8, conf: 1 },
      { frame: 442, x: 974.5, y: 1978.8, conf: 1 },
      { frame: 443, x: 983.0, y: 1959.4, conf: 1 },
      { frame: 444, x: 989.3, y: 1942.9, conf: 1 },
      { frame: 445, x: 995.3, y: 1927.5, conf: 1 },
      { frame: 446, x: 1000.9, y: 1913.9, conf: 1 },
      { frame: 447, x: 1006.1, y: 1901.4, conf: 1 },
      { frame: 448, x: 1010.5, y: 1890.6, conf: 1 },
      { frame: 449, x: 1014.8, y: 1880.3, conf: 0 },
      { frame: 450, x: 1018.5, y: 1870.2, conf: 0 },
      { frame: 451, x: 1022.3, y: 1862.4, conf: 0 },
      { frame: 452, x: 1025.5, y: 1854.1, conf: 0 },
      { frame: 453, x: 1028.4, y: 1846.3, conf: 0 },
      { frame: 454, x: 1031.5, y: 1839.0, conf: 0 },
      { frame: 456, x: 1036.5, y: 1826.2, conf: 0 },
      { frame: 459, x: 1045.4, y: 1809.5, conf: 0 },
      { frame: 460, x: 1047.0, y: 1805.1, conf: 0 },
    ],
  },
  {
    clip: 'IMG_3632',
    bucket: 'wedge',
    fps: 30.0,
    impactFrame: 213,
    addressPx: { x: 356.9, y: 1243.5 },
    camera: {
      fPx: 1504.229258,
      width: 1080,
      height: 1920,
      pitchDownDeg: 3.36705516,
      rollDeg: -0.14,
      hCamM: 1.26778308,
      fPxIsPrior: true,
    },
    track: [
      { frame: 214, x: 373.3, y: 1061.8, conf: 0 },
      { frame: 215, x: 384.7, y: 949.2, conf: 1 },
      { frame: 216, x: 392.1, y: 874.7, conf: 1 },
      { frame: 217, x: 398.7, y: 822.2, conf: 1 },
      { frame: 218, x: 405.4, y: 783.9, conf: 1 },
      { frame: 219, x: 409.7, y: 753.5, conf: 1 },
      { frame: 220, x: 412.0, y: 727.8, conf: 1 },
      { frame: 221, x: 415.8, y: 707.7, conf: 1 },
      { frame: 222, x: 421.2, y: 691.5, conf: 0 },
      { frame: 223, x: 424.7, y: 677.4, conf: 0 },
      { frame: 224, x: 426.4, y: 663.9, conf: 0 },
      { frame: 225, x: 429.5, y: 653.5, conf: 0 },
      { frame: 226, x: 432.6, y: 643.8, conf: 0 },
      { frame: 228, x: 438.3, y: 628.3, conf: 0 },
      { frame: 229, x: 441.0, y: 621.5, conf: 0 },
    ],
  },];

export function clipFixture(clip: string): ClipFixture {
  const f = CLIP_FIXTURES.find((c) => c.clip === clip);
  if (!f) throw new Error(`no fixture for ${clip}`);
  return f;
}
