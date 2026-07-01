/**
 * lib/gpsSession.ts — Tracer V2 GPS backbone (Pillar 1). PURE TS, ZERO native
 * deps, fully unit-testable. hooks/useGpsSession.ts feeds this from
 * watchPositionAsync; the estimator turns a rolling ring of raw fixes into a
 * per-shot position + honest effective accuracy.
 *
 * Root cause of v1's failure: a single getCurrentPositionAsync at recording
 * STOP that routinely returned a stale/cached WiFi-anchored fix. v2 keeps a
 * continuous ring and estimates over the stationary window, with a hard
 * staleness rule that returns null rather than ever handing back a cached fix.
 *
 * ── AMENDMENT A1 (mandatory) ──────────────────────────────────────────────
 * The anchor is IMPACT TIME, never the start press. The golfer presses start
 * AT THE BAG, then walks 5–20s+ to the ball. Anchoring at the start press can
 * median onto the previous filming spot 50–150m away. So estimateShotFix takes
 * an arbitrary ABSOLUTE anchorTs: the definitive anchor is
 * `recording_start_ts + impact_time_ms`; the fallback anchor is recording STOP.
 * Both use the same stationary window (pre-heavy: setup dwell before impact,
 * tight post to avoid the walk-away) — only the ANCHOR differs. The raw fix
 * series is persisted so the fix can be re-derived at impact time after
 * detectAndTrim lands (GPS_ESTIMATOR_VERSION gates re-processing).
 *
 * Window/threshold constants come from `config.tracer.gps` (owned by the
 * scaffold). Estimator-internal constants that the scaffold does not expose
 * (ring horizon, decorrelation time, series cap, widen step) live here.
 */
import { config } from '../constants/config';

// ── estimator-internal constants (not tunable via config.tracer.gps) ────────
const RING_SEC = 180; // ring buffer horizon (task S2 spec)
const DECORREL_SEC = 15; // multipath decorrelates on ~15s, not per-fix (plan §2)
const SERIES_CAP_N = 60; // persist at most this many raw fixes per shot (S4)
const WIDEN_STEP_SEC = 10; // grow the pre-window by this each widen pass

/** Bump when the estimator math changes so persisted fixes can be re-derived. */
export const GPS_ESTIMATOR_VERSION = 1;

/**
 * The slice of `config.tracer.gps` this estimator consumes. A structural
 * subset, so `new GpsSession(config.tracer.gps)` type-checks (the full config
 * object carries extra fields Lane B uses — tier2RelSigma, filmSpotOffsetVarM).
 */
export interface GpsConfig {
  warmupSec: number;
  windowPreSec: number; // stationary window before the anchor
  windowPostSec: number; // stationary window after the anchor (tight: walk-away)
  widenPreSec: number; // widen the pre-window up to this when too few fixes
  stationarySpeedMax: number; // m/s — above this the golfer is walking
  fixAccMax: number; // m — drop fixes reporting worse horizontalAccuracy
  minFixes: number; // widen below this many accepted fixes
  effAccFloor: number; // m — honest precision ceiling
  safetyFactor: number; // iOS accuracy is optimistic
  staleSec: number; // no fix within this of the anchor → gps-stale
  tier1EffAccM: number; // health chip green threshold
  tier2EffAccM: number; // health chip yellow threshold
}

/**
 * Test-stable mirror of the current `config.tracer.gps` values. The app
 * singleton uses the live config; tests construct GpsSession with this so
 * assertions don't move if Lane B/scaffold retunes config. Keep in sync.
 */
export const DEFAULT_GPS_CONFIG: GpsConfig = {
  warmupSec: 15,
  windowPreSec: 25,
  windowPostSec: 3,
  widenPreSec: 45,
  stationarySpeedMax: 0.7,
  fixAccMax: 20,
  minFixes: 5,
  effAccFloor: 2.5,
  safetyFactor: 1.2,
  staleSec: 10,
  tier1EffAccM: 5,
  tier2EffAccM: 10,
};

// ── types ─────────────────────────────────────────────────────────────────
export interface RawFix {
  ts: number; // absolute ms (Date.now / CLLocation.timestamp)
  lat: number;
  lon: number;
  acc: number; // horizontal accuracy radius, m
  speed: number; // m/s (<0 when unknown → treated as unknown, not stationary)
  course: number; // degrees, course-over-ground (persisted; unused by estimator)
}

export type GpsFixSource = 'impact' | 'stop-fallback' | 'widened';

export interface ShotFix {
  lat: number;
  lon: number;
  effAccM: number;
  fixCount: number;
  windowSec: number;
  medianAccM: number;
  source: GpsFixSource;
  estimatorVersion: number;
}

