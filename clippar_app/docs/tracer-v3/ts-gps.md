# ts-gps — GPS session backbone for tracer V3

**Agent:** `ts-gps`. **Owns:** `lib/gpsSession.ts`, `hooks/useGpsSession.ts`, `tests/gpsSession.test.ts`.
**Status:** complete. tsc clean; 25/25 own tests pass; full suite 701/701 at time of writing.

---

## Why this exists at all

The ORIGINAL tracer (v1) failed in the field for one reason. It took a single
`getCurrentPositionAsync` at recording STOP, and that call routinely returned a stale,
WiFi-anchored fix — two fixes taken 80 m apart came back 4 cm apart, both reporting ±18 m,
because both were anchored to the same router through a WiFi→4G handoff. The carry collapsed to
~0 and the arc was silently skipped.

Everything in `lib/gpsSession.ts` is the defence against that: a continuous ring, an estimate over
the *stationary window around impact*, and a hard staleness rule that returns `null` rather than
ever handing back a cached fix.

## Where the code came from

Ported from the unmerged `origin/tracer-v2` branch, which carries a complete and reviewed
implementation:

| Source | Lines |
|---|---|
| `git show origin/tracer-v2:clippar_app/lib/gpsSession.ts` | 453 |
| `git show origin/tracer-v2:clippar_app/hooks/useGpsSession.ts` | 157 |
| `git show origin/tracer-v2:clippar_app/tests/gpsSession.test.ts` | — |

The lab (`~/projects/clippar/tracer-lab`) is the authority for the **carry uncertainty** half only:
`lib/fit.py`'s `CarryModel`, where

```
sigma_d² = sigma_gps² + bag_offset² + (roll_sigma · D)² + (fpx_frac · D)²,   bag_offset_m = 3.0
```

The ring and the estimator have no lab counterpart — the lab used hand-made GPS by design
(`tracer-lab/NEXT.md`: "Made-up GPS is acceptable for the lab").

---

## API exposed

### `lib/gpsSession.ts`

```ts
export const GPS_ESTIMATOR_VERSION = 1;

export interface GpsConfig {          // the structural slice of config.tracer.gps
  warmupSec; windowPreSec; windowPostSec; widenPreSec; stationarySpeedMax;
  fixAccMax; minFixes; effAccFloor; safetyFactor; staleSec;
  tier1EffAccM; tier2EffAccM; bagOffsetM;                    // all number
}
export const DEFAULT_GPS_CONFIG: GpsConfig;                  // test-stable mirror

export interface RawFix { ts; lat; lon; acc; speed; course }            // all number
export type GpsFixSource = 'impact' | 'stop-fallback';
export interface ShotFix {
  lat; lon; effAccM; fixCount; windowSec; medianAccM;
  source: GpsFixSource; widened: boolean; estimatorVersion: number;
}
export type ShotFixResult =
  | { fix: ShotFix; reason: null }
  | { fix: null; reason: 'gps-stale' | 'no-fix' };

export type GpsHealthState = 'green' | 'yellow' | 'red' | 'locking' | 'denied' | 'off';
export interface GpsHealth { effAccM: number | null; state: GpsHealthState; fixCount: number }

export function fixSourceLabel(fix: ShotFix): string;         // 'impact' | 'impact+widened' | …
export function median(nums: number[]): number;
export function weightedMedian(samples: { value: number; acc: number }[]): number;
export function computeEffAcc(medianAccM, n, windowSec, cfg?): number;

export interface CarryEstimate {
  carryM; bearingDeg; sigmaM; sigmaGpsM; bagOffsetM; effAccAM; effAccBM;   // all number
}
export function carryBetween(
  fixA: ShotFix | null | undefined,
  fixB: ShotFix | null | undefined,
  cfg?: GpsConfig,
): CarryEstimate | null;

export class GpsSession {
  readonly cfg: GpsConfig;
  constructor(cfg?: GpsConfig);
  addFix(f: RawFix): void;
  markWarmup(nowTs: number): void;
  isCold(nowTs: number): boolean;
  reset(): void;
  size(): number;
  seriesAround(anchorTs: number, opts?: EstimateOpts): RawFix[];   // persist as gps_fix_series
  estimateShotFix(anchorTs: number, opts?: EstimateOpts): ShotFixResult;
  estimateAtImpact(anchorTs: number): ShotFixResult;               // ← the definitive anchor
  estimateAtStop(anchorTs: number): ShotFixResult;                 // ← the fallback
  currentEffAcc(nowTs: number): GpsHealth;
}
export const gpsSession: GpsSession;   // app singleton, wired to the live config
```

