# certify — the certifying gate on `feat/tracer-v3` after round 4

**Agent:** `certify`, 6 Sep 2026. **Branch:** `feat/tracer-v3`, working tree as the fix
agent left it. **Repo:** `clippar_app`.
**Input read in full:** `docs/tracer-v3/final-gate.md`, then `fixes.md` rounds 1-4, then
`review.md`, `re-verify.md` and `gate.md` for their finding lists.
**I trusted none of it.** Every number below is from my own fixtures, my own sweep and my
own run. **I ran no `git` command that writes and no `npm install`.** The only file I added
to the repo is this one; every probe is in this session's scratchpad.

---

# VERDICT

**The class the final gate failed the branch on is closed. A residue is not, and it is
smaller and better-behaved than the thing it replaced — but it is not zero, and on my
geometry it is between two and three times the rate the fix agent measured on theirs.**

| # | Check | Result |
|---|---|---|
| 1 | `npm run verify` — tsc clean, > 847 tests, 0 fail/skip/todo | **PASS** — **860 tests**, 0 fail, 0 skipped, 0 todo, exit 0, run twice, identical |
| 2 | Can this pipeline state a materially wrong distance? | **YES, and here is the number.** **148 of 13 687** stated numbers are more than 25 % from truth (**1.08 %, 1 in 92**); worst **+46.1 %**. On a realistic capture, **20 of 2 780 — 0.72 %, 1 in 139**, worst **+34.3 %** |
| 3 | Refusals, my own no-ball and corrupt inputs, `forceTrace` off AND on | **PASS.** With `forceTrace` off, every absence-of-evidence and every not-a-golf-shot input refuses. With it on, **no non-golf input states a number** — a change from the final gate, where one did. One new LOW finding (**CT-1**) |
| 4 | Reversibility with the flag off, every revert clause | **PASS.** All six clauses true, each read out of the code |
| 5 | Swift `-parse` × 5, `-typecheck` the three together | **PASS** — exit 0 everywhere |
| 6 | Every open finding, classified | Done — §6. **`prior` (F7/GATE-2) is now closed as a source of numbers**, independently |
| 7 | The FG-1 trade-off as a product decision | §7 |

**The one sentence.** FG-1 through FG-5 are genuinely closed and I reproduced each of them
working; what remains is not a class with a mechanism — it is **31 individual geometries on
which the fit converges confidently on the wrong flight**, and I could not find a rule that
removes them without costing several correct numbers for each one it catches, which is the
same conclusion the fix agent reached and I reached it on different data.

**The comparison that matters.** Against the final gate's own pre-fix run:

| | final gate (before round 4) | certify (after round 4) |
|---|---|---|
| numbers more than 25 % from truth | 1 719 of 39 086 — **4.40 %** | 148 of 13 687 — **1.08 %** |
| worst number drawn | **+230 %** (its own worst quoted row +194 %) | **+46.1 %** |
| realistic capture, > 25 % | **2.90 %** | **0.72 %** |
| GPS-backed numbers > 25 % | 180 of 13 959 — 1.29 % | 29 of 4 992 — **0.58 %** |
| the `prior` rung | 701 of 993 of its numbers > 25 % out | **0 numbers drawn in 5 184 calls** |

Different geometry on both sides, so these are two independent measurements of the same
pipeline, not a before/after on one. **The direction and the size of the move are real. The
absolute floor is not zero.**

---

# 1. `npm run verify` — PASS

```
> tsc --noEmit                          # no output — clean
> node --import tsx --test tests/*.test.ts
ℹ tests 860     ℹ pass 860     ℹ fail 0
ℹ skipped 0     ℹ todo 0       EXIT=0
```

**860 tests, 0 failures, 0 skipped, 0 todo, tsc clean, exit 0.** Floor was 847, so **+13**.
Run end to end twice, identical both times (49 s each).

Nothing parked, checked rather than taken from `fixes.md`:

```
$ grep -rnE "\.skip\(|\.todo\(|\.only\(|xit\(|xtest\(|\bskip: *true|\btodo: *true" tests/
$                                       # exit 1 — no matches
$ ls tests/*.test.ts | wc -l
      62                                # unchanged
```

Per-file counts match round 4's table: `tracerFit` 30, `tracerV3Refusals` 48,
`tracerV3Wiring` 34.

> **One thing the seat must do before any build.**
> `tests/fixtures/tracerV3AxisFallback.ts` and `tests/fixtures/tracerV3DroppedFrames.ts`
> are **untracked**. Three tests in `tests/tracerV3Refusals.test.ts` import them, so a fresh
> clone is red and the FG-1 and FG-3 reproductions are not in the repo.
> **`git add` them BY NAME.** `git add -A` is not safe in this tree — seven unrelated
> untracked paths predate this work.

---

# 2. The sweep — 58 500 `traceClip` calls, 0 threw

## 2a. My fixtures

Six cameras of my own, sharing no constant with the **five** now in `tests/fixtures/` and
none with the final gate's own six:

| | width × height | FOV (landscape) |
|---|---|---|
| cam A | 1152 × 2048 | 65° |
| cam B | 960 × 1706 | 59° |
| cam C | 1242 × 2688 | 75° |
| cam D | 828 × 1792 | 71° |
| cam E | 1536 × 2732 | 60° |
| cam F | 1179 × 2556 | 63° |

Camera pitch (0.4–16°), camera height (1.02–2.00 m), ball position (x 1.2–6.5 m,
y ±3.5 m) and the sub-frame impact offset are sampled **continuously per geometry**, so
they coincide with no committed constant at all rather than merely differing from them.
`K_IMPACT = 63` (the fixtures use 100 / 50 / 40). **The only constants I share with any
fixture are the frame rates 30 and 60**, which the brief requires for the realistic-capture
narrowing and which are a property of the phone, not of a fixture.

**Smoke test first, so a failure below is the ladder's and not my fixture's.** A clean
20-frame flight, pixel-only, on each camera — truth carry 221.0 m:

```
cam A 1152x2048@60  ->  "230 m" / "apex 47 m · no GPS"   fitted 228.3  rms 1.70
cam B  960x1706@60  ->  "220 m" / "apex 31 m · no GPS"   fitted 221.0  rms 0.02
cam C 1242x2688@60  ->  "220 m" / "apex 32 m · no GPS"   fitted 221.5  rms 0.02
cam D  828x1792@60  ->  "220 m" / "apex 31 m · no GPS"   fitted 221.0  rms 0.01
cam E 1536x2732@60  ->  "220 m" / "apex 32 m · no GPS"   fitted 221.5  rms 0.03
cam F 1179x2556@60  ->  "220 m" / "apex 31 m · no GPS"   fitted 221.1  rms 0.01
```