export type ShotFixResult =
  | { fix: ShotFix; reason: null }
  | { fix: null; reason: 'gps-stale' | 'no-fix' };

export type GpsHealthState = 'green' | 'yellow' | 'red' | 'locking';

export interface GpsHealth {
  effAccM: number | null;
  state: GpsHealthState;
  fixCount: number;
}

export interface EstimateOpts {
  /** Override the pre-window (rarely needed; both anchors share the default). */
  preSec?: number;
  postSec?: number;
  /** Label the source when the caller knows it (impact vs stop-fallback). */
  source?: GpsFixSource;
}

// ── pure math helpers (exported for direct unit tests) ──────────────────────

/** Plain median of a numeric array (0 for empty). */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Accuracy-weighted median (weight = 1/acc²) of (value, acc) samples. Robust to
 * a single wild outlier the way a weighted mean is not — a 40m-off fix with acc
 * 18 carries weight 1/324 vs 1/9 for a 3m fix, so it sits at the tail of the
 * sorted order and never crosses the half-weight mark.
 */
export function weightedMedian(samples: { value: number; acc: number }[]): number {
  if (samples.length === 0) return 0;
  const weighted = samples.map((s) => ({ v: s.value, w: 1 / (s.acc * s.acc) }));
  weighted.sort((a, b) => a.v - b.v);
  const total = weighted.reduce((sum, x) => sum + x.w, 0);
  let cum = 0;
  for (const x of weighted) {
    cum += x.w;
    if (cum >= total / 2) return x.v;
  }
  return weighted[weighted.length - 1].v;
}

/**
 * effAcc = max(floor, median(acc) / √(min(N, windowSec/DECORREL_SEC))) ×
 * safetyFactor. Multipath decorrelates on ~DECORREL_SEC (not per-fix), so the
 * independent-sample count is the window span / DECORREL_SEC, capped by N. iOS
 * horizontalAccuracy is optimistic, hence the safety factor.
 */
export function computeEffAcc(
  medianAccM: number,
  n: number,
  windowSec: number,
  cfg: GpsConfig = DEFAULT_GPS_CONFIG
): number {
  const indep = Math.max(1, Math.min(n, windowSec / DECORREL_SEC));
  const raw = medianAccM / Math.sqrt(indep);
  return Math.max(cfg.effAccFloor, raw) * cfg.safetyFactor;
}

// ── session ─────────────────────────────────────────────────────────────────

export class GpsSession {
  private buf: RawFix[] = [];
  private warmupUntilTs = 0;
  readonly cfg: GpsConfig;

  constructor(cfg: GpsConfig = DEFAULT_GPS_CONFIG) {
    this.cfg = cfg;
  }

  /** Push a fix; evict anything older than RING_SEC relative to the newest. */
  addFix(f: RawFix): void {
    this.buf.push(f);
    const cutoff = f.ts - RING_SEC * 1000;
    if (this.buf.length > 1 && this.buf[0].ts < cutoff) {
      this.buf = this.buf.filter((x) => x.ts >= cutoff);
    }
  }

  /** Start of session / AppState resume: exclude the next warmupSec as junk. */
  markWarmup(nowTs: number): void {
    this.warmupUntilTs = nowTs + this.cfg.warmupSec * 1000;
  }

  reset(): void {
    this.buf = [];
    this.warmupUntilTs = 0;
  }

  /** Test/inspection helper. */
  size(): number {
    return this.buf.length;
  }

  private isWarm(ts: number): boolean {
    return ts >= this.warmupUntilTs;
  }

  private isStationary(f: RawFix): boolean {
    // speed < 0 means "unknown" from CoreLocation — don't assume stationary.
    return f.speed >= 0 && f.speed <= this.cfg.stationarySpeedMax && f.acc <= this.cfg.fixAccMax;
  }

  /**
   * Raw fixes bracketing an anchor (post-warmup only), nearest-first, capped at
   * SERIES_CAP_N. Persisted per clip (gps_fix_series) so the fix can be
   * re-derived later (A1) with a newer estimator without re-recording. Returns
   * the widest window we'd ever consider, UNFILTERED by stationarity, so a
   * future estimator can re-apply its own gates.
   */
  seriesAround(anchorTs: number, opts: EstimateOpts = {}): RawFix[] {
    const preSec = opts.preSec ?? this.cfg.widenPreSec;
    const postSec = opts.postSec ?? this.cfg.windowPostSec;
    const lo = anchorTs - preSec * 1000;
    const hi = anchorTs + postSec * 1000;
    return this.buf
      .filter((f) => this.isWarm(f.ts) && f.ts >= lo && f.ts <= hi)
      .sort((a, b) => Math.abs(a.ts - anchorTs) - Math.abs(b.ts - anchorTs))
      .slice(0, SERIES_CAP_N);
  }