### `hooks/useGpsSession.ts`

```ts
export function useGpsSession(enabled: boolean): GpsHealth;
```

---

## The properties that must survive any future edit

Each of these was hard-won on the v2 branch and each has a test below.

1. **The anchor is IMPACT time, never the start press.** `recording_start_ts + impact_time_ms`.
   The golfer presses at the bag and walks 5–20 s to the ball, so a start-press anchor medians onto
   the previous filming spot.
2. **The two anchors use DIFFERENT windows.** Impact: `[impact−15 s, impact+10 s]` (`IMPACT_PRE_SEC`,
   no config field). Stop fallback: `[stop−25 s, stop+10 s]` (`windowPreSec`/`windowPostSec`).
3. **The impact anchor has a movement barrier.** Widening backward stops at the first walking fix —
   and an *unknown* speed (CoreLocation reports −1 under canopy) counts as a barrier, because
   "cannot prove not-walking" must stop the scan or a speed-blind walk lets it reach the bag again.
   Below `minFixes` after the barrier it degrades to `null`; it never widens onto the bag.
4. **Warm-up exclusion.** The first `warmupSec` after session start / AppState resume is junk and is
   excluded. Warm-up is re-armed on focus only when the ring `isCold` — re-warming on every tab
   focus threw away a good minute of fixes.
5. **Hard staleness → `null`, never a cached fix.** If no fix sits within `staleSec` of the anchor,
   the answer is `gps-stale`. This is the v1 bug's tombstone.
6. **`effAcc = max(2.5, median(acc)/√(min(N, windowSec/15))) × 1.2`.** Multipath decorrelates on
   ~15 s, so the independent-sample count is the *span*/15 capped by N — 60 fixes 1 s apart do not
   buy √60. iOS `horizontalAccuracy` is optimistic, hence ×1.2.
7. **Accuracy-weighted stationary median** (weight 1/acc²), which survives a single wild outlier in
   a way a weighted mean does not.
8. **`GPS_ESTIMATOR_VERSION`** so persisted fixes can be re-derived at impact time once detection
   lands, without re-recording.

---

## What I ported verbatim vs. changed

### Verbatim (logic and comments both)

The ring, `markWarmup` / `isCold` / `reset` / `size`, `isWarm` / `isStationary` / `isWalking`,
`seriesAround`, `estimateShotFix`, `selectWidening`, `selectImpact`, `estimateAtImpact`,
`estimateAtStop`, `currentEffAcc`, `median`, `weightedMedian`, `computeEffAcc`, `fixSourceLabel`,
and every type except the health-state union. `DEFAULT_GPS_CONFIG` values are unchanged.

The hook's structure is v2's: the generation counter that stops an in-flight `startWatch` leaking a
subscription, focus → `BestForNavigation`, blur → `Balanced` (not stop), AppState-resume re-warm,
the 1 Hz health tick, the throttled `[GPS-RING]` log, teardown on unmount.

### Changed for V3 — every one is marked `V3 CHANGE` in the source

