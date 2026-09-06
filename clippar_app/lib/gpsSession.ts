/**
 * lib/gpsSession.ts — the tracer's GPS backbone. PURE TS, ZERO native deps,
 * fully unit-testable. `hooks/useGpsSession.ts` feeds this from
 * watchPositionAsync; the estimator turns a rolling ring of raw fixes into a
 * per-shot position plus an honest effective accuracy, and `carryBetween`
 * turns two per-shot positions into the metres + 1-sigma that `lib/tracerFit.ts`
 * consumes as a scale constraint.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 * The ORIGINAL tracer (v1) failed in the field for one reason: it took a single
 * `getCurrentPositionAsync` at recording STOP, which routinely returned a stale,
 * WiFi-anchored fix. Two fixes 80 m apart came back 4 cm apart, the carry
 * collapsed to ~0 and the arc was silently skipped. Everything below is the
 * defence against that: a continuous ring, an estimate over the stationary
 * window, and a HARD staleness rule that returns null rather than ever handing
 * back a cached fix. If you are tempted to "just fall back to the last known
 * position", that is the bug, restored.
 *
 * ── THE ANCHOR IS IMPACT TIME, NEVER THE START PRESS ──────────────────────
 * The golfer presses start AT THE BAG, then walks 5–20 s+ to the ball.
 * Anchoring the stationary window at the start press medians onto the previous
 * filming spot, 50–150 m away — a wrong answer that looks completely healthy
 * (tight accuracy, plenty of fixes). So `estimateShotFix` takes an arbitrary
 * ABSOLUTE anchor, and the two anchor types use DIFFERENT windows:
 *   • IMPACT anchor (`recording_start_ts + impact_time_ms`): [impact−15 s,
 *     impact+10 s] — a tight pre-window, so a long walk's bag cluster cannot
 *     leak in (the bag need only be >15 s before impact to be excluded).
 *   • STOP fallback (recording STOP, used until `impact_time_ms` lands):
 *     [stop−25 s, stop+10 s] — a wider look-back to reach the setup dwell from
 *     the stop press. These are `config.tracer.gps.windowPreSec` /
 *     `windowPostSec`.
 * The tight +10 s post is safe at both anchors: the golfer walking away is
 * excluded by the speed gate, not by the window. The raw fix series is
 * persisted so a fix can be re-derived at impact time once detection lands
 * (`GPS_ESTIMATOR_VERSION` gates re-processing).
 *
 * ── PROVENANCE ────────────────────────────────────────────────────────────
 * Ported from `origin/tracer-v2:clippar_app/lib/gpsSession.ts` (453 lines,
 * reviewed there). The ring, the anchors, the movement barrier, the warm-up
 * exclusion, the staleness rule, `computeEffAcc` and the accuracy-weighted
 * median are all UNCHANGED — those properties were hard-won and their comments
 * came with them. What is new for V3 is `carryBetween` (v2 returned a tier;
 * V3 wants the metres and the sigma, because the fit has its own uncertainty
 * model) and the `off` / `denied` health states. Every deviation is marked
 * `V3 CHANGE`.
 *
 * Window/threshold constants come from `config.tracer.gps`. The impact
 * pre-window (15 s) has no config field, so it lives here, as do the
 * estimator-internal constants the config does not expose (ring horizon,
 * decorrelation time, series cap, widen step).
 */
import { config } from '../constants/config';
import { haversineMeters, initialBearingDeg } from './tracerMath';

// ── estimator-internal constants (not tunable via config.tracer.gps) ────────
const RING_SEC = 180; // ring buffer horizon
const DECORREL_SEC = 15; // multipath decorrelates on ~15 s, not per-fix
const SERIES_CAP_N = 60; // persist at most this many raw fixes per shot
const WIDEN_STEP_SEC = 10; // grow the pre-window by this each widen pass
/** IMPACT-anchor pre-window. `config.tracer.gps` has no impact-pre field —
 *  windowPreSec/windowPostSec are the STOP-anchor pair. */
const IMPACT_PRE_SEC = 15;

/**
 * Bump when the ESTIMATOR math changes, so persisted fixes can be re-derived.
 *
 * Deliberately still 1 after the V3 port: every line that produces a `ShotFix`
 * is byte-identical to v2. `carryBetween`'s sigma rule did change (see there),
 * but the carry is derived on demand from two fixes and is not what this
 * version gates, so bumping would force a pointless re-derivation of fixes
 * that would come back the same.
 */
