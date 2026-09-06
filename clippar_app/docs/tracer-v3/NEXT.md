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

- [ ] `bench` — repeatable measurement over ~180 clips (his ~64 + 84 unseen + 36 lab) under
      APP conditions (imported: no pitch, no lens, no GPS, app's own impact)
- [ ] `impact-scan` — scan the window for a static ball that departs; that frame is the impact
- [ ] `tune` — work down the ranked failure reasons against the bench
- [ ] `verify` — independent re-measure, refusals still hold, no crashes, the honest number
- [ ] Rebuild, verify the IPA, send Henry the link

Landed already this round: the fit may now solve for a GUESSED camera angle (IMG_0601 rms 13.8
-> 2.8 px, refused -> draws); the impact search is bounded so a 4.5 s import cannot crash it
(IMG_0594 SIGTRAP, fixed).

**Henry asked for a guarantee it will work on every shot. It cannot be given, and the verify
agent is instructed to report the measured rate rather than a rounded one.**