**1. `carryBetween` replaces v2's `computeShotCarry` tier logic.**
v2 returned `{ carryM, bearingDeg, sigmaD, tier: 1|2|3, labelText, tierReason }`. V3 returns metres
and sigma only. The tiers, the label and the A3 chain-break rules are the decision ladder's job
(`lib/tracerV3.ts`), and the label's rounding step is the *fit's* — the lab computes
`label_step_m(sigma_total["carry_m"])`, i.e. the fit's posterior sigma on carry, not the GPS sigma.
I deliberately did not port `label_step_m` / `round_label`; see "Seams" below.

**2. The GPS sigma combination — the one real numerical deviation.**

| | formula | value for effAcc 4 m and 6 m |
|---|---|---|
| v2 | `σ_gps = √((a²+b²)/2)` | 5.10 m |
| **V3** | `σ_gps = √(a²+b²)` | **7.21 m** |

v2's RMS *average* existed to keep its Tier-1 boundary self-consistent (both endpoints ≤5 m ⟹
σ ≤5 m). V3 has no tiers. The distance between two independent fixes has variance `a² + b²` along
the line joining them, so v2's form understates the uncertainty by √2 — and an understated sigma
makes a least-squares fit over-trust the GPS against the pixels, which is precisely what the lab's
error budget exists to prevent. Flagged loudly in the source and asserted in a test.

**Honest caveat I did not paper over:** `effAcc` is a horizontal accuracy *radius*, not a per-axis
1-σ, and I treat it as one. The radius is already inflated by `safetyFactor` (iOS under-reports),
so the approximation leans conservative, but it is an approximation and nobody has measured it.

**3. `bagOffsetM` replaces v2's `filmSpotOffsetVarM`.** Same value (3 m), renamed to match the lab's
`CarryModel.bag_offset_m`, which is the authority. It now lives inside `GpsConfig` because
`carryBetween` reads it.

**4. Two health states added: `denied` and `off`.** v2 returned `locking` for warming-up,
gone-stale, permission-denied *and* feature-off alike, so the chip said "hang on" for conditions
that will never resolve. `denied` is sticky (a `deniedRef` the 1 Hz tick respects) so it is not
immediately overwritten by `locking`.

**5. The hook ANDs `enabled` with the master kill switch:**
`enabled && config.tracer.enabled && Platform.OS !== 'web'`. A caller passing `true` by mistake
would otherwise put a location dialog in front of a production user. That is the one side effect
here the user actually sees, so it gets defence in depth.

**6. `canAskAgain === false` short-circuits to `denied`** instead of round-tripping through a
`requestForegroundPermissionsAsync` the OS will not honour. This matches the existing
`hooks/useLocation.ts` pattern.

**7. `resolveGpsConfig(config.tracer)` instead of `new GpsSession(config.tracer.gps)`.** See the
config seam below.

**8. `GPS_ESTIMATOR_VERSION` deliberately NOT bumped.** It stays 1 because every line that produces
a `ShotFix` is byte-identical to v2. Only the downstream carry sigma changed, and that is derived
on demand from two fixes rather than persisted with them, so bumping would force a re-derivation
that returns the same answers.

### Test-file change

v2's test helper used `M_PER_DEG = 111320`, which is a **different sphere** from the one under test
(`tracerMath.ts` uses `R = 6371000`, i.e. 111194.93 m/deg). Two radii in one file is a trap — every
"metres" assertion carried a silent 0.11 % bias. All helpers now derive from `R = 6371000`. No v2
assertion changes meaning, because offsets and measurements use the same constant.

---

## Seams other agents need

- **`lib/tracerFit.ts` must pass `carryBetween(...).sigmaGpsM` as the lab's `sigma_gps_m`, NOT
  `sigmaM`.** `sigmaM` already has the 3 m bag offset folded in, and `CarryModel.sigma_d` adds it
  again — that double-counts. `sigmaM` is for reporting and plausibility gating; `sigmaGpsM` is for
  the fit. Both are on the returned object and both are documented at the field.