All six recover the flight they were given. **Camera A is worth naming rather than
skipping past:** its carry is 3.3 % high and its *apex* is 47 m against a 31.4 m truth —
a 50 % apex error at rms 1.70 px, on a clean 20-frame track. The pill states only the carry,
so nobody sees it. That shape — carry roughly right, apex badly wrong — recurs throughout
this report and nothing in the pipeline tests it.

## 2b. The sweep itself

**4 500 geometries × 13 GPS readings = 58 500 `traceClip` calls, 0 threw.** Ten shards,
one seeded PRNG per geometry (`mulberry32(0x5eed + gid · 2246822519)`), so any row
regenerates from its `gid` alone. Every parameter moves independently:

- **camera** one of the six · **fps** {24, 30, 60, 120}
- **detections** 3–20 · **start** 1–3 frames after impact · **stride** 1 or 2 (28 % dropped-frame tracks)
- **sub-frame impact offset** uniform [0, 1)
- **launch angle** — half forced into the flat **8–14°** band, half uniform 5–50°
- **ball speed** 16–82 m/s, correlated with launch the way a bag is
- **azimuth** 0.0–12°, with 10 % under 0.6° to reach the axis-degenerate case
- **back spin** 1 200–9 000 rpm, **side spin** ±1 500 rpm · **confidence** 0.30–0.95
- **GPS** — `null`, plus 6 drawn from the absolute ladder {5, 10, 20, 35, 50, 80, 110, 150,
  200, 260, 320, 400, 500} m and 6 from truth-relative multiples {0.3, 0.5, 0.7, 0.85,
  0.95, 1.0, 1.05, 1.15, 1.4, 2.0, 3.0}×
- **`carrySigmaGpsM`** supplied on 35 % of calls, 2–15 m

## 2c. The result

```
decision    {"none":33962,"fit":14029,"pixel_only_fallback":10509,"prior":0}
carryStatus {"(none)":36098,"carry_as_scale":10203,"carry_consistent":6502,
             "carry_tension":3839,"carry_untested":1161,"carry_inconsistent":697}
labelKind   {"SKIP":33962,"number":13687,
             "no distance / GPS unchecked":5600,
             "no distance / not enough of the flight":4331,
             "down the line":920}

clips that DRAW an arc      24538   (41.9 % of calls)
  ... with a NUMBER on it   13687   (55.8 % of arcs; GPS-backed 4992)
  ... "no distance"          9931
  ... "down the line"         920
SKIPS                       33962   (track_not_ballistic 20730, implausible_flight 10703,
                                     poor_fit 2503, not_a_flight 26)

NUMBERS more than 25 % from truth: 148  = 1.081 %   (GPS-backed 29)   worst +46.1 %
NUMBERS more than 15 % from truth: 709  = 5.180 %   (GPS-backed 280)
```

**By decision path:**

| path | numbers drawn | > 25 % | > 15 % | worst |
|---|---|---|---|---|
| `fit` | 6 253 | **43 — 0.69 %** | 340 — 5.44 % | +46.1 % |
| `pixel_only_fallback` | 7 434 | **105 — 1.41 %** | 369 — 4.96 % | +46.1 % |
| `prior` | **0** | — | — | — |

**By provenance:**

| | numbers | > 25 % | worst |
|---|---|---|---|
| GPS-backed (no "· no GPS" marker) | 4 992 | **29 — 0.58 %** | +44.1 % |
| no GPS supplied at all | 1 261 | **14 — 1.11 %** | +46.1 % |
| `decision = fit`, GPS rejected upstream | **0** — this path no longer states a number at all | — | — |
| `pixel_only_fallback` | 7 434 | **105 — 1.41 %** | +46.1 % |

**The GPS-backed path is now the safest in the ladder and the pixel-only fallback is the
worst — the same ordering the final gate found, at a third the rate.** The gate's headline
concern, that the fixes were all pointed at the GPS while the damage was pixel-only, is
still directionally true and is now much smaller.

## 2d. Narrowed to a realistic capture — this is the number Henry cares about

Cumulative, exactly as the brief specifies:

| filter | calls | numbers | > 25 % | > 15 % | GPS-backed > 25 % | worst |
|---|---|---|---|---|---|---|
| everything swept | 58 500 | 13 687 | 148 — 1.081 % | 709 — 5.18 % | 29 / 4 992 | +46.1 % |
| width ≥ 1080 | 38 961 | 9 074 | 107 — 1.179 % | 473 — 5.21 % | 19 / 3 269 | +46.1 % |
| … AND fps ∈ {30, 60} | 19 422 | 4 693 | 41 — 0.874 % | 242 — 5.16 % | 11 / 1 682 | −36.8 % |
| … AND ≥ 8 detections | 14 144 | 3 575 | 29 — 0.811 % | 164 — 4.59 % | 5 / 1 239 | −36.8 % |
| **… AND azimuth ≥ 1.5°** | **11 466** | **2 780** | **20 — 0.719 %** | **133 — 4.78 %** | **3 / 951** | **+34.3 %** |

**On a capture the app can actually produce, about 1 stated number in 139 is more than a
quarter wrong, and the worst is +34 %.** Henry's rule is "never". 1 in 139 is not never.

Two slices inside that, because they change the answer a lot:

```
realistic + NO GPS at all         255 numbers   1 over 25 %  (1 in 255)   worst +31.0 %
realistic + GPS within +-5 %      290 numbers   0 over 25 %                worst +19.8 %
realistic + GPS off by >= 30 %   1723 numbers  18 over 25 %  (1 in 96)     worst +34.3 %
```

**A correct GPS reading makes the number materially safer; a badly wrong one is where the
residue lives.** That is the opposite of the pre-round-4 picture and it is the strongest
single argument that rounds 1-4 did the right work.

Accuracy of the numbers that *are* stated:

