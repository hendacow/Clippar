# NEXT — tracer V3 app integration (resume here if the session was cut off)

**Owner:** CTO seat. **Brief (Henry, 6 Sep 2026):** integrate the tracer-lab pipeline into the app for
the DEV BUILD, behind a config so it is trivially revertible, wired to GPS/location, running locally.

**Branch:** `feat/tracer-v3`, cut from the live dev branch `feat/onboarding-fast-value`.
**Baseline before any change (must not regress):** `npm run verify` = tsc clean + **652 tests**.
**Plan:** `../../../TRACER_V3_PLAN.md` (repo root). **Algorithms:** `~/projects/clippar/tracer-lab`.

## State machine

- [x] Branch, baseline verify (652), plan committed
- [x] **Build wave** (workflow `wf_87ba4412-2ff`, 5 parallel Opus-5 agents):
      `ts-physics` (lib/tracerPhysics.ts, lib/tracerCamera.ts) · `ts-fit` (lib/tracerFit.ts) ·
      `native-detect` (TracerDetect*.swift + CoreML) · `native-render` (TracerRenderV3.swift) ·
      `ts-gps` (lib/gpsSession.ts, hooks/useGpsSession.ts) → reports in `docs/tracer-v3/*.md`
- [x] **Integrate**: config block + engine switch, native bridge, `lib/tracerV3.ts` ladder,
      editor batch, GPS wiring, dev settings, tests
- [x] **Verify** — green first run: tsc clean, 799 tests (652 baseline + 147 new): `npm run verify` green, Swift parse/typecheck, reversibility proof (flag off = no-op)
- [x] **Review** — GO conditional on 3 fixes; `docs/tracer-v3/review.md` (725 lines): adversarial skeptic → `docs/tracer-v3/review.md`, go/no-go
- [x] **Fixes** rounds 1-2 (`wf_c5a4dafb-f17`, `wf_942ef400-5a1`): F1 carry-inconsistent laundering, F2 impact slack, F3a lens/zoom skip, F4 axis-degenerate, F5 label honesty, F6 persisted bypass, F8 landing flag, refusal test suite → `docs/tracer-v3/fixes.md` + `re-verify.md`
- [x] Commit + push — `d32faa1` on `feat/tracer-v3`, 46 files, verify 838/838 (baseline 652). CoreML model tracked.
- [x] **GATE-1** (workflow `wf_cd1c058d-a03`): closed as a class; a final independent gate then FAILED the branch on the LABEL rather than the carry verdict → `docs/tracer-v3/final-gate.md`
- [x] **Fixes round 4** (`fix-fg`): all five gate findings closed → `docs/tracer-v3/fixes.md` round 4.
      FG-1 the "too uncertain to state" rung (+ the `pixel_only_fallback` companion choice),
      FG-2 `carry_untested` as a status, FG-3 the axis refusal on the fallback, FG-4 non-finite
      detections, FG-5 the `lib/storage.ts` drift. Verify **860/860**, tsc clean.
      Measured on 58 500 `traceClip` calls run before and after: drawn numbers more than 25 %
      from truth **8.27 % -> 0.42 %**, worst **+484 % -> +49 %**, at the cost of **26 % of the
      numbers** (the arc always draws). **52 rows on 18 geometries still exceed 25 %.**
- [ ] **Two untracked fixture files must be `git add`ed BY NAME** (never `git add -A` in this tree —
      seven unrelated untracked paths are sitting in it):
      `clippar_app/tests/fixtures/tracerV3AxisFallback.ts` and
      `clippar_app/tests/fixtures/tracerV3DroppedFrames.ts`. Six tests import them and a fresh
      clone is red without them. (Round 3's `tracerV3FlatTension.ts` is already tracked, in
      `3da9eff`.)
- [x] Second/third commit + push — `3da9eff`, `9013e2e`; verify 863/863
- [ ] Write back; write back to `company-brain/org/cto/STATUS.md` and the daily report;
      hand Henry the build command (do NOT spend EAS credits — nearly exhausted as of 5 Sep)

## Resuming

Workflow agents journal their results: `Workflow({scriptPath, resumeFromRunId: 'wf_87ba4412-2ff'})`
replays finished agents from cache and re-runs only the unfinished. Script path is in the run's
notification; the journal is under `~/.claude/projects/.../subagents/workflows/wf_87ba4412-2ff/`.
Every agent also writes its own report to `docs/tracer-v3/` as it goes, so read those first —
a missing report means that agent did not finish.

**Model policy (Henry, 5 Sep):** every Workflow agent runs `{ model: 'claude-opus-5' }`.
**Nothing is submitted to Apple, and no EAS build is started, without Henry's explicit instruction.**


## Done — 6 Sep 2026, 17:30

Five commits on `feat/tracer-v3` (pushed): plan, the integration, GATE-1, round 4 + the apex
gate. `npm run verify` **863/863**, tsc clean, baseline was 652.