- **Roll and the focal-length systematic are deliberately absent here.** Only the fit knows the club
  bucket (`ROLL_PRIORS`) and whether `f_px` came from `AVCaptureDevice` intrinsics (~2 %) or a
  metadata prior (~12 %).
- **`carryM` is the GPS distance D, i.e. carry PLUS roll**, not the carry. The name follows the
  app's existing column names; separating the two is the fit's job (`d_pred = carry·(1+roll_mean)`).
- **`label_step_m` / `round_label` (1 / 5 / 10 m) are unported.** They belong to whoever owns the
  pill label, and they key off the fit's posterior sigma, not mine. If nobody ports them, the label
  will be more precise than its error — flagging it so it does not fall down the gap.
- **The config block the integration agent writes should be `config.tracer.gps` with the 13 keys of
  `GpsConfig`.** Use v2's values (`git show origin/tracer-v2:clippar_app/constants/config.ts`) and
  rename `filmSpotOffsetVarM` → `bagOffsetM`. A missing or partial slice is safe (defaults fill in);
  a *typo'd* key silently keeps the default, which the singleton test cannot catch.
- **`GpsHealthState` gained `denied` and `off`.** Any exhaustive `switch` on it in the dev-settings
  screen must handle them.
- **Prompt-site collision.** `hooks/useLocation.ts` documents itself as "the only place in the app
  that can raise the location dialog", prompting from record.tsx's round-setup handlers. This hook
  also prompts, at record-tab focus (v2's behaviour, kept: it is well before any recording, and a
  surprise dialog mid-shot would wreck a capture). Two prompting sites for the same when-in-use
  permission is not a correctness bug — whichever runs first shows the dialog and the other reads
  the result — but the integration agent should decide which one owns it rather than inherit two by
  accident.

---

## Tests — `tests/gpsSession.test.ts`, 25 tests, all passing

Ported from v2: clean-30-fixes effAcc, 40 m outlier rejection, walking excluded, warm-up excluded,
stale → null, window widening + `widened` flag, the impact movement barrier, the speed-blind-walk
barrier, `fixSourceLabel` provenance, impact-widened provenance, `no-fix` vs `gps-stale`,
`computeEffAcc` monotonicity sweep, `weightedMedian` robustness, the health chip's
locking/green/yellow/red/stale, impact-vs-stop windows (15/10 vs 25/10), and the impact-vs-start-press
anti-test.

Added for V3:

| Test | What it pins |
|---|---|
| `a start-press-anchored carry reports the PREVIOUS leg; the impact-anchored one is right` | **The regression that matters.** Tee → 220 m drive → 40 m pitch. Impact-anchored carry = 40 m; start-press-anchored = 220 m. A start-press implementation does not merely wobble — it reports the *previous* shot's distance, confidently, with a healthy fix count and a tight effAcc. |
| `a ring that has gone silent yields gps-stale at every anchor — no cached fix, ever` | A full high-quality minute of fixes that stopped 60 s ago must produce `gps-stale` at every anchor and through all three entry points, and the health chip must say `locking` rather than show the last good number. |
| `effAcc improves as N grows, then flattens at the decorrelation cap` | Monotone in N; doubling the *fix rate* over the same 30 s span changes nothing; the 2.5 × 1.2 floor holds. |
| `carryBetween: 150m leg (3-4-5 construction)` | Hand-computed: 90 m N + 120 m E on a sphere of R = 6371000 is exactly 150 m at 53.130°. Implementation agrees to 0.53 mm and 0.0006°. σ_gps = √52 = 7.2111, σ_total = √61 = 7.8102, and an explicit assertion that it is **not** v2's √26 = 5.099. |
| `carryBetween: 12m leg` | 12 m due north, bearing 0, σ_gps = √18, σ_total = √27 — σ/D > 0.4, i.e. a short leg reads as GPS-noise-dominated. The ladder now has the evidence to refuse. |
| `carryBetween is symmetric in distance and reciprocal in bearing` | σ must not depend on argument order. |
| `carryBetween: no successor → null, cleanly (the last shot of a hole)` | All four null/undefined combinations return `null` and never throw. This is the ordinary case — once per hole, eighteen times a round — not an error. |
| `carryBetween: the bag-offset term comes from config, not a literal` | With `bagOffsetM: 0`, σ_total collapses onto σ_gps. |
| `the app singleton has a complete, finite config regardless of what config.ts carries` | Every `GpsConfig` key on `gpsSession.cfg` is a finite number. A partial or typo'd slice must not leave a threshold `undefined` — every comparison against `undefined` is false, which would disable the speed gate and the accuracy filter at once. |

