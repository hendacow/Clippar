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
- [ ] Second commit + push; write back; write back to `company-brain/org/cto/STATUS.md` and the daily report;
      hand Henry the build command (do NOT spend EAS credits — nearly exhausted as of 5 Sep)

## Resuming

Workflow agents journal their results: `Workflow({scriptPath, resumeFromRunId: 'wf_87ba4412-2ff'})`
replays finished agents from cache and re-runs only the unfinished. Script path is in the run's
notification; the journal is under `~/.claude/projects/.../subagents/workflows/wf_87ba4412-2ff/`.
Every agent also writes its own report to `docs/tracer-v3/` as it goes, so read those first —
a missing report means that agent did not finish.

**Model policy (Henry, 5 Sep):** every Workflow agent runs `{ model: 'claude-opus-5' }`.
**Nothing is submitted to Apple, and no EAS build is started, without Henry's explicit instruction.**