| | n | median \|err\| | p90 | p99 | max |
|---|---|---|---|---|---|
| everything swept | 13 687 | 2.0 % | 10.8 % | 25.4 % | 46.1 % |
| realistic capture | 2 780 | 1.6 % | 8.8 % | 23.7 % | 34.3 % |
| realistic + GPS within ±5 % | 290 | 1.6 % | 5.6 % | 17.3 % | **19.8 %** |
| GPS-backed only | 4 992 | 2.2 % | 11.5 % | 22.5 % | 44.1 % |

## 2e. The worst offender, regenerated from its seed

**Not typed back from a log.** The final gate's §2f warning is real — an ill-conditioned
fit is chaotic, so a re-typed 2-dp row does not reproduce. This is `geometry(120)` run
through the generator and nothing else:

```
gid 120   1536x2732 @120 fps (cam E)   pitch 6.242°   camera 1.060 m   FOV 60°
          ball (5.519, 2.239)   sub-frame 0.9713
          13 detections, stride 1, starting 1 frame after impact, conf 0.73
          v0 82.000 m/s   theta 5.875°   phi 4.050°   rpmBack 1226   rpmSide -1433
    TRUTH  carry 177.98 m   apex 7.47 m   hang 3.32 s

  gps=null  dec=fit                  "260 m" / "apex 39 m · no GPS"      +46.1 %
  gps=110   dec=pixel_only_fallback  "260 m" / "apex 39 m · no GPS"      +46.1 %
  gps=5/20/50/88.99  same, +46.1 %
        k=13  apexSeen=FALSE  rms 2.677 px  (= 1.882 px @1080)
        sigma(carry) 29.6 m = 11.2 % of the drawn 264.3 m
        sigma(v0)/v0  DRAWN 2.3 %   worst ladder rung 19.5 %
        fitted carry 264.3 m, fitted apex 39.2 m  (truth apex 7.5 m)
        flags: fpx_is_prior(+-12%_on_v0) | arc_end:fitted
```

**All three of FG-1's tests pass, comfortably.** 2.3 % against a 5 % bar; 1.88 px against a
2 px bar; 11.2 % against a 25 % bar. A 178 m screamer is drawn as a 264 m towering drive,
apex 39 m against a real 7.5 m, and the pill states it to the nearest 10 metres. The fit is
**tight and wrong**, which is review F4's disease with no azimuth degeneracy to explain it.

The same geometry at `gps=200` — a reading only 12 % from truth — comes back
`carry_as_scale` and correctly withholds. **On this clip the ladder refuses the good GPS
reading and states the bad pixel answer.**

## 2f. The residue is 31 geometries, and it is not a class

The 148 rows sit on **31 distinct geometries**. Every one of them is a flat or moderate
launch on a track that never reaches the apex. **All 148 have `throughApex === false`**,
which independently reproduces the final gate's strongest single fact on different data —
and it is as unusable as a rule as the gate said, because 12 018 of the 12 153 *correct*
numbers also have `throughApex === false`.

Second worst, and the one that matters more because it is **GPS-backed**:

```
gid 1288   960x1706 @120 (cam B)   pitch 12.923°   camera 1.571 m   FOV 59°
           20 detections, v0 58.152, theta 9.415°, phi 11.789°
    TRUTH  carry 124.94 m   apex 6.95 m
  gps=null  dec=fit  "180 m" / "apex 15 m · no GPS"        +44.1 %
  gps=200   dec=fit  "180 m" / "apex 16 m"                 +44.1 %   <- NO "no GPS" marker
            carryStatus=carry_consistent  z=-0.26  zNoPixelSigma=-0.36
            rms 0.49 px@1080   sigma(v0)/v0 3.9 %   sigma 19.7 % of drawn
```

**rms 0.49 px.** The fit is a near-perfect fit to a completely different flight, and a GPS
reading that is 60 % too long agrees with it, so the verdict is `carry_consistent` and the
"· no GPS" marker comes off. Nothing in this pipeline can see that.

### I looked for a rule and there is not one — measured, not asserted

Every candidate applied **on top of the three tests that already ship**, i.e. only to the
13 687 numbers that already survived them:

