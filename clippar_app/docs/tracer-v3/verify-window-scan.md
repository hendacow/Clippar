# verify-window-scan — the gate on the window-scan tracer

**Agent:** `verify`. **Date:** 2026-09-07. **Machine:** this Mac (Apple silicon), macOS 25.5.
**Detector under test:** `tracerdet.hash = 85f273d0414b`
(`shasum -a 256 $IOS/TracerDetect.swift $IOS/TracerDetectCore.swift | shasum -a 256 | cut -c1-12`,
absolute paths, as `bench/build.sh` computes it — a relative-path shasum gives a different
string and is not the cache key).

**Everything below was run, not estimated. Nothing below ran on a phone.**

---

## 0. Verdict, before the detail

| Gate | Result |
|---|---|
| 1. `npm run verify` | **PASS** — tsc clean. **897** tests as found, **904** after the 7 this agent added. 0 fail, 0 skipped, 0 todo. |
| 2. Swift `-parse` all 5 files, `-typecheck` the 3 tracer files | **PASS** — exit 0, zero diagnostics, sanity-probed. |
| 3. Bench re-run, independently tabulated | **REPRODUCES** the tuning agent's claim exactly. |
| 4. Refusals hold, `forceTrace` off and on | **PASS** — 0 false draws on 49 corpus negatives; **0 of 45** runs on 9 adversarial clips I built myself; all 32 draws visually audited and all 32 are real golf strokes; **0 of 32 state a distance**. With `forceTrace` ON a camera pan draws (documented behaviour, ships off). |
| 5. No crashes | **PASS** — 0 failures, 0 throws, 0 bad exits on 121 clips; the old SIGTRAP clip runs. **But a clip that refuses costs up to 8 minutes — §5c.** |
| 6. `config.tracer.enabled = false` → nothing runs | **PASS** |
| 7. Henry's question, in numbers | see §7 |

**The tuning did not raise the hit rate by admitting junk.** The false-draw rate went
*down* (1/49 → 0/49) while the hit rate went up, and the one clip that used to draw
wrongly (IMG_0323, a camera strapped to a golf trolley) now refuses. That is the shape
of a real improvement, not a loosened gate. **No FAIL goes at the top of this report.**

**Two things Henry should know that are not in the tuning report**, both measured here and
neither a reason to stop:

1. **A clip that is going to refuse costs 17-20 detector passes — up to 8 minutes on 4K.**
   74 % of the corpus consumes 94 % of the detector time and produces nothing. §5c.
2. **An arc can legally start after the trimmed footage ends and be drawn over a frozen
   frame.** Not reachable today, because the app's impact estimator errs *late* and the
   late direction fails safe — but the guard is that happenstance, not a check in the
   code. §4e, with the one-line fix and its measured cost (zero clips).

---

## 1. `npm run verify`

```
$ cd ~/projects/clippar/final_shipment/clippar_app && npm run verify
> clippar_app@1.1.0 typecheck
> tsc --noEmit
> clippar_app@1.1.0 test
> node --import tsx --test tests/*.test.ts
ℹ tests 897
ℹ suites 0
ℹ pass 897
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 51169.445459
```

**tsc clean. 897 pass, 0 fail, 0 skipped, 0 todo.** The floor was 872 and the tuning
agent reported 886; the extra 11 are other agents' work landing in the same checkout
during this session, not mine.

**After adding `tests/tracerV3DerivedImpact.test.ts` (7 tests) the suite is 904:**

```
$ npm run verify
ℹ tests 904
ℹ pass 904
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 56780.502083
```

**904 pass, 0 fail, 0 skipped, 0 todo, tsc clean.** No existing test was weakened, deleted
or made conditional; the only edits outside my own file are two new bench-only files that
nothing in the app imports (`docs/tracer-v3/bench/verifyLadder.ts`, `advLadder.ts`).

### The tests this agent added

The brief is right that the impact derivation had no test of *the thing that matters*.
`tests/tracerV3ImpactScan.test.ts` asserts fourteen properties of the Swift — that the
scan exists, that its window is clamped, that its refusals were not softened — all by
reading source text, because node cannot execute Swift. **None of it is executable and
none of it touches the consequence.**