  /**
   * Estimate the shot position at `anchorTs` (A1: IMPACT time, or the stop
   * fallback). Accuracy-weighted median over the stationary window, widening
   * the pre-window toward widenPreSec until it holds ≥ minFixes. Hard
   * staleness: if the ring has no fix within staleSec of the anchor, returns
   * gps-stale — NEVER a cached fix.
   */
  estimateShotFix(anchorTs: number, opts: EstimateOpts = {}): ShotFixResult {
    if (this.buf.length === 0) return { fix: null, reason: 'gps-stale' };

    // Hard staleness: the closest fix to the anchor must be within staleSec. If
    // GPS froze before the shot, every fix predates the anchor by >staleSec and
    // we refuse to coast on a cached position.
    const nearest = Math.min(...this.buf.map((f) => Math.abs(f.ts - anchorTs)));
    if (nearest > this.cfg.staleSec * 1000) return { fix: null, reason: 'gps-stale' };

    const basePre = opts.preSec ?? this.cfg.windowPreSec;
    const postSec = opts.postSec ?? this.cfg.windowPostSec;
    const maxPre = Math.max(basePre, this.cfg.widenPreSec);

    let selected: RawFix[] = [];
    let widened = false;
    for (let pre = basePre; pre <= maxPre; pre += WIDEN_STEP_SEC) {
      const lo = anchorTs - pre * 1000;
      const hi = anchorTs + postSec * 1000;
      selected = this.buf.filter(
        (f) => this.isWarm(f.ts) && f.ts >= lo && f.ts <= hi && this.isStationary(f)
      );
      widened = pre > basePre; // reflects the window that produced `selected`
      if (selected.length >= this.cfg.minFixes) break;
    }

    if (selected.length === 0) return { fix: null, reason: 'gps-stale' };

    const accs = selected.map((f) => f.acc);
    const lat = weightedMedian(selected.map((f) => ({ value: f.lat, acc: f.acc })));
    const lon = weightedMedian(selected.map((f) => ({ value: f.lon, acc: f.acc })));
    const medianAccM = median(accs);
    const spanSec =
      (Math.max(...selected.map((f) => f.ts)) - Math.min(...selected.map((f) => f.ts))) / 1000;
    // windowSec drives the independent-sample count. Use the actual data span
    // (min 1s so a single-instant cluster doesn't divide by ~0).
    const windowSec = Math.max(1, spanSec);
    const effAccM = computeEffAcc(medianAccM, selected.length, windowSec, this.cfg);

    const source: GpsFixSource = opts.source ?? (widened ? 'widened' : 'impact');
    return {
      fix: {
        lat,
        lon,
        effAccM,
        fixCount: selected.length,
        windowSec,
        medianAccM,
        source,
        estimatorVersion: GPS_ESTIMATOR_VERSION,
      },
      reason: null,
    };
  }

  /**
   * Current GPS quality for the health chip. Uses the most recent windowPreSec
   * up to `nowTs`; 'locking' while warming up, stale, or with no usable fix.
   */
  currentEffAcc(nowTs: number): GpsHealth {
    if (nowTs < this.warmupUntilTs) return { effAccM: null, state: 'locking', fixCount: 0 };
    const recent = this.buf.filter(
      (f) =>
        this.isWarm(f.ts) &&
        f.ts >= nowTs - this.cfg.windowPreSec * 1000 &&
        f.acc <= this.cfg.fixAccMax
    );
    const newest = this.buf.length ? Math.max(...this.buf.map((f) => f.ts)) : -Infinity;
    if (recent.length === 0 || newest < nowTs - this.cfg.staleSec * 1000) {
      return { effAccM: null, state: 'locking', fixCount: 0 };
    }
    const medianAccM = median(recent.map((f) => f.acc));
    const spanSec = Math.max(
      1,
      (Math.max(...recent.map((f) => f.ts)) - Math.min(...recent.map((f) => f.ts))) / 1000
    );
    const effAccM = computeEffAcc(medianAccM, recent.length, spanSec, this.cfg);
    const state: GpsHealthState =
      effAccM <= this.cfg.tier1EffAccM ? 'green' : effAccM <= this.cfg.tier2EffAccM ? 'yellow' : 'red';
    return { effAccM, state, fixCount: recent.length };
  }
}

/** App singleton — wired to the live config. hooks/useGpsSession feeds it; the
 * capture save path (useCamera) reads it at impact/stop. */
export const gpsSession = new GpsSession(config.tracer.gps);