**Six independent adversarial passes**, each of which found real defects that are fixed here:
`review.md` → `re-verify.md` → `gate.md` → `final-gate.md` → `certify.md`, with `fixes.md`
carrying four rounds of remedies. The through-line: one bug — a disagreement test skipped or
diluted by a sigma that was itself unreliable — kept reappearing at lower thresholds until it
was closed as a class rather than an instance, and the last round moved the argument from the
carry VERDICT to what the label is allowed to SAY.

**Certified state:** 1 stated distance in 92 is still more than 25 % from truth (1 in 139 on a
realistic capture, worst +46 %), down from 1 in 14. Not zero, and not hidden.

**Next, and it is not more of this:** the on-device field test. Nothing here has run on a
phone, no Swift has been compiled and no frame has been rendered. The single most valuable
measurement is `meta.selection.throughApex` — every wrong number in 63,772 simulated calls
came from a track that stopped before the apex, and nothing whose track reached the apex was
more than 12 % out.


## Round 2 — the window scan (6 Sep 22:00, workflow `wf_48fdac19-613`)

Henry field-tested and 1 of 9 imported clips drew. Diagnosed by compiling the real Swift
detector into a macOS harness (`docs/tracer-v3/bench/`) and running it against his own footage:
the detector is faithful, but EVERYTHING it reads is anchored to the impact instant it is given,
and half a second of error is total failure. The app's impact on imports is regularly 1-3 s out.

Henry's instruction, which is the design being implemented: *"it has a window when it trims of
like 2 seconds so can't you just scan for the ball in that window and extend it out frame by
frame"* — derive the impact from the video instead of trusting the hint.