export const GPS_ESTIMATOR_VERSION = 1;

/**
 * The slice of `config.tracer.gps` this module consumes. A structural
 * subset, so `resolveGpsConfig()` type-checks against whatever the integration
 * agent writes (the live object may carry extra fields that only the ladder or
 * the dev-settings screen reads).
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
  /**
   * V3 CHANGE. 1-sigma of where the phone actually sat relative to the ball at
   * the NEXT shot — the lab's `CarryModel.bag_offset_m`, which is 3.0 m
   * (`tracer-lab/lib/fit.py`). v2 carried the same number under the name
   * `filmSpotOffsetVarM`; renamed to match the lab, which is the authority.
   */
  bagOffsetM: number;
}

/**
 * Test-stable mirror of the shipped `config.tracer.gps` values. The app
 * singleton uses the live config; tests construct `GpsSession` with this so
 * assertions don't move if the config block is retuned. Keep in sync.
 */
export const DEFAULT_GPS_CONFIG: GpsConfig = {
  warmupSec: 15,
  windowPreSec: 25, // STOP-anchor pre-window (impact uses IMPACT_PRE_SEC=15)
  windowPostSec: 10, // shared post-window (+10 s at both anchors)
  widenPreSec: 45,
  stationarySpeedMax: 0.7,
  fixAccMax: 20,
  minFixes: 5,
  effAccFloor: 2.5,
  safetyFactor: 1.2,
  staleSec: 10,
  tier1EffAccM: 5,
  tier2EffAccM: 10,
  bagOffsetM: 3,
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

/** The anchor the fix was derived at. Provenance; `widened` is a SEPARATE flag
 *  (not overloaded onto source) so a widened impact fix reads 'impact' + true. */
export type GpsFixSource = 'impact' | 'stop-fallback';

export interface ShotFix {
  lat: number;
  lon: number;
  effAccM: number;
  fixCount: number;
  windowSec: number;
  medianAccM: number;
  source: GpsFixSource;
  /** True when the window was widened past its base pre-window to reach
   *  minFixes. Persisted (gps_source = e.g. 'impact+widened') so a fix that
   *  scraped the minimum is auditable in the field walk. */
  widened: boolean;
  estimatorVersion: number;
}

export type ShotFixResult =
  | { fix: ShotFix; reason: null }
  | { fix: null; reason: 'gps-stale' | 'no-fix' };

/**
 * V3 CHANGE — two states added to v2's green/yellow/red/locking.
 *
 * `locking` used to be returned for warming-up, gone-stale, permission-denied
 * AND feature-off alike, which makes the dev-settings chip say "hang on" for a
 * condition that will never resolve. They are different facts, so they are
 * different states: `denied` = the user said no (or the OS will not ask again),
 * `off` = the hook is inert (tracer disabled, or web).
 */
export type GpsHealthState = 'green' | 'yellow' | 'red' | 'locking' | 'denied' | 'off';

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
  /**
   * IMPACT-anchor guard: when widening past the base pre-window, stop the
   * moment a walking (speed-gated) fix is hit scanning backward — never median
   * across the walk onto the previous (bag) cluster. Below minFixes after the
   * barrier we degrade (return null) rather than widen further.
   */
  movementBarrier?: boolean;
}