---

## The config seam

`resolveGpsConfig(config.tracer)` reads the slice **structurally** and merges it over
`DEFAULT_GPS_CONFIG`, rather than `new GpsSession(config.tracer.gps)`.

Two reasons. `constants/config.ts` is `as const`, so a direct property access is a **compile error**
on any branch where the `gps` slice has not landed yet — this file had to compile on its own,
before the integration wiring. And a partial slice must fall back per-key to the documented default
rather than arrive as `undefined`; an `undefined` threshold turns every comparison into `false`,
which would disable the speed gate and the accuracy filter silently.

Values are validated at runtime (`typeof === 'number' && Number.isFinite`) and the loop is driven by
the defaults, so an unrecognised config field is ignored rather than injected. Two type assertions
are used, both as weak as possible (`unknown` per field) and both re-validated.

---

## Reversibility — `config.tracer.enabled === false`

- `hooks/useGpsSession` starts no watch, requests no permission, registers no AppState listener and
  runs no interval. It returns a constant `{ effAccM: null, state: 'off', fixCount: 0 }`.
- Importing `lib/gpsSession` constructs one small object. No timers, no I/O, no native calls, no
  side effects. Nothing is written to storage from this module at all — `ShotFix` persistence is
  the integration agent's wiring.
- No new columns, no UI, no hot-path work.

---

## What I could NOT verify

- **Nothing here was run on a device.** Every assertion is against a synthetic ring. Real
  `CLLocation` behaviour — how often `speed` is −1 under canopy, whether `timestamp` is monotonic
  across a WiFi→4G handoff, what `horizontalAccuracy` really looks like on a course — is untested
  and must be checked on a real round. The house rule forbids judging this on the simulator, and I
  did not try.
- **The hook has no unit tests.** It is React + `expo-location` + `@react-navigation` and the repo
  has no React test harness. Its logic is typechecked only. The permission-denied path, the
  generation guard, the focus/blur accuracy downgrade and the AppState re-warm are all
  **asserted-by-construction, not tested** — read them before trusting them.
- **`carryBetween`'s sigma is not calibrated against real GPS.** `√(a²+b²)` is the correct
  combination for two independent isotropic fixes; whether iOS `horizontalAccuracy × 1.2` is
  actually a 1-σ is an assumption inherited from v2 and never measured.
- **`DEFAULT_GPS_CONFIG` is a mirror, not the source.** If the integration agent's
  `config.tracer.gps` diverges, the tests keep asserting the mirror's behaviour while the app uses
  the live values. That is deliberate (test stability) but it means a retune needs both files.
- **The v1 field failure is described from the record**, not reproduced by me — the "two fixes 4 cm
  apart after an 80 m walk" observation comes from the comments in `hooks/useLocation.ts` and the
  v2 branch, not from anything I measured.

## Verification actually run

```
cd /Users/hendacow/projects/clippar/final_shipment/clippar_app
npx tsc --noEmit                                   # clean, zero errors, whole project
node --import tsx --test tests/gpsSession.test.ts   # 25/25 pass
npm test                                           # 701/701 pass (652 baseline + mine + others')
```

No Swift in this task. No `git` commands beyond `git show` against `origin/tracer-v2` (read-only).
No `npm install`. No files touched outside the three I own plus this report.