| additional rule | withholds | catches (of 148) | loses correct (of 12 153) | remaining | worst kept |
|---|---|---|---|---|---|
| *nothing — what ships today* | 0 | 0 | 0 | **148** | 46.1 % |
| worst-rung σ(v0)/v0 ≥ 5 % (FG-1 test 1 **+ the ladder term**) | 4.8 % | 24 | 474 (3.9 %) | 124 | **46.1 %** |
| worst-rung σ(v0)/v0 ≥ 10 % (F4's bar) | 1.8 % | 12 | 157 (1.3 %) | 136 | 46.1 % |
| rms > 1.5 px @1080 | 2.1 % | 14 | 170 (1.4 %) | 134 | 44.1 % |
| rms > 1.0 px @1080 | 5.1 % | 49 | 408 (3.4 %) | 99 | 44.1 % |
| σ(carry) > 20 % of drawn | 14.0 % | 58 | 1 386 (11.4 %) | 90 | 46.1 % |
| σ(carry) > 15 % of drawn | 51.3 % | 125 | 5 820 (**47.9 %**) | 23 | 46.1 % |
| K < 8 | 27.8 % | 48 | 3 134 (25.8 %) | 100 | 46.1 % |
| **track did not reach the image apex** | **98.9 %** | **148 / 148** | **98.9 %** | **0** | −11.8 % |

**I expected the ladder term to be the answer and the data says it is not.** gid 120's
no-GPS row does report a 19.5 % worst rung — but the *same* +46.1 % number is drawn on four
other GPS readings of the same clip whose worst rung is 4.7–11.6 %, so putting the ladder
term back catches 24 rows, costs 474 correct ones (20 correct lost per wrong one caught),
and **leaves the worst case exactly where it was**. The fix agent's deliberate choice of
`drawnV0RelSigma` alone is correct and I could not improve on it.

**70 of the 148 are nowhere near any of the three shipped tests** (σ(v0)/v0 < 4 %, rms
≤ 1.5 px, σ ≤ 20 % of carry). They are not "the rule is slightly too loose". They are fits
that are internally excellent and externally wrong.

## 2g. The controls — the fix did not buy safety by turning the feature off

```
GPS within +-5 % of truth — 5626 calls
  drew an arc 2571 (45.7 %)   stated a number 1464   of those GPS-BACKED 1463 (99.9 %)
  of the numbers stated, >15 % out: 14   >25 %: 2
GPS at <=0.7x or >=1.4x truth — 34468 calls
  numbers 7857, of which GPS-BACKED only 437; GPS-backed >25 % out: 16
```

A correct reading is used, labelled as GPS-backed, and right. **The two >25 % rows on a
correct GPS reading are both `gid 3843` at gps ≈ truth** — the pixels were wrong and the
GPS could not rescue them, which is the honest limit of the design.

## 2h. Every finding's fix, confirmed live in my own data

| finding | the observable it predicts | measured |
|---|---|---|
| **review F5** — a fallback must never claim GPS backing | 0 `pixel_only_fallback` rows GPS-backed | **0 of 7 434** |
| **review F1** — `carry_inconsistent` reaches the decision | 0 GPS-backed numbers on that verdict | **0 of 697** |
| **gate NEW-1** — `carry_as_scale` cannot launder | ~0 GPS-backed numbers | **1 of 10 203** |
| **gate GATE-1** — `carry_tension` cannot launder | ~0 GPS-backed numbers | **42 of 3 839** (all short shots — §6, CT-3) |
| **FG-2** — `carry_untested` is a STATUS | the status exists at all | **1 161 rows**; the flag fires on 2 057, and `z === zNoPixelSigma` **exactly** on 2 053 of them (99.8 %) — the mechanism, reproduced |
| **FG-3** — `axis_degenerate` survives the fallback | "down the line" on `pixel_only_fallback` | **416 of 920** — these could not fire before FG-3. `meta.conditioning` present on **24 538 of 24 538** drawn clips |
| **FG-1(c)** — `pickPixelOnly` takes the best companion | the flag appears | **8 843 rows moved**; of the 1 281 that stated a number, 35 (2.7 %) > 25 % out — a **higher** rate than the 1.08 % average, because these are the ill-conditioned ladders. Net still positive |
| **F7 / GATE-2** — the `prior` rung | 0 numbers | **0 numbers in 5 184 dedicated calls** (§6) |

---

# 3. Refusals — 44 inputs × `forceTrace` OFF and ON = 88 calls

All on my camera F, truth carry 211.9 m.

**With `forceTrace` OFF, every absence of evidence refuses:** detector found nothing, null
address, 0 / 1 / 2 detections (with and without a GPS carry), no camera pitch, fps 0,
width 0, height 0, unknown lens, omitted `capture`, 0.5× lens, pinch zoom 0.42, null
lens/zoom, `fPx` NaN / negative / Infinity, `shotType: 'putt'`.

**With `forceTrace` OFF, every not-a-golf-shot refuses:** static blob (3 and 14 frames,
with and without a 180 m GPS carry), all detections on one pixel (20 frames), pure noise
(12 and 20 frames, with and without GPS), a ball that only falls, a divot (10 and 30
frames, with and without GPS), a rolling putt classified as a swing, a topped ball.

**With `forceTrace` ON — and this is a real improvement on the final gate — every one of
those non-golf inputs draws an arc but states NO number:**

```
static blob 14 frames        -> "down the line" / "no distance"
all on one pixel, 20 frames  -> "down the line" / "no distance"
pure noise 12 frames         -> "no distance" / "not enough of the flight"
divot 10 frames + 180 m GPS  -> "no distance" / "not enough of the flight"
rolling putt (24 frames)     -> "no distance" / "not enough of the flight"
topped ball                  -> "no distance" / "not enough of the flight"
```

The final gate's FG-4 row — "one usable pixel, and the pill says 70 m for a 195 m shot" —
does not reproduce:

```
NaN x on 5 of 14      -> "210 m" / "apex 33 m · no GPS"   k=9  nNonFinite=5   CORRECT
NaN x on 13 of 14     -> SKIP  too_few_detections_no_carry(1)      <- FG-4 closed
NaN x on 13 of 14 + GPS, forceTrace ON -> arc, "no distance" / "not enough of the flight"
Infinity y on 13 of 14 -> SKIP  too_few_detections_no_carry(1)
NaN / -Infinity on ALL -> SKIP  no_detections
```

**Two things that draw and should be on the record, neither of them new:**

- **`all conf 0` states a number** under both settings, and with a GPS carry it states a
  GPS-backed one. That is **review F14**, re-confirmed on a fifth geometry. The number is
  *right* here only because my conf-0 detections are a real flight; the ladder is not
  discriminating, it is just not being lied to. The discrimination lives upstream in Swift
  (`confMean >= confFloor`, `TracerDetectCore.swift:2263`).
- **`shotType: 'putt'` with `forceTrace` ON states a number.** By design — `forceTrace`
  exists to bypass the classifier for street tests — but it means the dev bypass can put a
  distance on a putt.

**`finiteDetections` filters `frame`, `x`, `y` and nothing else, and that is the correct
scope** — I checked what the fit actually reads. `trackForFit` uses `frame`, `x`, `y` and
`conf` only as the boolean `conf >= 0.4` (NaN → false → downweight, the safe direction);
`r` and `t` are read by nothing in the fit path. A NaN radius, NaN conf or NaN `t` all draw
the correct number, which is right rather than lucky.

---

# 4. Reversibility with the flag off — PASS, all six clauses true

`config.tracer.enabled === false` under node, so §2 and §3 are the flag-off run rather than
a claim about it. `config.tracer.v3.forceTrace === false` at boot.

| clause | how I checked it | verdict |
|---|---|---|
| "no GPS session" | `hooks/useGpsSession.ts:40` `isActive = enabled && config.tracer.enabled && …`; `startWatch`'s first line is `if (!isActive) return;` (`:75`) | **true** |
| "no detection, no render" | **every** `detectShotV3` / `traceClip` / `renderTracerV3` call in `app`, `hooks`, `lib`, `components`, `constants`, `modules` is at `hooks/useEditorState.ts:1551 / 1554 / 1591`, inside `processAllTracers`, whose first line is `if (!config.tracer.enabled \|\| !storage \|\| !roundId) return;` (`:1326`). No other call site exists | **true** |
| "no UI reachable by tapping" | `{isDevVariant() && config.tracer.enabled && (…)}` (`app/(tabs)/profile.tsx:840`) | **true** |
| no permission prompt | all five `Location.*` calls (`:82`, `:92`, `:105`, `:168`, `:183`) are below an `isActive` guard or inside `startWatch`; `AppState.addEventListener` (`:186`) behind `if (!isActive) return` (`:179`); `setInterval` (`:193`) behind the guard at `:192` | **true** |
| 1. route registered, unguarded | `app/profile/tracer-dev-settings.tsx` is a route file with no `config.tracer.enabled` guard and no `Redirect` | **true, and inert** |
| 2. schema migration flag-independent | `lib/storage.ts` — the tracer `ALTER TABLE` statements sit in the one ungated `migrateEditorColumns` list | **true** |
| 3. `capture_lens` / `capture_zoom` WRITTEN non-null | `if (tracerV3Gps) {` opens at `hooks/useCamera.ts:616` and **closes at `:635`**; the two binds are at `:665-666`, outside it. `app/(tabs)/record.tsx:354` supplies `getCaptureOptics` unconditionally. `captureOptics` itself is read at `:603`/`:608`, also outside | **true** |
| 4. one focus subscription + one state object | `useFocusEffect` registered unconditionally with a gated body (`:160`); one `useState<GpsHealth>` (`:42`) | **true** |
| 5. `gpsSession` module singleton | `lib/gpsSession.ts:623` constructs it on import; the file contains **no `expo-location` import at all** | **true, and inert** |
| 6. native payload in every binary | `modules/shot-detector/ios/ShotDetector.podspec:21` lists `CoreML` in `s.frameworks`, `:27` lists `GolfBallDetector.mlpackage` in `s.resource_bundles`; `ShotDetectorModule.swift:253` and `:269` register the two `AsyncFunction`s | **true** |

**FG-5 is closed.** `lib/storage.ts:165-172` now says the columns are *"NOT null on a
tracer-disabled build"*, names both other files, and points at `constants/config.ts` item 3
as canonical.

**`forceTrace` is unreachable with the flag off.** Its only read sites are inside
`traceClip` and at `hooks/useEditorState.ts:1453`, below `processAllTracers`'s guard.

**Review F3 is closed and I verified it against the object store, not the report.**
`weight.bin` is 6 070 368 bytes in `HEAD` and 6 070 368 on disk; `model.mlmodel` 116 286
and 116 286; `git diff HEAD` on the package is empty.

**Not pressed on a device.** Source and source-text only, as for every round before this one.

---

# 5. Swift — PASS

`SDK = …/iPhoneOS26.5.sdk`, target `arm64-apple-ios15.0`. No `pod install` in this
checkout, so **nothing was compiled into an app and nothing ran.**

```
swiftc -parse  ShotDetectorModule.swift   exit=0
swiftc -parse  ShotTracer.swift           exit=0
swiftc -parse  TracerDetect.swift         exit=0
swiftc -parse  TracerDetectCore.swift     exit=0
swiftc -parse  TracerRenderV3.swift       exit=0

swiftc -typecheck TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift
exit=0, zero bytes of output

singly:  TracerDetectCore   exit=0
         TracerRenderV3     exit=0
         TracerDetect       exit=1  "cannot find 'TracerParams' in scope"   (the file split)
         ShotDetectorModule exit=1  "no such module 'ExpoModulesCore'"      (missing pods)
         ShotTracer         exit=1  "no such module 'ExpoModulesCore'"      (missing pods)
```

Reproduces `final-gate.md` §5, `re-verify.md` §4 and `gate.md` §7 exactly.

**What "clean" does NOT mean:** no file was compiled to object code, linked, signed,
installed or run. Expo's `AsyncFunction` marshalling, Core ML loading, the `.mlpackage` →
`.mlmodelc` compile-and-cache, every Vision call and every AVFoundation export path are
entirely unverified.

---

# 6. Every open finding, and what it can now produce

| finding | state | wrong **number**? | wrong **arc**? |
|---|---|---|---|
| **review F1** — GPS laundering via the refit | **closed.** 0 GPS-backed numbers on 697 `carry_inconsistent` rows | no | no |
| **review F2** — dropped `impact_slack_frames` | **closed** | no | no |
| **review F3** — Core ML model not in git | **CLOSED.** Byte-identical in `HEAD` | — | — |
| **review F3a** — lens/zoom rescale | **closed.** Every non-1×/pinched/unknown input refuses under both `forceTrace` settings | no | no |
| **review F4** — axis-degenerate geometry | **closed, and extended by FG-3.** 920 refusals, 416 of them on the fallback path that could not fire before | **no** | **YES, by design** — the arc is still drawn down the axis, with no number |
| **review F5** — pixel-only claiming GPS backing | **closed.** 0 of 7 434 | no | no |
| **review F6** — persisted bypass re-armed | **closed for V3** (no settings key read); survives for **v1** → FG-6 | no | **YES**, v1 engine only |
| **review F7 / gate GATE-2** — the `prior` rung | **CLOSED as a source of numbers.** My own 5 184-call sweep at K = 1 and 2 across every GPS reading: 1 774 rungs reached, **0 numbers drawn**, 3 765 "no distance", 424 "down the line". The gate measured 701 of 993 > 25 %. Still unreachable in the app (`detectMinTrackEmit >= 3`, machine-checked at `tests/tracerV3Refusals.test.ts:125`) — keep that test | **NO** | **YES if reached** — a direction from one pixel |
| **review F8** — `landing_depression_off` | **closed** | no | no |
| **review F9 / F10 / F11 / F12** — route, migration, singleton, +5.9 MB | open **by design**, all four disclosed and verified inert (§4) | no | no |
| **review F13** — `carryBetween` uses the module default config | **open.** `hooks/useEditorState.ts:1533` still omits the third argument. **It cannot matter:** `:1574` passes `carry.sigmaGpsM`, not `carry.sigmaM`, and only `sigmaM` depends on that config | no | no |
| **review F14** — the ladder cannot tell a divot or a conf-0 track from a golf shot | **open, informational, and narrower than it was.** In my run every divot / putt / topped / noise input refuses with `forceTrace` off, and states no number with it on. **Only the conf-0 class still states a number** | **YES** on non-golf input | **YES** |
| **gate NEW-1** — `carry_as_scale` laundering | **closed.** 1 GPS-backed number in 10 203 rows (a short shot, §CT-3) | no | no |
| **gate NEW-2** — pinch zoom zeroed after the stop press | **closed** in source; **not pressed on a device** | no | no |
| **gate NEW-3 / GATE-3 / FG-5** — the revert comment | **closed in all three files.** Six items, all true (§4) | no | no |
| **gate GATE-1** — `carry_tension` laundering | **closed as a class.** 42 GPS-backed numbers of 3 839 `carry_tension` rows, every one a shot under ~50 m (§CT-3) | **marginally — see CT-3** | no |
| **FG-1** — the pill states a distance whatever its sigma | **closed as a CLASS; a residue of 31 geometries is not.** 148 of 13 687, 1.08 %, worst +46.1 % | **YES — 1 in 92; 1 in 139 on a realistic capture** | no — the arc is fine |
| **FG-2** — `carry_untested` was a flag not a status | **closed.** 1 161 rows now carry the status; mechanism reproduced on 2 053 of 2 057 flagged rows | no (but see **CT-2**) | no |
| **FG-3** — `axis_degenerate` lost on the fallback | **closed.** 416 refusals on the fallback path; `meta.conditioning` on every drawn clip | no | no |
| **FG-4** — non-finite detections counted by `MIN_FIT` | **closed in the ladder** (see **CT-1** for a fourth read the fix missed). Still not demonstrated reachable from Swift | no | see **CT-1** |
| **FG-6** — the v1 bypass re-arms across restarts | **open**, untouched by design | no (v1 has no V3 label) | **YES**, v1 only |

## My own findings

### CT-1 — LOW · `decideArcEnd` reads the RAW detections array, so FG-4's stated scope is wrong

`fixes.md` round 4 says *"every read of `det.detections` in the module goes through
`finiteDetections`"*. There are four reads and this is the fourth:

```
lib/tracerV3.ts:673   finiteDetections  — the helper itself
lib/tracerV3.ts:679   selectDetections  — computes both, correctly
lib/tracerV3.ts:975   decideArcEnd      — const dets = [...(det.detections ?? [])]   <- RAW
lib/tracerV3.ts:1600  meta.nDetections  — deliberate, documented
```

Reproduced on a 92-detection flight tracked to the ground (my camera D, 828 × 1792 @ 30):

```
clean                      arcEnd=seen   endAt=3.076  animDur=3.076  samples=371
   "last detection f155 is 0.04 s / 13 px from the fitted landing"
last detection x = NaN     arcEnd=fitted endAt=null   animDur=3.102  samples=374
   "through the apex but the ball was lost 0.04 s / NaN px before the fitted landing"
```

**It cannot produce a wrong number.** It flips the arc-end decision from `seen` to `fitted`,
which lengthens the drawn arc by the gap between the last seen detection and the fitted
landing — 26 ms here, and bounded by the same behaviour every not-through-apex clip already
gets. It also prints `NaN px` into a diagnostic string a field test is read from. Worth one
line of code; **not worth blocking a build.** The reason to raise it is the sentence, not
the behaviour: a comment that claims exhaustiveness and is not is exactly how NEW-3 / GATE-3
/ FG-5 happened four times to a different comment.

### CT-2 — LOW · the label's honest sigma is sized from the companion the verdict declined to use

`lib/tracerFit.ts:1393` — `scUsable = scPx != null && Number.isFinite(scPx) && (pixelOnly?.ok ?? false)`.
So a companion with a **finite** carry sigma but `ok === false` is declared unusable, `sc = 0`
is substituted, and FG-2 correctly returns `carry_untested`.

`lib/tracerV3.ts` then sizes the honest label sigma as
`pxCarrySigmaM = pxCompanion?.summarySigma.carryM` — **with no `.ok` check**. It reads back
the very sigma the verdict had just set aside.

Measured: **22 GPS-backed numbers survive on a `carry_untested` verdict**, every one a shot
of 30–47 m where the resulting sigma lands at 7.8–10.0 m, under `COARSEST_LABEL_STEP_M`.
Worst is **−19.1 %** (a 37.1 m shot drawn "30 m"). All 22 are `decision = fit` with no
implausible refit, so `usedFit.pixelOnly === fit.pixelOnly` — which establishes by
elimination that the companion is non-null with a finite sigma and `ok === false`. I did not
instrument `pixelOnly.ok` directly; my attempt to call `fitLaunch` standalone failed on its
signature and I did not pursue it.

**No row over 25 %. It is the same disease at one remove** — "sizing a claim with a sigma
the evidence has already discredited", which is round 3's own sentence.

### CT-3 — LOW-MEDIUM · the unconfirmed-GPS escape hatch is an ABSOLUTE 10 m, so a short shot escapes at a large relative error

`gpsUncheckedNoDistance` fires when the honest sigma exceeds `COARSEST_LABEL_STEP_M = 10`.
On a 250 m drive that is 4 %; on a 31 m chip it is 32 %. **65 GPS-backed numbers are stated
on an unconfirmed verdict** (42 `carry_tension`, 22 `carry_untested`, 1 `carry_as_scale`),
every one of them a shot under ~50 m, and **2 of them are more than 25 % out**:

```
gid 667  1179x2556@30  k=4  theta 45.4°   TRUTH carry 31.5 m
  gps=50    carry_consistent  "40 m" / "apex 6 m"   +27.0 %
  gps=20    carry_tension     "40 m" / "apex 6 m"   +27.0 %   <- unconfirmed, stated anyway
        sigma 24.1 % of drawn  (FG-1 test 3 needs > 25 %)   rms 0.88 px   sigma(v0)/v0 4.6 %
```

FG-1's test 3 is relative (25 %) and misses it by a whisker; round 2's rule is absolute
(10 m) and lets it through by construction. **This is small — 2 rows in 58 500 — and it is
the one place where the two rules' different units leave a seam.** Fixing it means making
round 2's threshold relative too, which is a product decision about short shots, not a bug.

### CT-4 — INFORMATIONAL, and the most important thing in this report · the ladder detects DISAGREEMENT, not ERROR

Of the **29 GPS-backed numbers more than 25 % from truth**:

- **19 of 29 have a GPS reading within 15 % of the *drawn* (wrong) carry.** The consistency
  test did exactly what it was built to do — confirmed that two independent estimates agree
  — and both were wrong together.
- Only **5 of 29** had a GPS reading itself within ±15 % of truth.
- **27 of 29 are `carry_consistent`**, and their z-scores are small and honest: −0.26, 0.43,
  −0.36, 1.05, −0.08…

There is no fix for this inside the carry ladder, and none of rounds 1-4 could have found it,
because every one of them was about a *disagreement* being ignored. **A wrong GPS reading
that happens to sit near a wrong pixel fit is confirmation.** My GPS ladder is adversarial —
12 of 13 readings per geometry are deliberately wrong — so 19-of-29 co-agreement is inflated
relative to the field. The 5 rows where the GPS was right and the answer was still wrong are
not inflated, and they are the ceiling on what this design can buy.

### CT-5 — INFORMATIONAL · the rounding vocabulary now carries no information

**13 617 of the 13 687 stated numbers use the 10 m step**; 70 use 5 m; none uses 1 m. The
step is pinned at the coarsest value the vocabulary has for 99.5 % of numbers. FG-1's rung
is doing all of the work and `roundLabelM` is doing none of it. That is not a defect — it is
the honest consequence of the sigma being what it is — but anyone reading `labelStepM` in a
field row should know it is a constant, not a signal.

---

# 7. The FG-1 trade-off, judged as a product decision

## How often does the feature now state a distance?

Per 100 clips that reach the ladder, on my sweep:

| | skip | arc + a number | arc, "not enough of the flight" | arc, "GPS unchecked" | arc, "down the line" |
|---|---|---|---|---|---|
| everything swept | 58.1 | **23.4** | 7.4 | 9.6 | 1.6 |
| no GPS supplied | 60.9 | **28.0** | 9.7 | 0.0 | 1.4 |
| GPS within ±5 % of truth | 54.3 | **26.0** | 5.6 | 12.6 | 1.5 |
| realistic capture, all | 58.0 | **24.2** | 7.1 | 10.2 | 0.4 |
| realistic, no GPS | 61.2 | **28.9** | 9.4 | 0.0 | 0.5 |
| realistic, GPS within ±5 % | 52.3 | **26.8** | 5.5 | 15.0 | 0.5 |

Of the clips that **draw an arc at all**, the number survives on:

```
everything swept            55.8 %
no GPS supplied             71.7 %
GPS within +-5 % of truth   56.9 %
realistic, no GPS           74.6 %
realistic, GPS within +-5 % 56.2 %
```

**Most of what a golfer loses is not FG-1.** 58 % of clips skip before the label is even
reached, on `track_not_ballistic` (20 730), `implausible_flight` (10 703) and `poor_fit`
(2 503). Of the arcs that *are* drawn, FG-1's new rung withholds **17.7 %**; the
GPS-unconfirmed rung withholds 22.8 %; `axis_degenerate` 3.7 %.

**The observation worth Henry's attention:** with a *correct* GPS reading the number
survives on 56.9 % of arcs, and with **no GPS at all** it survives on 71.7 %. Supplying a
GPS distance currently makes the pill **less** likely to say anything, because the
unconfirmed-verdict path withholds more often than the pixel-only path does. Per clip
reaching the ladder the two are nearly identical (26.0 % vs 28.0 %), because a GPS carry
also rescues clips that would otherwise skip — but the GPS is not, today, buying fill rate.

## Is what remains worth showing a golfer?

**On its own terms, yes — and the wording is right.**

- The median stated number is **2.0 % from truth**; on a realistic capture with a roughly
  correct GPS reading, **1.6 %, p90 5.6 %, and not one of 290 over 25 %**. That is a good
  product.
- `"no distance" / "not enough of the flight"` is the right pill. It is actionable, it is
  true, and my own sweep independently confirms the fact it encodes: **148 of 148 wrong
  numbers came from tracks that stopped before the apex.** Telling a golfer to frame more of
  the shot is the one thing they can act on.
- Three withholding pills is one too many for a phone, and they are not distinguishable to a
  user: *"no distance / GPS unchecked"*, *"no distance / not enough of the flight"* and
  *"down the line / no distance"*. Two of the three say "no distance" in the same slot with
  different sub-lines. On a moving reel that is one message, not three.

**But 1 in 139 is not "never", and the honest framing of the decision is this.** A golfer
who plays 18 holes and gets a traced arc with a number on, say, 25 of them will see a number
more than a quarter wrong roughly **once every five and a half rounds**. Not once a round —
and not never either. Whether that clears Henry's bar is his call, and I will not pretend the
number is smaller than it is: **the class is closed, and a floor of individually
unpredictable geometries is not.**

**What I would actually change, if anything.** Nothing in the fit. The one lever with
leverage is not a threshold at all — it is `selectDetections`, which deliberately fits only
the first ~15 (30 fps-equivalent) frames unless the track reaches the apex. **Every wrong
number in this sweep and in the final gate's came from a track that never saw the descent,
and among the 147 stated numbers whose track DID reach the apex, nothing was more than 11.8 % out.**
That says the fix is not a better gate on a bad fit; it is a detector that keeps the ball
longer. That is native work, it is a field-test question, and it is out of scope here.

---

# 8. What I could NOT verify

- **Nothing ran on a device and no frame was rendered.** No Swift was compiled, linked or
  executed. Core ML loading, the `.mlpackage` → `.mlmodelc` compile, every Vision call and
  every AVFoundation export path are untested, and the seam through
  `ShotDetectorModule.swift` cannot be typechecked here at all.
- **My fixtures are simulated flights projected through a known camera.** They prove the
  ladder recovers, or honestly refuses to state, a flight it is *given*. They say nothing
  about whether the Swift detector finds a ball on real footage, which is still the biggest
  unmeasured thing in this branch.
- **My 1.08 % is a rate on MY synthetic distribution and it is 2.6× the fix agent's 0.42 %
  on theirs.** Neither is a field number. The difference is the distribution — my sweep
  includes 24 and 120 fps at equal weight and samples camera pitch and height continuously —
  and it is a measured demonstration of the caveat every previous round stated: **how bad
  FG-1's residue is in practice is decided by the real detector's track-length and residual
  distribution, which nobody has.**
- **`pixelOnly.ok` was not instrumented directly** (CT-2). The mechanism is established from
  source plus elimination, not from a printed value.
- **NEW-2 was not pressed on a phone**, and `getCaptureOptics` has still never been called
  by a real recording.
- **I did not re-derive** `Z_INCONSISTENT = 4`, `Z_TENSION = 2`, `AS_SCALE_FRAC = 15 %`,
  `COARSEST_LABEL_STEP_M = 10`, `POOR_FIT_MIN_K = 10`, `LOOSE_V0_REL_SIGMA = 5 %`,
  `LOOSE_RMS_PX_1080 = 2.0` or `LOOSE_CARRY_SIGMA_FRAC = 25 %`. I measured what they cost and
  what they catch on my data; I did not check them against first principles.
- **I did not re-run the fix agent's revert-each-half procedure.** I read the thirteen new
  tests and judged them; I did not independently prove each one fails against pre-fix code.
- **FG-4's reachability from Swift is still unproven**, by them and by me.
- **The apex is never checked and I did not fix that.** My camera A smoke test recovers the
  carry to 3.3 % and the apex to +50 %; gid 120's apex is 39 m against a 7.5 m truth. The
  pill states the apex ("apex 39 m") with no gate on it whatsoever. **Nothing in four rounds
  of findings has been about the apex number**, and on the evidence here it is materially
  less reliable than the carry it sits next to.

---

# 9. Everything I ran, in order

| # | command | result |
|---|---|---|
| 1 | `npm run verify` × 2 | tsc clean, **860/860**, 0 skip/todo, exit 0, identical |
| 2 | `grep -rnE "\.skip\(\|\.todo\(\|\.only\(\|xit\("` over `tests/` | exit 1 |
| 3 | `certify/smoke.ts` — a clean flight on each of my six cameras | all six recover it |
| 4 | `certify/sweep.ts` × 10 shards — **58 500 `traceClip` calls** | 0 threw; **148 numbers > 25 % out, 29 GPS-backed, worst +46.1 %** |
| 5 | `certify/analyse.mjs`, `dig.mjs`, `fill.mjs`, `fg23.mjs`, `ut22.mjs`, `badgps.mjs` | §2, §6, §7 |
| 6 | `certify/counter.mjs` — 13 candidate rules evaluated on the residue | §2f — no cheap rule exists |
| 7 | `certify/exact.ts` — the worst geometries re-derived from their seeds | all reproduce exactly |
| 8 | `certify/refuse.ts` — 44 inputs × `forceTrace` both ways | §3; no non-golf input states a number |
| 9 | `certify/arcend.ts`, `arcend2.ts` — the raw-array read | **CT-1** |
| 10 | `certify/prior.ts` — **5 184 calls** on the `prior` rung | **0 numbers drawn** |
| 11 | `swiftc -parse` × 5; `-typecheck` the three together and singly | exit 0 / exit 0 |
| 12 | source trace of every revert clause, every `Location.*` call, every tracer entry point, every `det.detections` read | §4, CT-1 |
| 13 | `git ls-files` / `git cat-file -s` on the `.mlpackage` (read-only) | byte-identical in `HEAD` |

**Total: 63 772 `traceClip` calls** — 58 500 in the main sweep, 5 184 on the `prior` rung,
88 in the refusal suite, plus the probes in rows 3, 7 and 9.

---

# VERDICT — the four answers

### (a) A dev build with distances ON

**YES, with the caveat stated out loud to whoever reads the pill: about 1 stated number in
139 will be more than a quarter wrong, worst case around a third, and it is not predictable
from anything on the screen.** That is a 4× improvement on the state the final gate failed,
the `prior` rung states nothing, no non-golf input states anything, and a correct GPS
reading is still used and still labelled on 99.9 % of the clips where it agrees. **It is not
"never", so this is Henry's call and not a gate's** — and the honest way to take it is that
the arc is the feature, the number is a bonus, and the bonus is more than a quarter wrong on
0.7 % of the clips where it appears.

### (b) A detector-only field test (distances off)

**YES, unreservedly, and it is the test that should run first.** With `maxCarryM: 0` every
render is pixel-only and honestly marked "· no GPS", FG-2, FG-3, review F1 and review F5
cannot fire at all, and the one thing nobody has measured — whether the Swift detector finds
the ball on real footage — does not need the GPS or the pill.

### (c) Exact capture instructions

1. **`git add clippar_app/tests/fixtures/tracerV3AxisFallback.ts` and
   `clippar_app/tests/fixtures/tracerV3DroppedFrames.ts` BY NAME**, then commit the working
   tree. Three tests import them and both are untracked, so a fresh clone is red and the
   FG-1 and FG-3 reproductions are not in the repo. **Do not `git add -A`** — seven unrelated
   untracked paths sit in this tree.
2. **Take the GPS out of the loop for the first outing: set `maxCarryM: 0` in
   `constants/config.ts:366`.** One number, trivially reversible.
   `hooks/useEditorState.ts:1538` gates on `carry.carryM > 0 && carry.carryM <= maxCarryM`,
   so zero makes `carryUsable` false on every clip and `traceClip` receives `carryM: null`.
   There is no dev-screen toggle for this; it is a source edit.
3. **Capture at 1×, no pinch, phone roughly level, standing at least 2° off the shot line,
   `forceTrace` OFF.** Any other lens or any pinch is refused outright (correctly). A shot
   straight down the axis loses its number to F4. `forceTrace` draws arcs over putts and
   divots and, on a putt, will put a distance on one.
4. **On the FIRST clip, before walking to the second tee, check
   `tracer_meta.detectorNotes.coreml === "ok"`** (`TracerDetect.swift:673`). Anything else
   means the model did not reach the bundle and the whole outing is measuring a degraded
   detector.
5. **Then, for every clip, record five things off `tracer_meta` and one off the course:**
   `meta.selection.k`, **`meta.selection.throughApex`**, `meta.fit.rmsPx`,
   `meta.sigmaTotal.carryM`, the drawn carry — and the real distance from a laser or a course
   marker, measured afterwards. `throughApex` is the one that has never been collected and it
   is the one that decides everything below.

### (d) The single most valuable thing the first field test should measure

**What fraction of real clips are tracked THROUGH the apex — `meta.selection.throughApex`.**

Every wrong number in my 58 500 calls came from a track that stopped before the apex
(148 of 148), and among the 147 stated numbers whose track did reach it, nothing was more than
11.8 % out. The same fact holds on the final gate's independent sweep. In my synthetic
distribution only **0.9 %** of drawn arcs (and 1.1 % of stated numbers) reach the apex, which is why "require the apex" is
unusable as a rule — but that 1.1 % is an artefact of my uniform 3–20 frame sampling and
nobody knows the real figure.

**If the real detector tracks most shots through the apex, this feature can state a distance
on nearly every clip and be right, and FG-1's whole rung becomes near-free. If it tracks
almost none, then the honest product is an arc with no number and the GPS half should be
deleted rather than defended.** One number off one outing decides which of those two products
Clippar is building, and no amount of further work on the TypeScript ladder can answer it.