- [x] `bench` — repeatable measurement over ~180 clips (his ~64 + 84 unseen + 36 lab) under
      APP conditions (imported: no pitch, no lens, no GPS, app's own impact)
- [x] `impact-scan` — scan the window for a static ball that departs; that frame is the impact
- [x] `tune` — work down the ranked failure reasons against the bench
- [x] `verify` — independent re-measure, refusals still hold, no crashes, the honest number
- [x] Rebuild, verify the IPA, send Henry the link — build e02d6018, commit 1695c33

Landed already this round: the fit may now solve for a GUESSED camera angle (IMG_0601 rms 13.8
-> 2.8 px, refused -> draws); the impact search is bounded so a 4.5 s import cannot crash it
(IMG_0594 SIGTRAP, fixed).

**Henry asked for a guarantee it will work on every shot. It cannot be given, and the verify
agent is instructed to report the measured rate rather than a rounded one.**


## Round 2 result (7 Sep 09:00) — build e02d6018 sent

Henry's window-scan design works: at every impact offset from -3 s to +3 s the detector
recovers the true instant to a median ~20 ms, in one pass. The failure that started the round
(half a second of impact error -> zero detections) is closed.

**Measured under app conditions, 121-clip corpus, the app's own impact estimator compiled and
run here:** full swings drawing 15/51 -> **21/51 (41.2%)**; Henry's own clips 10/25 (40%);
unseen 2/11 (18.2%); lab 9/15 (60%); ceiling with a perfect impact 17/26 (65.4%).
False draws **1/49 -> 0/49**. 0 of 32 draws state a distance. No crashes on 121 clips.
Worst-case refusal time 410 s -> 83 s after the wall-clock budget.

**The single strongest lever, and it is Henry's to pull: capture format.**
4K/60 62.5% vs 1080p/30 31.2% on his own full swings. It roughly doubles.

**Next round, in priority order:**
1. `detector_found_no_address_ball` on 18 of 51 full swings, 16 of them 1080p/30. This is now
   the whole game and it is an address-finder sensitivity problem, not an impact problem.
2. The renderer has still never run. "Draws" means a valid spec, not a painted arc.
3. IMG_0601 truncates to 4 detections under the scan where the offset ladder got 44 — not
   systematic (IMG_3652 still gets 45) but it is a quality loss worth understanding.
4. `IMG_0596_2`, a putt, is one pitch-ladder quorum rung from drawing. Do not lower that quorum.


## Round 3 — the renderer finally ran (7 Sep)

Henry field-tested build `e02d6018` with five imports and got nothing on any of them, and
asked for it fixed so all or most work. **It is not fixed. Recall is unchanged at 32/72.**
What was fixed is what the trace does when it *does* draw, and the reason that mattered is
that the renderer had never been run.

**How to run the renderer** (it had never been done, which is why the defect survived six
review passes): it imports UIKit, so no macOS build; and under `xcrun simctl spawn` it
SIGTRAPs inside Core Animation's offline GLES renderer trying to make an IOSurface with no
window server. **Build it for Mac Catalyst** (`-target arm64-apple-ios15.1-macabi` plus the
SDK's `iOSSupport` include/framework paths) and it runs natively on this Mac in seconds.
Harness: `bench/mainRenderV3.swift` + `bench/specDump.ts`.

**The defect it exposed**, on IMG_0552_2, one of Henry's own imports: the arc was drawn on
to the FITTED landing, which under `geometry_unknown` rests on an assumed pitch and an f_px
prior. The trace turned round and plunged back towards the tee, reading as a vertical red
stick beside the golfer.

**The fix for it was wrong and is reverted (`395d520`). Read this before trying it again.**
`a4f145e` stopped the arc at the last detection whenever the scale was a guess. Measured
afterwards on four more of Henry's clips, with the rung on and off:

| clip | arc with the rung OFF | with it ON |
|---|---|---|
| IMG_0530 | 4.56 s, ends y 0.584 | 0.45 s, ends 0.557 |
| IMG_0588 | 4.92 s, ends y 0.605 | 0.68 s, ends 0.714 |
| IMG_0544 | 4.48 s, ends y 0.626 | 0.99 s, ends 0.698 |
| IMG_0564 | 5.65 s, ends y 0.593 | 1.05 s, ends 0.750 |

The detector loses the ball long before it lands, so "stop where the ball was seen" means
"stop climbing": four full arcs became half-second stubs ending at their own apex, and
rendered they are red sticks beside the golfer. One pathological clip fixed, four good ones
ruined.

**So the defect is not that the arc is extrapolated — it is WHERE it ends.** Those four end
at y 0.58-0.63 bottom-left; IMG_0552_2 ends at 0.463, much lower in the frame. The right
tool is the one already in the file and currently switched off under `geometry_unknown`:
`landingHorizonCheck` / `cam.horizonRow(x)`, which is exactly Henry's "it needs to land on
the horizon in relation to how far the ball was hit". **Next round: clamp the drawn arc's
end to the horizon row rather than refusing to draw it, and check the sign — on a first
reading the four long arcs may be ending ABOVE the horizon, which the lab's own check calls
a bug, while IMG_0552_2's ends below it. That needs measuring before anything is changed.**

### Three attempts at recall, all measured, none shippable

Use `./bench.sh --detopts '<TracerDetectOptions JSON>'` — it is folded into the cache key,
so a sweep needs no rebuild and cannot collide with the baseline.

| attempt | result |
|---|---|
| persistence `maxMissEarly 8 / maxMissLate 14 / firstDetFrames 10` | **31/72 — a net loss.** +2, -3. All three losses identical: the longer track keeps going after the ball goes sub-pixel and collects junk (IMG_0530: 27 dets @1.16 px -> 84 @21.8 px, refused `track_not_ballistic`) |
| a rung refitting the longest clean PREFIX, to fix exactly that | **reverted.** Broke five safety tests including *"a divot and a tossed ball are refused"*. Trimming a track until it fits manufactures a flight out of noise |
| acquisition only, `firstDetFrames 12` | **33/72 but 1/49 false draws** (IMG_3630). +1 clip for the first fabricated arc in 49. Refused |

**Do not re-run these three without a new idea.** The shipped defaults are at a local
optimum and the binding constraint is upstream of all of them.

### The binding constraint, which nobody had written down

At 1080p a golf ball is **under one pixel across by ~60 m** (f_px ~ 1400, ball 42.7 mm). The
detector cannot see a full flight — it sees the first stretch and everything after is
inference. Hence: 4K/60 draws **10/17 (59%)** against 1080p/30's **22/54 (41%)**; and a
fitted carry on an import is 12-22 m for what may be a 140 m shot (feeding IMG_0552_2 a
140 m GPS carry is rejected at **9 sigma** against the pixel evidence). The arc's SHAPE is
defensible; its SCALE is not, which is why the pill says "no distance".

### Next, in priority order

1. ~~The blank label pill~~ **— settled, it is the harness, not the app. Do not chase it.**
   The pill renders as an empty dark box through the Catalyst render path. Three things say
   that is Catalyst and not the phone: (a) built in isolation and drawn with
   `layer.render(in:)` the same pill draws its text correctly (`bench/pilltest`);
   (b) carrying the font on an `NSAttributedString` instead of `CATextLayer.font` changes
   nothing, so it is not the well-known UIFont-on-CATextLayer trap; and (c) **the shipped v1
   renderer builds its label with the identical four lines** (`ShotTracer.swift`, `text.font
   = font`), and carries the comment *"Device-verified: CATextLayer glyphs render upright in
   the animation-tool export"* — v1 is in production. CATextLayer glyphs evidently do not
   rasterise in the offline Core Animation renderer under Catalyst. **Cost of this being
   wrong is one look at a phone; do that before writing any code.**
2. **The in-app capture path has never been field-tested.** Everything above is imports:
   no pitch, no lens, no GPS. A clip RECORDED with the tracer on has all three, and it is
   the only path that can scale the flight and land the arc on the horizon — which is
   Henry's stated requirement and is currently unreachable from an import.
3. Remaining failures over 72 shots: 13 track suppressed at 1-2 detections, 11 no first
   detection in the window, 6 not ballistic, 3 address refused, 2 pitch unstable, 2 putt,
   2 no departure, 1 poor fit. The first two are 60% of the loss and both are acquisition,
   not tracking — but see the table above before touching thresholds.