/** gps_source column value: anchor + widened provenance. */
export function fixSourceLabel(fix: ShotFix): string {
  return fix.widened ? `${fix.source}+widened` : fix.source;
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
 * a single wild outlier the way a weighted mean is not — a 40 m-off fix with acc
 * 18 carries weight 1/324 vs 1/9 for a 3 m fix, so it sits at the tail of the
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
 * independent-sample count is the window span / DECORREL_SEC, capped by N —
 * averaging 60 fixes taken 1 s apart does NOT buy √60. iOS horizontalAccuracy
 * is optimistic, hence the safety factor.
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

// ── carry between two shots (V3) ────────────────────────────────────────────

/**
 * V3 CHANGE — v2 returned a tier + a rounded label here. V3 returns the METRES
 * and the SIGMA, because `lib/tracerFit.ts` consumes the carry as a scale
 * constraint with the lab's own uncertainty model and must not be handed a
 * pre-judged number.
 */
export interface CarryEstimate {
  /** Great-circle distance between the two shot fixes, metres. This is the GPS
   *  distance D — carry PLUS roll, not the carry. Naming it `carryM` follows
   *  the app's existing column names; the fit is what separates the two. */
  carryM: number;
  /** Initial bearing A→B, degrees clockwise from true north. */
  bearingDeg: number;
  /**
   * Total 1-sigma of the measured leg: both endpoints' effAcc plus the
   * bag-offset term. Use this for reporting and for plausibility gating.
   *
   * DO NOT pass this to the fit as `sigma_gps_m` — the lab's `CarryModel`
   * (tracer-lab/lib/fit.py) adds the bag offset itself, so it would be counted
   * twice. Pass `sigmaGpsM`.
   */
  sigmaM: number;
  /**
   * GPS-only 1-sigma, √(a²+b²). THIS is the lab's `CarryModel.sigma_gps_m`;
   * the roll band and the focal-length term are the fit's to add, since only
   * the fit knows the club bucket and whether f_px came from device
   * intrinsics (~2 %) or from a metadata prior (~12 %).
   */
  sigmaGpsM: number;
  /** The bag-offset term folded into `sigmaM` (lab `CarryModel.bag_offset_m`). */
  bagOffsetM: number;
  /** Both endpoints' effective accuracy, so the ladder can say WHICH end was bad. */
  effAccAM: number;
  effAccBM: number;
}

/**
 * Distance, bearing and uncertainty between a shot's fix and its same-hole
 * successor's fix.
 *
 * Returns null when either fix is missing — which is the ordinary case for THE
 * LAST SHOT OF A HOLE: there is no successor, so there is no GPS carry, and the
 * shot renders pixel-only and unlabelled. That is not an error and must not be
 * logged as one.
 *
 * ── V3 CHANGE: how the two sigmas combine ─────────────────────────────────
 * v2 used σ_gps = √((a²+b²)/2) — an RMS *average* of the two endpoints. That
 * choice was made to keep v2's Tier-1 boundary self-consistent (both endpoints
 * ≤5 m ⟹ σ ≤5 m), and V3 has no tiers. The distance between two independent
 * fixes has variance a² + b² along the line joining them, so V3 uses
 * √(a²+b²): v2's form understates the real uncertainty by a factor √2, and an
 * understated sigma makes a least-squares fit over-trust the GPS against the
 * pixels — exactly the failure the lab's error budget exists to prevent.
 *
 * Honest caveat, not papered over: `effAcc` is a horizontal accuracy RADIUS,
 * not a per-axis 1-sigma, and we treat it as one. The radius is already
 * inflated by `safetyFactor` (iOS under-reports), so this is a modest and
 * conservative-leaning approximation, but it is an approximation.
 *
 * Roll and the focal-length systematic are deliberately ABSENT: they belong to
 * `lib/tracerFit.ts`, which knows the club bucket and the lens provenance.
 */
export function carryBetween(
  fixA: ShotFix | null | undefined,
  fixB: ShotFix | null | undefined,
  cfg: GpsConfig = DEFAULT_GPS_CONFIG
): CarryEstimate | null {
  if (!fixA || !fixB) return null;

  const a = fixA.effAccM;
  const b = fixB.effAccM;
  const sigmaGpsM = Math.sqrt(a * a + b * b);
  const bagOffsetM = cfg.bagOffsetM;

  return {
    carryM: haversineMeters(fixA.lat, fixA.lon, fixB.lat, fixB.lon),
    bearingDeg: initialBearingDeg(fixA.lat, fixA.lon, fixB.lat, fixB.lon),
    sigmaM: Math.sqrt(sigmaGpsM * sigmaGpsM + bagOffsetM * bagOffsetM),
    sigmaGpsM,
    bagOffsetM,
    effAccAM: a,
    effAccBM: b,
  };
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

  /**
   * True when the ring holds no usable recent history (empty, or the newest fix
   * is older than staleSec). The record tab should only re-arm warm-up when the
   * ring is cold — re-warming on every focus would invalidate a perfectly good
   * minute of fixes just because the user tabbed away and back.
   */
  isCold(nowTs: number): boolean {
    if (this.buf.length === 0) return true;
    const newest = Math.max(...this.buf.map((f) => f.ts));
    return newest < nowTs - this.cfg.staleSec * 1000;
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

  /** A definitely-moving fix (the golfer walking) — the impact movement
   *  barrier. Distinct from "not stationary" (which also covers inaccurate
   *  fixes): a merely inaccurate fix is skipped, a WALKING fix stops the
   *  backward scan. */
  private isWalking(f: RawFix): boolean {
    return f.speed >= 0 && f.speed > this.cfg.stationarySpeedMax;
  }

  /**
   * Raw fixes bracketing an anchor (post-warmup only), nearest-first, capped at
   * SERIES_CAP_N. Persisted per clip (gps_fix_series) so the fix can be
   * re-derived later with a newer estimator without re-recording. Returns the
   * widest window we'd ever consider, UNFILTERED by stationarity, so a future
   * estimator can re-apply its own gates.
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
   * Estimate the shot position at `anchorTs` (IMPACT time, or the stop
   * fallback). Accuracy-weighted median over the stationary window, widening
   * the pre-window toward widenPreSec until it holds ≥ minFixes. Hard
   * staleness: if the ring has no fix within staleSec of the anchor, returns
   * gps-stale — NEVER a cached fix.
   */
  estimateShotFix(anchorTs: number, opts: EstimateOpts = {}): ShotFixResult {
    if (this.buf.length === 0) return { fix: null, reason: 'no-fix' };

    // Hard staleness: the closest fix to the anchor must be within staleSec. If
    // GPS froze before the shot, every fix predates the anchor by >staleSec and
    // we refuse to coast on a cached position.
    const nearest = Math.min(...this.buf.map((f) => Math.abs(f.ts - anchorTs)));
    if (nearest > this.cfg.staleSec * 1000) return { fix: null, reason: 'gps-stale' };

    const basePre = opts.preSec ?? this.cfg.windowPreSec;
    const postSec = opts.postSec ?? this.cfg.windowPostSec;

    const sel = opts.movementBarrier
      ? this.selectImpact(anchorTs, basePre, postSec)
      : this.selectWidening(anchorTs, basePre, postSec);

    // Distinguish "no stationary fix in the window" (no-fix) from the staleness
    // case above (fixes exist but are old → gps-stale). For the impact barrier,
    // degrading below minFixes is also 'no-fix' — never widen onto the bag.
    if (sel.selected.length === 0) return { fix: null, reason: 'no-fix' };
    if (opts.movementBarrier && sel.selected.length < this.cfg.minFixes) {
      return { fix: null, reason: 'no-fix' };
    }

    const selected = sel.selected;
    const accs = selected.map((f) => f.acc);
    const lat = weightedMedian(selected.map((f) => ({ value: f.lat, acc: f.acc })));
    const lon = weightedMedian(selected.map((f) => ({ value: f.lon, acc: f.acc })));
    const medianAccM = median(accs);
    const spanSec =
      (Math.max(...selected.map((f) => f.ts)) - Math.min(...selected.map((f) => f.ts))) / 1000;
    // windowSec drives the independent-sample count. Use the actual data span
    // (min 1 s so a single-instant cluster doesn't divide by ~0).
    const windowSec = Math.max(1, spanSec);
    const effAccM = computeEffAcc(medianAccM, selected.length, windowSec, this.cfg);

    return {
      fix: {
        lat,
        lon,
        effAccM,
        fixCount: selected.length,
        windowSec,
        medianAccM,
        source: opts.source ?? 'impact',
        widened: sel.widened,
        estimatorVersion: GPS_ESTIMATOR_VERSION,
      },
      reason: null,
    };
  }

  /**
   * STOP-anchor (and generic) selection: take the base window, then widen the
   * pre-window toward widenPreSec until ≥ minFixes. May span a movement gap —
   * acceptable for the wider stop fallback, NOT for the impact anchor.
   */
  private selectWidening(
    anchorTs: number,
    basePre: number,
    postSec: number
  ): { selected: RawFix[]; widened: boolean } {
    const maxPre = Math.max(basePre, this.cfg.widenPreSec);
    let selected: RawFix[] = [];
    let widened = false;
    for (let pre = basePre; pre <= maxPre; pre += WIDEN_STEP_SEC) {
      const lo = anchorTs - pre * 1000;
      const hi = anchorTs + postSec * 1000;
      selected = this.buf.filter(
        (f) => this.isWarm(f.ts) && f.ts >= lo && f.ts <= hi && this.isStationary(f)
      );
      widened = pre > basePre;
      if (selected.length >= this.cfg.minFixes) break;
    }
    return { selected, widened };
  }

  /**
   * IMPACT-anchor selection with the movement barrier. Take the base
   * [anchor−basePre, anchor+postSec] stationary window; if it's short, widen
   * BACKWARD past basePre but STOP at the first walking fix — so a long walk's
   * bag cluster can never be medianed in. Merely-inaccurate fixes are skipped
   * (they aren't a movement gap). The caller degrades to null below minFixes.
   */
  private selectImpact(
    anchorTs: number,
    basePre: number,
    postSec: number
  ): { selected: RawFix[]; widened: boolean } {
    const lo = anchorTs - basePre * 1000;
    const hi = anchorTs + postSec * 1000;
    const base = this.buf.filter(
      (f) => this.isWarm(f.ts) && f.ts >= lo && f.ts <= hi && this.isStationary(f)
    );
    if (base.length >= this.cfg.minFixes) return { selected: base, widened: false };

    // Widen backward from the base edge, newest-first, until a walking fix.
    const widenLo = anchorTs - Math.max(basePre, this.cfg.widenPreSec) * 1000;
    const back = this.buf
      .filter((f) => this.isWarm(f.ts) && f.ts < lo && f.ts >= widenLo)
      .sort((a, b) => b.ts - a.ts);
    const extra: RawFix[] = [];
    for (const f of back) {
      // Movement barrier — never cross the walk. Unknown speed (CoreLocation
      // reports -1 under heavy canopy) is treated AS a barrier: "can't prove
      // not-walking → stop", else a fully speed-blind walk lets the scan skip
      // through to the bag again.
      if (f.speed < 0 || this.isWalking(f)) break;
      if (this.isStationary(f)) extra.push(f);
    }
    return { selected: [...base, ...extra], widened: extra.length > 0 };
  }

  /**
   * The definitive anchor: estimate at IMPACT time with the tight
   * [impact−IMPACT_PRE_SEC, impact+windowPostSec] window + movement barrier.
   * Call this once detection lands impact_time_ms
   * (anchor = recording_start_ts + impact).
   */
  estimateAtImpact(anchorTs: number): ShotFixResult {
    return this.estimateShotFix(anchorTs, {
      preSec: IMPACT_PRE_SEC,
      postSec: this.cfg.windowPostSec,
      source: 'impact',
      movementBarrier: true,
    });
  }

  /**
   * The fallback anchor: estimate at recording STOP with the wider
   * [stop−windowPreSec, stop+windowPostSec] window. Used at save time before
   * impact_time_ms is known.
   */
  estimateAtStop(anchorTs: number): ShotFixResult {
    return this.estimateShotFix(anchorTs, {
      preSec: this.cfg.windowPreSec,
      postSec: this.cfg.windowPostSec,
      source: 'stop-fallback',
    });
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
      effAccM <= this.cfg.tier1EffAccM
        ? 'green'
        : effAccM <= this.cfg.tier2EffAccM
          ? 'yellow'
          : 'red';
    return { effAccM, state, fixCount: recent.length };
  }
}

/**
 * Resolve the live `config.tracer.gps` slice over the documented defaults.
 *
 * WHY it is read structurally rather than as `config.tracer.gps`: the tracer
 * config block is owned by the integration wiring, and `constants/config.ts`
 * is `as const`, so a direct property access is a compile error on any branch
 * where the `gps` slice has not landed yet. Declaring the shape we need keeps
 * this module compiling on its own and accepts whatever is written later —
 * including a PARTIAL slice, where a missing knob falls back to its default
 * instead of arriving as `undefined` and quietly turning every threshold
 * comparison into `false`. Non-numeric values are ignored for the same reason.
 */
function resolveGpsConfig(tracerConfig: unknown): GpsConfig {
  if (typeof tracerConfig !== 'object' || tracerConfig === null || !('gps' in tracerConfig)) {
    return DEFAULT_GPS_CONFIG;
  }
  const raw: unknown = tracerConfig.gps;
  if (typeof raw !== 'object' || raw === null) return DEFAULT_GPS_CONFIG;
  // Two assertions, both as weak as they can be and both re-validated below:
  // every field of the slice is `unknown` until `typeof` says otherwise, and
  // the loop is driven by the DEFAULTS, so a config field we don't know about
  // is ignored rather than injected.
  const slice = raw as Partial<Record<keyof GpsConfig, unknown>>;
  const merged: GpsConfig = { ...DEFAULT_GPS_CONFIG };
  for (const key of Object.keys(DEFAULT_GPS_CONFIG) as (keyof GpsConfig)[]) {
    const value = slice[key];
    if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
  }
  return merged;
}

/** App singleton — wired to the live config. `hooks/useGpsSession` feeds it;
 *  the capture save path reads it at impact/stop. */
export const gpsSession = new GpsSession(resolveGpsConfig(config.tracer));