The consequence is this. The detector may now move the impact up to `scanRadiusMs`
(±3.5 s) away from the one the app handed it. **The app's trim window does not move with
it** — `planHighlightTrim` runs off the app's own swing detector before the tracer is
called at all. So the flight the detector found can land outside the four seconds that
will actually be rendered, and what happens then is a TypeScript question, not a Swift
one.

`tests/tracerV3DerivedImpact.test.ts`, 7 tests, all executable against the real
`traceClip`:

| Test | What it pins |
|---|---|
| impact relocated BEFORE the trimmed clip | refuses `render_spec:animStartSec … out of range`, both `forceTrace` settings — never a negative animation start |
| impact relocated PAST the end | **draws onto a held frame** — see §4, this is the finding — bounded by `freezeMaxSec`, and refuses outright with the freeze off |
| the bypass at either end | `forceTrace` changes nothing about a window |
| **the entire ±4.5 s range, in 50 ms steps** | 181 `traceClip` calls: no throw, every emitted spec satisfies all five renderer invariants (`tSec[0] === 0`, strictly increasing, last sample === `animDurationSec`, finite, `animStartSec >= 0`), every refusal carries a reason, no refusal class other than `render_spec`, and the drawable band is contiguous |
| moving the window | moves *when* the arc draws, never *where* — not one pixel of the trace moves, so the arc follows the ball and not the hint |
| the derived-impact notes | are inert: four different (including absurd and absent) `impactDerivedMs` / `impactShiftMs` / `impactSource` payloads cannot move a decision, a reason, a flag, a pill or a draw |
| the scan's three bounds | `scanMaxTries` ∈ 1..4, `scanMaxCandidates` ≤ 64, `scanPersist` ≥ 1 — read out of the Swift, because unbounded here is a hang on a phone, which is worse than a skip |

The sweep reads `scanRadiusMs` **out of `TracerDetectCore.swift` rather than hard-coding
it**, so widening the search widens the test with it instead of leaving it quietly
under-covering the new range.

---

## 2. Swift

`-parse` on every file in `modules/shot-detector/ios`:

```
$ SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
$ for f in *.swift; do xcrun swiftc -parse -sdk "$SDK" -target arm64-apple-ios15.0 "$f"; done
ShotDetectorModule.swift     PARSE OK
ShotTracer.swift             PARSE OK
TracerDetect.swift           PARSE OK
TracerDetectCore.swift       PARSE OK
TracerRenderV3.swift         PARSE OK
```

`-typecheck` on the three tracer files together (they share types, so they must be
compiled together or the check is meaningless):

```
$ xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
    -target arm64-apple-ios15.0 \
    TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift
EXIT=0
--- output (0 lines)
```

Zero diagnostics, exit 0. **Sanity-probed**, because a check that passes on everything is
not a check — appending `let _deliberateTypeError: Int = "not an int"` to a copy of
`TracerDetect.swift` and re-running gives
`error: cannot convert value of type 'String' to specified type 'Int'`. The command is
real.

The bench also compiles and links the same sources into a running macOS binary
(`bench/build.sh` → `$BENCH_WORK/tracerdet`), which is a stronger statement than a
typecheck: everything measured below came out of that binary.

---

## 3. The bench, re-run and re-tabulated independently

Method, and its one honest limitation. Detector output is cached under a key of
(clip content hash, impact ms, **detector source hash**), so a ladder change re-runs the
ladder over the same detections and a detector change invalidates the lot. I confirmed
the tree's detector hashes to `85f273d0414b`, which is what the cache is keyed on, then
**re-ran the ladder from scratch over all 121 clips** and tabulated the rows with my own
script (`report.py` was not used — repeating someone else's arithmetic is not a check).
Separately I re-ran the **detector itself, cold, with no cache**, on every clip — §5.

```
$ python3 docs/tracer-v3/bench/bench.py --mode app  --out …/verify-app.json
$ python3 docs/tracer-v3/bench/bench.py --mode truth --out …/verify-truth.json
```

### App conditions — the app's own impact, no pitch, no lens, no GPS

Two denominators, both stated, so neither flatters the other. **REAL SHOTS** = full
swings + chips, i.e. every clip in which a ball was actually struck. **ALL CLIPS**
includes the putts and the not-a-shot clips, which the tracer is *supposed* to refuse, so
that number is a floor and not a failure.

| | full_swing | chip | **REAL SHOTS** | ALL CLIPS | **FALSE DRAW** (putt + not_a_shot) |
|---|---|---|---|---|---|
| **All 121** | **21/51 = 41.2%** | 11/21 = 52.4% | **32/72 = 44.4%** | 32/121 = 26.4% | **0/49 = 0.0%** |
| Henry's own (65) | **10/25 = 40.0%** | 6/12 = 50.0% | 16/37 = 43.2% | 16/65 = 24.6% | 0/28 = 0.0% |
| Lab regression set (36) | **9/15 = 60.0%** | 5/8 = 62.5% | 14/23 = 60.9% | 14/36 = 38.9% | 0/13 = 0.0% |
| Unseen (20) | **2/11 = 18.2%** | 0/1 | 2/12 = 16.7% | 2/20 = 10.0% | 0/8 = 0.0% |

**Every headline the tuning agent claimed reproduces exactly** — 21/51, 0/49, 11/21,
10/25, 9/15, 2/11. Nothing was rounded up; 41.2% is 21/51 to one decimal, not 41.18
rounded to 41.2 in the flattering direction (it is 41.176…, which rounds down).

### Ceiling — the same pipeline handed a hand-confirmed impact

| | drew |
|---|---|
| All 26 with confirmed truth | **17/26 = 65.4%** |
| Henry's (10) | 6/10 = 60.0% |
| Lab (13) | 10/13 = 76.9% |
| Unseen (3) | 1/3 = 33.3% |

Also reproduces the claim exactly. **Read the ceiling with care**: all 26 are full swings,
and they have a confirmed impact *because a human could find the ball to confirm it*. It
is the ceiling on a favourable subset, not on the corpus.

### The regression set did not get worse

The lab 36 are the tuned-on clips and the thing that must not go backwards. They went
**5/15 → 9/15 on full swings** and **0 → 0 on false draws**. Nothing in the lab set was
lost.

### What I could NOT independently reproduce

The **"before" numbers** (15/51, 1/49). Those were measured at detector hash
`2ca30f5e58e2`, and the detection cache is keyed on the source hash, so changing the
Swift threw those detections away. They cannot be recomputed without re-running the old
detector over the whole corpus, which I did not do.

What I *can* do is corroborate them against the one older run still on disk,
`$BENCH_WORK/archive/results-app-caa986ca545c.json` — a **different, earlier** detector
(`caa986ca545c`), not the tuning agent's baseline:

* full swings **15/51 = 29.4%** — the same before-number, from an independent detector state
* false draws **2/49 = 4.1%** — `IMG_0323` (the golf-trolley clip) **and `IMG_0596_2`, a putt**

Against *that* state, the tuning **lost four clips that used to draw**: the two false
draws (good — that is the point), plus `IMG_0541_2` (a chip) and **`IMG_0578_2`, a real
full swing**, now `track_not_ballistic: rms 74.1 px`. The tuning agent's "full swings LOST
none" is true against its own `2ca30f5e58e2` baseline and is **not** true against
`caa986ca545c`. It is a small correction to a claim, not a defect: the net is +9 gained,
−4 lost.

The nine gained, and why, because a hit-rate rise with no mechanism is not evidence:

```
IMG_0534, IMG_3622, IMG_3637, IMG_3645, IMG_3660, IMG_6163   was: not_a_flight — "apex 0.02 m"
IMG_7873                                                     was: track_not_ballistic rms 85.0 px
IMG_3627                                                     was: detector_found_no_address_ball
IMG_0525_2 (chip)                                            was: poor_fit rms 4.3 px > 4 px
```

Six of the nine were a *degenerate* fit — apex 0.02 m on a driver — which is what a wrong
assumed camera pitch produces. The pitch ladder is doing exactly the thing it was built
to do. That is a legible mechanism, not a threshold that was nudged.

---

## 4. The refusals

### 4a. Nothing that is not a shot draws — on the corpus

**0 of 49 negatives (36 putts + 13 not-a-shot clips) draw. Zero.** The one that used to,
`IMG_0323` — a phone strapped to a golf trolley — now refuses on `poor_fit: rms 11.2 px >
8 px`.

The refusal is doing real work rather than being handed easy wins by the classifier
upstream. **16 of those 49 negatives are classified `swing` by the app's own shot
classifier**, so the putt gate never sees them and they go all the way into the ladder:

```
IMG_3630[putt] IMG_3644[putt] IMG_3648[putt] IMG_3663[not_a_shot] IMG_0323[not_a_shot]
IMG_0526[putt] IMG_0553[putt] IMG_0558[putt] IMG_0576[putt] IMG_0579[putt] IMG_0582[putt]
IMG_0584_2[not_a_shot] IMG_0596_2[putt] IMG_6148[not_a_shot] IMG_8119[not_a_shot] IMG_9470[putt]
```

All 16 refuse: 13 on `detector_found_no_address_ball`, and one each on `poor_fit`,
`track_not_ballistic` and `pitch_unstable`.

**The two thinnest margins, named because "zero false draws" with a 3-pixel margin is a
different statement from zero with a hundred:**

| clip | class | refused by | margin |
|---|---|---|---|
| `IMG_0596_2` | **putt** | `pitch_unstable` | **fits at rms 3.1 px at exactly one rung of the pitch ladder.** The quorum-of-2 rule is the *only* thing between this putt and an arc. At quorum 1 it draws. |
| `IMG_0323` | not_a_shot (trolley) | `poor_fit` | rms 11.2 px against an 8 px threshold, over 3 frames. 3.2 px of headroom. |

The tuning agent chose quorum ≥ 2 over quorum ≥ 1 (24/51 with one false draw vs 21/51
with none) and that was the right call. **This is the single most fragile line in the
change: dropping the quorum to 1 to buy three more full swings puts a drawn arc on a
putt.** It is not a knob to turn without re-running this.

### 4b. I built my own not-a-golf-shot clips, and they refuse too

Nine adversarial clips, none of which the tuning ever saw, each run through the **real
detector at five separate impact hints spread across the clip** — so no refusal can be
credited to a badly-aimed window — and then through the **real ladder twice, `forceTrace`
off and on**. 45 clip/hint pairs, 90 ladder runs.

| clip | what it is | result, `forceTrace` OFF | with `forceTrace` ON |
|---|---|---|---|
| `adv_static_scene` | one real course frame (golfer at address, real ball on the ground) held for 8 s — nothing moves | skip ×5, `no_address_ball` | same |
| `adv_ball_rolls` | that frame + a white ball translating along the grass at constant speed | skip ×5 | same |
| `adv_ball_thrown` | that frame + a white ball on a **true parabola**, no golfer, no club | skip ×5 | same |
| `adv_bird` | that frame + a white ball crossing the sky in a straight line | skip ×5 | same |
| `adv_pan_only` | a slow pan across a 4K course still — no shot at all | **skip ×5** (3 of them `implausible_flight: apex 127.5 m > 48.8 m`) | **DRAWS on 2 of 5** |
| `adv_reversed_swing` | a real full swing played **backwards** — gravity inverted | skip ×5 | same |
| `adv_vflip_swing` | a real full swing **upside down** — the ball falls up | skip ×5 | same |
| `adv_speed4x_swing` | a real full swing at **4× speed** — impossible ball speed | skip ×5 | same |
| `adv_noise` | 6 s of pure random noise | skip ×5 | same |

**With the shipped setting, 0 draws out of 45. Not one.**

**With `forceTrace` on, the camera pan draws an arc.** That is `forceTrace` behaving as
documented — it bypasses *judgements* about a shot (`implausible_flight` is a judgement)
and not absences of evidence — but it is worth Henry knowing in one sentence: **the dev
bypass will draw a trace over a video with no golf shot in it.** It ships `false`
(`constants/config.ts:506`), it is deliberately never rehydrated from the settings table,
and `tests/tracerV3Wiring.test.ts` pins both. Nothing needs doing; it just must not be
left on.

### 4c. I looked at all 32 draws

A grep does not read a photograph. For every clip that drew, I extracted six frames
spanning the detected ball track and marked each detection in red, then read them.
**Every one of the 32 is an unmistakable golf stroke with a ball climbing away from the
club.** Not one is a putt, a walk, a rake or a trolley. Sheets:
`…/scratchpad/verify/drawstrips/DREW_0{0..3}.jpg`.

### 4d. Not one drawn arc states a distance

All 32 pills read exactly `no distance / camera unknown`. **Zero of the 32 contain a
digit.** Every one carries `geometry_unknown(lens=unknown,zoom=unknown)`, which is
structural: an import has no lens or zoom column, so the ladder cannot state a number
even if the fit were perfect. And 0/32 end above the horizon.

Henry's rule — *never a confidently wrong number* — is held absolutely on imports, and it
is held by construction rather than by a threshold.

### 4e. THE ONE REAL FINDING — an arc can be drawn onto a frozen frame

This is not in the tuning agent's report and the bench cannot see it, because
`bench/ladder.ts` does not record the render window.

`buildSpec` measures the draw against the **composed** end of the clip, which includes
the freeze tail (`freezeMaxSec = 6 s`) that exists so a flight outlasting the clip still
*lands* rather than being cut mid-air. That is a good feature — 29 of the 32 draws use it,
because the app's post-roll is 1.5 s and a driver hangs 5-6 s.

But it also means an animation may legally **START** after the last real frame. The
detector may relocate the impact up to 3.5 s; the app's trim window does not move with it
(`planHighlightTrim` runs off the app's own swing detector, before the tracer). So if the
scan moves the impact more than about **1.5 s forward**, the arc begins over a held still
of the golfer mid-backswing and flies off a frozen frame.

**Reproduced on real detections, not just a fixture.** Replaying the cached impact-error
sweep with the window built the way the *app* builds it (around the hint, not around what
the scan derived — the sweep's own `synth_plan` moves the window with the impact and so
hides this):

```
    hint     drew   arcs starting AFTER the footage   max animStart   window
   -3000ms  17/26                17                       5.52 s      4.00 s
   -2000ms  18/26                18                       4.52 s      4.00 s
   -1000ms  16/26                 0                       3.52 s      4.00 s
    -500ms  16/26                 0                       3.02 s      4.00 s
    -250ms  16/26                 0                       2.77 s      4.00 s
        0   17/26                 0                       2.52 s      4.00 s
    +250ms  18/26                 0                       2.27 s      4.00 s
    +500ms  15/26                 0                       2.02 s      4.00 s
   +1000ms  16/26                 0                       1.52 s      4.00 s
   +2000ms  17/26                 0                       0.52 s      4.00 s
   +3000ms   1/26                 0                       0.33 s      4.00 s
```

(A negative hint here means the app fired EARLY. Note the +3000 ms row: 1/26. That is the
*safe* end — 13 of those refuse on `animStartSec … out of range` because the window sits
entirely after the flight. Note also that this table's hit rates are NOT the bench's: the
bench moves the window with the impact, which is the right thing for isolating detection
error and the wrong thing for seeing this.)

**Why it is NOT a live bug, measured rather than assumed.** It needs the app's swing
detector to fire *early* by ≥ 1.5 s. On the 26 clips with a confirmed impact it never
fires more than **0.18 s early**; its error is one-sided *late* (median −0.07 s, max
**+4.09 s**), and the late direction fails safe — `animStartSec` goes negative and the
ladder refuses. **On the real corpus at the app's own impact: 0 of 32 draws start after
the footage.** The largest `animStartSec` seen is 2.69 s in a 4.00 s window.

So: **a latent hazard with a live guard that is not in the code.** The guard is the
happenstance that the app's estimator errs late. Two things would make it live — widening
`scanRadiusMs`, or the app's swing detector starting to fire early.

**The fix, if Henry wants it closed, is one line** in `buildSpec`
(`lib/tracerV3.ts`, beside the existing composed-end check):

```ts
if (!(animStartSec < input.renderDurationSec)) {
  return { spec: null, reason: `render_spec:draw starts after the footage ends`, … };
}
```

**Measured cost of that line on this corpus: zero clips.** None of the 32 draws has
`animStartSec >= renderDurationSec`. I did **not** apply it — `lib/tracerV3.ts` is being
edited by another agent in this shared checkout, and I cannot show a live failure, only a
reachable path. It is a decision, not a repair, and it belongs to whoever owns the file.
A test pinning the current behaviour and its bound is in
`tests/tracerV3DerivedImpact.test.ts` so this cannot drift silently.

---

## 5. Crashes, hangs, and the thing that will actually bite

### 5a. No crashes

**All 121 clips produce a valid detector result and a valid ladder decision.** Across the
whole corpus at hash `85f273d0414b`: **0 detector failures, 0 empty outputs, 0 ladder
throws, 0 clips the app skipped before the detector.** Decisions are exactly
`{fit: 32, none: 89}` — no `detector-failed`, no `error`.

The known crash is gone. **`IMG_0594`** — the 4.47 s clip that died with SIGTRAP when the
search was first widened — runs clean and refuses (`detector_found_no_address_ball`,
36.0 s). So do the other short ones, including a **0.67 s** clip (`IMG_6151`) and a 2.33 s
one (`IMG_0571`).

I also re-ran the detector **cold, with no cache**, on 47 clips before stopping it (see
5c); 44 returned `rc=0`, 3 hit my own 1200 s wall-clock timeout under 7-way load. **None
crashed. None returned a non-zero exit. None returned malformed JSON.**

### 5b. The detector is deterministic — which is what makes the cached bench legitimate

The bench tabulates cached detections, so if the detector varied run to run the whole
measurement would be soft. It does not. Three fresh cold runs of `IMG_3652`, plus the
cached entry the bench actually used:

```
run1     detectionsSHA=7dbffd451290  n=45   noTimingSHA=8406b0add75b
run2     detectionsSHA=7dbffd451290  n=45   noTimingSHA=8406b0add75b
run3     detectionsSHA=7dbffd451290  n=45   noTimingSHA=8406b0add75b
CACHE    detectionsSHA=7dbffd451290  n=45   noTimingSHA=8406b0add75b
```

**Byte-identical.** The only bytes that differ between runs are four wall-clock profiling
fields (`oneOffMsAddress`, `oneOffMsBackground`, `oneOffMsImpactScan`,
`oneOffMsPoseAddress`), which nothing downstream reads. A raw-line hash therefore always
mismatches — that is a trap, not a finding, and it is why the `cacheMatch` column in my
serial log reads `False` everywhere and should be ignored.

### 5c. **The finding: a clip that refuses costs up to eight minutes**

Timed **serially, one process at a time, nothing else running**, so these are the
detector's numbers and not the machine's:

| clip | format | length | detector passes | **wall** | outcome |
|---|---|---|---|---|---|
| `IMG_0523_2` | 2160×3840 @60 | 10.7 s | 20 | **496.0 s** | refuse |
| `IMG_0550_2` | 2160×3840 @60 | 20.1 s | 20 | **464.7 s** | refuse |
| `IMG_0527` | 2160×3840 @60 | 20.5 s | 18 | **410.0 s** | refuse |
| `IMG_0528` | 2160×3840 @60 | 9.4 s | 17 | **406.5 s** | refuse |
| `IMG_0594` | 1080×1920 @30 | 4.5 s | 13 | 36.0 s | refuse |
| `IMG_3652` | 1080×1920 @30 | 9.2 s | **1** | **2.8 s** | **draws** |
| `IMG_0601_2` | 1080×1920 @30 | 11.0 s | **1** | **3.1 s** | **draws** |
| `IMG_3622` | 1080×1920 @30 | 18.2 s | **2** | **5.6 s** | **draws** |

The pattern is completely clean. **A clip that draws costs one or two passes and 3-6
seconds. A clip that does not draw exhausts the scan, falls through to the full
seventeen-offset brute-force ladder, and costs 17-20 passes.** On 4K/60 that is
**seven to eight minutes for a single clip, to conclude that it cannot draw anything.**

Across the whole corpus (the tuning agent's `--jobs 4` run, per-clip times recorded in
`results-app.json`):

```
total detector wall, 121 clips        8 245 s  = 2.29 h   (at 4-way parallelism)
  the 32 clips that DREW                462 s  =  5.6 %   median  6.7 s
  the 89 clips that REFUSED           7 783 s  = 94.4 %   median 57.1 s
```

**74 % of the clips consume 94 % of the time and produce nothing.** The design comment in
`TracerDetectCore.swift` says the brute force is "only paid for by a clip that was going
to draw nothing anyway", which is true and is the right architecture — but the *price* of
that has never been written down, and it is minutes.

**None of this ran on a phone.** A phone runs one clip at a time with no contention, which
helps, and has a slower CPU/ANE and a thermal budget, which does not. I did not measure
it and I will not guess a multiplier. What I can say is that the *shape* — refusals
costing 17-20× what a success costs — is a property of the code, not of this Mac, and it
will be there on a phone too.

`scanFallbackLadder` is a documented, testable off-switch (`{"scanFallbackLadder": false}`
in the options JSON, no rebuild). Turning it off cost 2 of 36 lab clips when the tuning
agent measured it and would remove most of that 94 %. **That is a real trade Henry should
be given, not a decision for an agent** — it is hit rate against minutes per clip.

---

## 6. Reversibility — with `config.tracer.enabled = false`, nothing runs

`constants/config.ts:313` reads `enabled: false as boolean` — the production value, a
plain literal, flipped to `true` at module load for the **development variant only**.

The window scan is reached from exactly one place. `detectShotV3` has a single call site
in the app (`hooks/useEditorState.ts:1559`), inside `processAllTracers`, whose first line
is:

```ts
const processAllTracers = useCallback(async () => {
  if (!config.tracer.enabled || !storage || !roundId) return;
```

So with the flag off the native detector is never called, the Core ML model is never
loaded (`TracerDetect.swift:421` — loading is lazy on purpose), and no scan happens.
Nothing else in the tracer chain is reachable either: the GPS session
(`hooks/useGpsSession.ts:40`), the capture-time optics columns, the editor's tracer gates
(`app/round/editor.tsx:729`), the paywall bullet and the onboarding copy are all ANDed
with the same flag.

Already pinned by tests I did not write and did not need to: *"the tracer batch returns
before touching anything when the flag is off"*, *"the master kill switch is still a plain
literal the claims tests can pin"*, *"the dev-variant flip is fail-closed in both
directions"*, *"under node the tracer reads OFF, which is what makes the off-path
testable"* (`tests/tracerV3Wiring.test.ts`).

There is a **second, finer revert that does not need a rebuild**: the whole window scan
can be turned off from the options JSON with `{"scanEnabled": false}`, which restores
exactly the previous behaviour (trust the hint, then the 17-offset ladder). Pinned by
`tests/tracerV3ImpactScan.test.ts`.

---

## 7. Henry's question, answered in numbers

> *Of the shots I point this at, what fraction will draw a trace?*

**On your own clips: 2 in 5.** 10 of the 25 full swings in your camera roll = **40.0%**.
Counting chips as well, 16 of 37 real shots = **43.2%**.

**On footage nobody has tuned on: fewer than 1 in 5.** 2 of 11 = **18.2%**. That is the
number to believe for a course you have not shot before, and it is the honest forecast.

**The lab clips, which are the ones this was built against: 3 in 5.** 9 of 15 = **60.0%**.

**The ceiling, if the impact were handed to it perfectly: 2 in 3.** 17 of 26 = **65.4%**.
So even with a perfect impact, one full swing in three still draws nothing. The window
scan closed most of the impact problem; what is left is not an impact problem.

### Will it 100% work?

**No.** Not close. Three in five of your full swings will draw nothing at all, and on
unfamiliar footage four in five. It will not be wrong — the refusal side is solid, 0 false
draws in 49 negatives and 0 in 45 adversarial runs, and not one drawn arc states a
distance — but it will be **silent**, often.

The largest single reason is not subtle: **on 18 of the 51 full swings the detector never
found the ball at address at all**, and 16 of those 18 are 1080p/30 clips.

### The one thing that changes the number, and you control it

**Record in 4K/60 instead of 1080p/30.**

| your capture format | full swings that drew |
|---|---|
| 2160×3840 @ 60 | **5 of 8 = 62.5%** |
| 1080×1920 @ 30 | 5 of 16 = 31.2% |

Same across the whole corpus: 9/14 = 64.3% at 4K/60 against 12/36 = 33.3% at 1080p/30.
**It roughly doubles.** A golf ball at address is 4-8 px across in 1080p and the detector
is looking for a disc; at 4K it has four times the pixels. The cost is processing time —
4K/60 is also the slowest format to run (§5).

### The first thing to check on your phone

**Nothing in this report ran on a phone, and the renderer was not exercised at all.**
"Drew" here means the ladder returned a render spec on a Mac. Whether an arc is actually
painted, and whether it sits on the ball, is a separate question this bench cannot answer
— the Swift renderer (`TracerRenderV3.swift`) never ran.

So, in order:

1. **Import `IMG_0601_2` — your own clip, it draws here — and look at whether an arc
   appears and whether it starts on the ball.** That is the one thing no amount of this
   testing substitutes for. If the arc is there and it is on the ball, the bench is
   measuring the right thing. If it is not, everything above is measuring a spec that the
   renderer rejects.
2. **Time it.** On this Mac the detector takes a median of 41 s per clip and up to 10
   minutes on one 4K clip. A phone will not be faster. If a round of 12 clips takes half
   an hour to process, that is a product problem before the hit rate is.
3. **Check `forceTrace` is off** in the tracer dev settings. It ships off and is never
   restored from storage, but with it on the tracer will draw an arc over a video with no
   golf shot in it (§4b).

---

## 8. What I did not check, and what would still fail

Written out because a clean report that hides a gap is worse than a messy one.

**Nothing ran on a phone.** Every number here comes from the shipped Swift compiled for
macOS (`bench/build.sh` → `$BENCH_WORK/tracerdet`) and the shipped TypeScript under node.
Vision and Core ML behave differently on iOS hardware; timings certainly do.

**The renderer was never exercised.** `TracerRenderV3.swift` — 1 866 lines, the thing that
actually paints the arc — did not run once in this verification. **"Drew" means the ladder
returned a render spec, not that an arc was drawn on a frame.** The specs satisfy every
invariant the Swift parser hard-rejects on (I check all five in the new tests), but that
is not the same as having seen one rendered. This is the single largest gap in the whole
verification and it cannot be closed on this machine.

**The impact estimator was not re-measured.** I took `impacts.json` — the app's own
swing-vision output for all 121 clips — as given, from the bench agent's run. The
one-sided-late finding in §4e rests on it.

**The corpus labels are one human's reading of six frames per clip.** 22 of 121 are marked
low-confidence. Excluding them moves the full-swing rate from 21/51 = 41.2 % to
20/47 = 42.6 %, so the uncertainty is not flattering the number, but the labels are not
ground truth.

**The "before" numbers could not be reproduced** — see §3. Corroborated against a
different older detector, not re-derived.

**The cold full-corpus detector re-run was not finished.** I stopped it at 47 of 121 when
seven concurrent detectors drove the machine to a load average of 290 and three clips
blew past a 20-minute wall clock. The crash question is answered from the complete cached
run instead (0 failures in 121), and the timing question from a clean serial pass (§5c),
which is a better measurement anyway.

**The ceiling (65.4 %) is measured on 26 clips that all have a confirmed impact**, and
they have one because a human could find the ball to confirm it. It is a ceiling on a
favourable subset.

### What will still fail, concretely

1. **Three full swings in five, on Henry's own footage, draw nothing.** Mostly
   `detector_found_no_address_ball` — 18 of the 51 full swings, 16 of them 1080p/30.
2. **Four in five on footage nobody tuned on.**
3. **The app's own shot classifier mislabels a lot**: 6 of 51 human full swings are called
   `putt` and refused before the ladder ever sees them; 11 of 36 human putts are called
   `swing`. The ladder catches all 11, but it is doing the classifier's job.
4. **A 4K clip that is going to refuse takes 7-8 minutes of detector work** (§5c).
5. **`IMG_0596_2`, a putt, is one quorum rung away from drawing an arc** (§4a).
6. **The frozen-frame path in §4e** is reachable the moment the app's swing detector
   starts firing early, or `scanRadiusMs` is widened.

---

## 9. Files

Written or changed by this agent:

* `clippar_app/tests/tracerV3DerivedImpact.test.ts` — **new**, 7 executable tests
* `clippar_app/docs/tracer-v3/bench/verifyLadder.ts` — **new**, bench-only; `ladder.ts` plus the render window
* `clippar_app/docs/tracer-v3/bench/advLadder.ts` — **new**, bench-only; the ladder with `forceTrace` off and on
* `clippar_app/docs/tracer-v3/verify-window-scan.md` — this file

Nothing in the app imports either bench file. **No app or module source was modified** —
in particular `lib/tracerV3.ts` and the Swift are untouched, so every number above
describes the tree as the tuning agent left it.

Evidence, outside the repo (scratchpad, not committed):

* `verify-app.json`, `verify-truth.json` — my own bench runs
* `window.json`, `windowprobe.json` — the render-window measurements behind §4e
* `adv/` — the nine adversarial clips, their detections and `adv_results.json`
* `drawstrips/DREW_0{0..3}.jpg` — the visual audit of all 32 draws
* `serial.log` / `cold.log` — the timing and crash passes
