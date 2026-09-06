# verify — the gate on the tracer-v3 branch

**Agent:** `verify`, tracer-v3 build wave, 6 Sep 2026.
**Repo:** `/Users/hendacow/projects/clippar/final_shipment/clippar_app`, branch `feat/tracer-v3`.
**Baseline that must not regress:** tsc clean + 652 tests.

This file is written incrementally, command by command, with the real output. Where a command
produced no output, that is stated rather than implied.

---

## 1. `npm run verify`

```
$ cd /Users/hendacow/projects/clippar/final_shipment/clippar_app && npm run verify
> clippar_app@1.1.0 verify
> npm run typecheck && npm run test

> clippar_app@1.1.0 typecheck
> tsc --noEmit
                       # no output: tsc is clean

> clippar_app@1.1.0 test
> node --import tsx --test tests/*.test.ts
...
ℹ tests 798
ℹ suites 0
ℹ pass 798
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 48308.530292
EXIT=0
```

**GREEN on the first run. 798 pass, 0 fail** — the 652 baseline plus 146 the wave added.
Nothing needed fixing to get here: no test was deleted, weakened, skipped or marked `todo`
(`skipped 0`, `todo 0` above is the machine-checked form of that claim).

---
## 2. Swift

There is no `pod install` in this checkout, so **nothing here was compiled into an app and
nothing was run.** What follows is what the compiler front end will say about these files, and
no more than that.

All commands were run from `clippar_app/modules/shot-detector/ios` with
`SDK=$(xcrun --sdk iphoneos --show-sdk-path)`
(`/Applications/Xcode.app/.../iPhoneOS26.5.sdk`) and `-target arm64-apple-ios15.0`.

### 2a. `swiftc -parse` — every file in the directory

```
$ for f in ShotDetectorModule.swift ShotTracer.swift TracerDetect.swift \
           TracerDetectCore.swift TracerRenderV3.swift; do
    out=$(xcrun swiftc -parse -sdk "$SDK" -target arm64-apple-ios15.0 "$f" 2>&1); rc=$?
    echo "=== $f : exit=$rc ==="; [ -n "$out" ] && echo "$out"
  done
=== ShotDetectorModule.swift : exit=0 ===
=== ShotTracer.swift : exit=0 ===
=== TracerDetect.swift : exit=0 ===
=== TracerDetectCore.swift : exit=0 ===
=== TracerRenderV3.swift : exit=0 ===
```

Five files, five clean parses, no output from any of them. That is **syntax only**.

### 2b. `swiftc -typecheck` — the three files with no `ExpoModulesCore` import

`ShotDetectorModule.swift` and `ShotTracer.swift` both `import ExpoModulesCore`, which is not
resolvable without the pods, so they can only be parsed. The three new tracer files import
nothing but system frameworks and therefore CAN be typechecked:

```
$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 TracerDetectCore.swift
exit=0                                        # no output
$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 TracerRenderV3.swift
exit=0                                        # no output
$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 TracerDetect.swift
exit=1
TracerDetect.swift:41:25: error: cannot find 'TracerParams' in scope
TracerDetect.swift:87:29: error: cannot find type 'TracerDetection' in scope
TracerDetect.swift:101:15: error: cannot find type 'TracerBGRA' in scope
        … (and 2 more of the same kind)
```

**That failure is an artefact of typechecking one file of a two-file pair, not a defect.**
`TracerDetect.swift` is the AVFoundation/Vision driver; the types it names live in
`TracerDetectCore.swift`, which is the point of the split (the core is the part that can be
checked without Expo). Given both files, it is clean — and so is the whole new trio together,
which is what the pod target actually compiles:

```
$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 \
      TracerDetectCore.swift TracerDetect.swift
exit=0                                        # no output

$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 \
      TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift
exit=0                                        # no output
```

### 2c. The seam that no compiler here can check

`ShotDetectorModule.swift` is the only file that references the new ones, and it is the one file
that cannot be typechecked. So I checked the seam by hand, symbol by symbol:

| What `ShotDetectorModule.swift` calls | What the new file declares | Agrees? |
|---|---|---|
| `TracerDetect.detect(assetURL:impactTimeMs:optionsJson:)` | `TracerDetect.swift:556` `public static func detect(assetURL: URL, impactTimeMs: Double, optionsJson: String) -> [String: Any]` | yes |
| `TracerRenderV3.render(videoURL:specJson:outputURL:)` | `TracerRenderV3.swift:1534` `static func render(videoURL: URL, specJson: String, outputURL: URL) throws -> [String: Any]` | yes |
| `catch let e as TracerRenderV3Error` → `e.code`, `e.message` | `TracerRenderV3.swift:62` `struct TracerRenderV3Error: LocalizedError { let code: String; let message: String }` | yes |
| `self.resolveFileURL(_:)` | `ShotDetectorModule.swift:668` `internal func resolveFileURL(_ uri: String) -> URL` | yes |
| `promise.reject(Exception(name:description:))` | 20 pre-existing uses in the same file (lines 306, 320, 352, …) | same house pattern |
| `FileManager.default.urls(for:.cachesDirectory,…).first!` | 9 pre-existing uses in the same file | same house pattern |

Both natives return `[String: Any]`, which is what `promise.resolve` serialises. `TracerRenderV3`
is `internal` and `TracerDetect` is `public`; all five files compile into the one `ShotDetector`
pod target, so `internal` is reachable.

**Duplicate-symbol check.** All five files land in one Swift module, so a top-level name declared
twice is a link error that no single-file check would show. I extracted every column-0
declaration from all five files and looked for repeats:

```
$ … | awk '{n[$1]=n[$1]" "$2; c[$1]++} END {for (k in c) if (c[k]>1) print k":"n[k]}'
tracerMedian: TracerDetectCore.swift TracerDetectCore.swift
```

One repeat, both occurrences in the same file — a legitimate overload, and that file typechecks
alone. **No cross-file collisions.**

### 2d. What "clean" does NOT mean here

- No file was compiled to object code, linked, code-signed, installed or run.
- `ShotDetectorModule.swift` and `ShotTracer.swift` have had **syntax checked only**.
- Expo's `AsyncFunction` arity/marshalling, `CoreML` model loading, `Vision` behaviour, the
  `.mlpackage` → `.mlmodelc` compile-and-cache, and every AVFoundation export path are
  **entirely unverified**.

---
## 3. Reversibility — the product requirement

### 3a. The runtime state, measured not assumed

`config.tracer.enabled` is a plain `false` literal that is flipped to `true` at module load **only**
when `ENABLE_TRACER_ON_DEV_VARIANT` is true AND `tracerAllowedOnBinary(extra.variant, bundleId)`
passes (dev variant AND a bundle id ending `.dev`). Under node neither `expo-constants` nor
`expo-application` resolves, so both reads come back `undefined` and the gate fails closed:

```
$ node --import tsx docs/tracer-v3/flagstate.ts     # prints config.tracer.{enabled,engine}
{"enabled":false,"engine":"v3"}
```

**So the 798/798 run in §1 IS the flag-off run.** It is not a claim about the off path; it is the
off path.

### 3b. File by file, what runs with `config.tracer.enabled === false`

Every row was read, not inferred. "Reached" means the module is imported and its top level runs;
"does" means what actually executes.

| File | Reached with the flag off? | What it does | Gate |
|---|---|---|---|
| `constants/config.ts` | yes | Defines the object; the flip block evaluates `tracerAllowedOnBinary` once and does not fire | `ENABLE_TRACER_ON_DEV_VARIANT && tracerAllowedOnBinary(...)` at `:593` |
| `lib/gpsSession.ts` | yes (imported by `useCamera`, `useGpsSession`, `useEditorState`) | Constructs one `GpsSession`: an empty array, a `0`, and an 8-key merge loop over `config.tracer.gps`. **No timer, no listener, no location call.** | n/a — pure |
| `hooks/useGpsSession.ts` | yes — **mounted unconditionally** by `record.tsx` | `isActive = enabled && config.tracer.enabled && Platform.OS !== 'web'` → `false`. `startWatch` returns at line 1. All three `useEffect`s early-return (`if (!isActive) return`). The focus effect sets a ref and nothing else. **No `watchPositionAsync`, no `getForegroundPermissionsAsync`, no `requestForegroundPermissionsAsync`, no `setInterval`, no `AppState` listener, no `console.log`.** | `:40` `isActive`, then `:76`, `:178`, `:190` |
| `app/(tabs)/record.tsx` | yes | One extra hook call, `useGpsSession(config.tracer.engine === 'v3')`. The argument is `true` by default — the innermost gate inside the hook is what carries this. | inside the hook |
| `hooks/useCamera.ts` | yes | `tracerV3Gps = config.tracer.enabled && engine === 'v3'` → false. `sessionFix` stays `null`, `fixSeries` stays `[]`, so `gps_latitude: sessionFix?.lat ?? gps?.latitude` **reduces to today's expression**, and the three new columns are written `undefined` → NULL. The `__DEV__` log is inside the `if`. | `:557` |
| `hooks/useEditorState.ts` | yes | `processAllTracers` returns on line 1 (`if (!config.tracer.enabled …) return`). `deriveImpactFix` / `fixForPairing` are only called inside it. `isTracerV3Available()` is below the gate. The two selector reads at `:348`/`:370` already gate on the flag and already existed. | `:1326` |
| `app/round/editor.tsx` | yes | The batch trigger returns before starting: `if (!config.tracer.enabled …) return`. Progress banner is driven by a count that stays 0. | `:729` |
| `lib/tracerV3.ts` → `tracerFit` → `tracerPhysics` → `tracerCamera` | yes (static import in `useEditorState`) | Module top level is arithmetic constants and one **empty** `Map` (`CAP_LIMITS`, a lazily-filled memo). No simulation, no fit, no allocation of size. | n/a — pure |
| `modules/shot-detector/index.ts` | yes | Adds `detectShotV3` / `renderTracerV3` / `isTracerV3Available` as function declarations. `detectShotV3`'s default `optionsJson` is a default PARAMETER, so `JSON.stringify` runs only on a call. **No new call site outside the gated batch.** | callers |
| `lib/storage.ts` | yes | Three `ALTER TABLE … ADD COLUMN` run on **every** database; the `INSERT` carries three extra `?` bound to NULL. `updateClipGpsFix` and `getRecentTracerDiagnostics` have no caller outside the gated batch and the dev screen. | see 3c |
| `app/(tabs)/profile.tsx` | yes | Renders a "Tracer Dev Settings" row **iff `isDevVariant()`** — false in preview and production. | see 3c |
| `app/profile/tracer-dev-settings.tsx` | route exists; screen unreachable | Nothing runs — it is only pushed from the row above. | see 3c |
| `modules/shot-detector/ios/*` (native) | **compiled into every binary** | Two `AsyncFunction`s are registered at module init (closure definitions, no work). Neither is called. `TracerDetect` loads its Core ML model lazily, inside `detect`. | see 3c |

**Grep evidence that no ungated call site exists.** Every reference to the three new native
wrappers, in the whole app source:

```
$ grep -rn "detectShotV3\|renderTracerV3\|isTracerV3Available" --include="*.ts" --include="*.tsx" \
      app hooks lib components constants modules | grep -v "^modules/shot-detector/index.ts"
hooks/useEditorState.ts:  (import)
hooks/useEditorState.ts:1398:  const v3Available = config.tracer.engine === 'v3' ? isTracerV3Available() : false;
hooks/useEditorState.ts:      … detectShotV3 / renderTracerV3, both inside processAllTracers
```

All below the `:1326` gate. Same for `traceClip` (`lib/tracerV3.ts`), `gpsSession.estimateAt*`,
`carryBetween` and `updateClipGpsFix`: no caller outside a gated body.

### 3c. Where "byte-identical" is NOT literally true — four findings

The JS **behaviour** is identical with the flag off. Three things are nonetheless different in a
built binary, and one is a real UI leak. None of them is fatal; all four should be said out loud
rather than rounded off.

**(1) The IPA grows by ~5.9 MB in every build, including production.** `ShotDetector.podspec`
gained `s.resource_bundles = { 'ShotDetectorResources' => ['GolfBallDetector.mlpackage'] }`.
CocoaPods copies that bundle unconditionally; the config flag can only stop it being *loaded*.

```
$ du -sh modules/shot-detector/ios/GolfBallDetector.mlpackage
5.9M    modules/shot-detector/ios/GolfBallDetector.mlpackage
```

Plus ~5,200 lines of new Swift and a `CoreML` framework link. **A production build made from this
branch is not the binary that shipped**, even with the tracer off. It is inert, but it is there.

**(2) The three new SQLite columns are created on every database.** `migrateEditorColumns` is one
flag-independent list, so `recording_start_ts` / `gps_fix_series` / `gps_fix_meta` are added even
in a tracer-disabled build. They are nullable, additive, and **never written non-null while the
flag is off** — so "no new data" holds and "no schema change" does not. The `integrate` agent
flagged this and made the deliberate call; I agree with it. Conditional migration is worse: a flag
flipped mid-session would then find the columns missing.

**(3) The dev-settings row did not honour the one-line revert. FIXED — see §6.**
`app/(tabs)/profile.tsx` gated the row on `isDevVariant()` alone, **not** on
`config.tracer.enabled`. Set `ENABLE_TRACER_ON_DEV_VARIANT = false` — the documented revert — and a
*dev-variant* build still showed a "Tracer Dev Settings" row with every toggle behind it inert. No
customer binary could reach it (`isDevVariant()` is false there, double-gated on variant AND a
`.dev` bundle id), so it was cosmetic and dev-only — but it was the one place where the stated
contract "revert ⇒ no UI" was not kept, and it is one token to keep it.

**(4) The new JS is in the bundle either way.** `useEditorState.ts` statically imports
`lib/tracerV3.ts`, which pulls in `tracerFit` → `tracerPhysics` → `tracerCamera`; `record.tsx`
statically imports `useGpsSession` → `lib/gpsSession.ts`. 5,513 lines of new TypeScript ship in every JS bundle (tracerPhysics 672, tracerCamera 429,
tracerFit 1,490, tracerV3 1,571, gpsSession 623, useGpsSession 204, tracer-dev-settings 524). Evaluating them costs a few arithmetic constants and one empty `Map`, so the
runtime cost is nil, but the bundle is bigger.

### 3d. The suite, run with the flag forced each way

**Run A — flag OFF (the shipped state, §1):** `tsc` clean, **798 pass / 0 fail**.

**Run B — flag forced ON.** I temporarily changed the `&&` at `constants/config.ts:593` to `||`
so the flip fires under node, confirmed `{"enabled":true,"engine":"v3"}`, ran the whole suite, then
restored the file from a byte copy and re-checked its SHA-256
(`28c25bdf…ac6d36`, identical; `grep -c "VERIFY-AGENT TEMP"` = 0).

```
ℹ tests 798    ℹ pass 795    ℹ fail 3
```

**Green is impossible in this direction, by design, and the three failures say so.** All three are
tests that exist to PIN the off state:

| Test | File |
|---|---|
| `under node the tracer reads OFF, which is what makes the off-path testable` | `tests/tracerV3Wiring.test.ts` |
| `day-zero (tracer off) nothing is attributed to the tracer` | `tests/trimDiagnostics.test.ts` |
| `day-zero (tracer off) the pipeline window is the saved window` | `tests/trimWindow.test.ts` |

Each asserts `config.tracer.enabled === false` (or a value derived from it, e.g. the trim window
gaining `extraPostRollMs`). Forcing the flag true makes them false statements, so they fail — which
is the correct behaviour of a correct test. **The useful reading is the other 795: turning the
tracer on breaks nothing else in the suite.** I did not weaken these three to manufacture a green;
doing so would delete the only automated statement that the off path is the off path.

**Run C — the one-line revert, `ENABLE_TRACER_ON_DEV_VARIANT = false`.** Restored afterwards, SHA
re-checked identical.

```
ℹ tests 798    ℹ pass 798    ℹ fail 0     (tsc clean)
```

The documented revert compiles and is green.

---
## 4. The diff, read for accidents

```
$ git status --short           # READ-ONLY. No git command in this session wrote anything.
 M clippar_app/app/(tabs)/profile.tsx          ?? clippar_app/lib/tracerV3.ts
 M clippar_app/app/(tabs)/record.tsx           ?? clippar_app/lib/tracerCamera.ts
 M clippar_app/constants/config.ts             ?? clippar_app/lib/tracerFit.ts
 M clippar_app/hooks/useCamera.ts              ?? clippar_app/lib/tracerPhysics.ts
 M clippar_app/hooks/useEditorState.ts         ?? clippar_app/lib/gpsSession.ts
 M clippar_app/lib/storage.ts                  ?? clippar_app/hooks/useGpsSession.ts
 M clippar_app/modules/shot-detector/index.ts  ?? clippar_app/app/profile/tracer-dev-settings.tsx
 M …/ios/ShotDetector.podspec                  ?? …/ios/{TracerDetect,TracerDetectCore,TracerRenderV3}.swift
 M …/ios/ShotDetectorModule.swift              ?? …/ios/GolfBallDetector.mlpackage/
                                               ?? clippar_app/tests/{gpsSession,tracerCamera,tracerFit,
                                                     tracerPhysics,tracerV3,tracerV3Wiring}.test.ts
                                               ?? clippar_app/tests/fixtures/
                                               ?? clippar_app/docs/tracer-v3/

$ git diff --stat
 clippar_app/app/(tabs)/profile.tsx                 |  27 ++     <- 18 before my §6 change
 clippar_app/app/(tabs)/record.tsx                  |  21 ++
 clippar_app/constants/config.ts                    | 248 +++++++++++++++++-
 clippar_app/hooks/useCamera.ts                     |  62 ++++-
 clippar_app/hooks/useEditorState.ts                | 288 ++++++++++++++++++++-
 clippar_app/lib/storage.ts                         | 107 +++++++-
 clippar_app/modules/shot-detector/index.ts         | 122 +++++++++
 .../modules/shot-detector/ios/ShotDetector.podspec |   8 +-
 .../shot-detector/ios/ShotDetectorModule.swift     |  58 +++++
 9 files changed, 928 insertions(+), 13 deletions(-)
```

*(This is the tree AFTER §6. Before my one change it was 18 lines in `profile.tsx` and 919
insertions. `tests/tracerV3Wiring.test.ts` is a new untracked file, so my edit to it does not
appear in `git diff --stat`.)*

**13 deletions across nine files, and every one is a line replaced in place** (the `saveLocalClip`
INSERT column list, the three `gps_*` argument lines, the `shot-detector` import that became a
multi-line list, the podspec's `s.frameworks`). Nothing was removed.

| Check | Result |
|---|---|
| Absolute machine paths in new or changed source | **none.** `grep "/Users/hendacow"` over all 27 new/changed TS/Swift files: no hits. The one absolute path in the branch is in `docs/tracer-v3/labCheck.ts`, my own scratch tool — and it is `process.env.TRACER_LAB ?? "$HOME/projects/clippar/tracer-lab"`, read at run time, with a printed skip when it is absent. |
| `tracer-lab` referenced at runtime | **none.** Every mention in shipped source is inside a comment citing provenance. |
| Secrets | **clean.** `grep -Ei "api[_-]?key\|secret\|token\|password\|Bearer \|sk_live\|pk_live\|eyJ…\|AIza…"` over the new files: no hits. The repo's own `scripts/secret-scan.sh` also ran — this checkout is **not shallow** (`git rev-parse --is-shallow-repository` → `false`), so the history sweep genuinely happened: `════ secret scan CLEAN ════`, exit 0. (Its one WARN, 4 opaque binary documents, is pre-existing history and predates this branch.) |
| `TODO` / `FIXME` / `XXX` / `HACK` | **none** in any new or changed file. |
| `console.*` added | 2 in `useGpsSession` (both inside `if (isActive)` paths), 5 in the `useEditorState` V3 branch (below the flag gate), 2 in `modules/shot-detector/index.ts` (native-missing warnings), 1 in `useCamera` (inside `if (__DEV__)` inside `if (tracerV3Gps)`). **None on a hot path**: the `[GPS-RING]` line is self-throttled to 1 Hz inside a 1 Hz location callback; the rest are once per clip, matching the file's existing `[TRACER]` logging. |
| `print(` added in Swift | 5, all in `TracerRenderV3.swift`, all once per render (freeze failure, occlusion degrade, background-task expiry, export fail, export OK). **Zero in `TracerDetect.swift` / `TracerDetectCore.swift`** — the per-frame code. The neighbouring `ShotDetectorModule.swift` has 64 of the same. House style. |
| Stray files from this wave | `docs/tracer-v3/tracer-detect-core-check.swift` (37 KB) and `tracer-detect-core-params.py` (3.5 KB) are the `native-detect` agent's verification scratch. They are outside the podspec's source glob (`__dir__` is `modules/shot-detector/ios`) and outside `tsconfig`, so they cannot reach a build — but they are scratch, not documentation, and are worth deleting or moving before merge. |
| Stray files NOT from this wave | `.vercel/`, `CLIPPAR_PTY_LTD_APPLE_ACCOUNT.md`, `clippar_app/.playwright-mcp/`, `clippar_app/reg90.txt` (0 lines, one long line of Australian Consumer Law text), `clippar_mount/`, `logo_transparent/`, `migration/`. **All dated 25 Jun – 29 Aug — they predate this session.** They matter here for one reason: **a `git add -A` on this branch would sweep every one of them into the tracer commit.** Name the paths. |
| `.expo/types/router.d.ts` | regenerated by the `integrate` agent so the new route typechecks. Gitignored build artefact, no source change. |

Everything in `git status` is accounted for: nothing new is unexplained, and nothing that should
be there is missing.

---

## 5. Do the numbers a golfer would see agree with the lab?

This is the check that decides whether the port is faithful, and it is the one place I did not
take another agent's word for anything.

### 5a. Method, and why it does not use the repo's own fixture

`tests/fixtures/tracerFitClips.ts` is the `ts-fit` agent's **transcription** of the lab's labels
and cameras into this repo. A transcription error is exactly the failure mode this check exists to
catch, so `docs/tracer-v3/labCheck.ts` reads the source files at run time instead —
`tracer-lab/data/labels/<clip>.json` and `tracer-lab/experiments/camera/calibration.json`, the same
two files `lib/fit.py` reads through `experiments/fit/common.py`.

**Clips: IMG_3631 and IMG_3649** — the two 4K60 drivers, i.e. the shots the product is actually
for, and the two the lab reports as its good cases.

**Reference values.** The lab's `experiments/fit/report.md` §2 table is **wave 2**, and the labels
on disk have since been corrected (`fit2` §6: IMG_3649 gained frame 431 as its first track frame,
so its §2 row no longer describes the current data). So the primary reference is the machine-written
`experiments/fit2/results/carry_sweep_prior_all.csv` — the pixel-only `full` fit on all flight
frames, on the labels as they stand — and the §2 table is compared to as well, flagged stale where
it is.

### 5b. Result — the fit reproduces the lab to five significant figures

```
IMG_3631   n 39 (lab 39)                      IMG_3649   n 27 (lab 27)
  v0     TS  73.094  lab  73.094   -0.000 %     v0     TS  73.649  lab  73.649   +0.000 %
  carry  TS  244.40  lab  244.40   -0.002 %     carry  TS  220.00  lab  220.00   +0.001 %
  chi2px TS   7.767  lab   7.767   -0.005 %     chi2px TS  25.806  lab  25.806   +0.002 %
```

Against the §2 table, IMG_3631 (whose labels did not change) matches on every printed digit:
θ 12.08 vs 12.1 · φ 10.12 vs 10.1 · rpm 3216 vs 3216 · tilt −11.23 vs −11.2 ·
t0−k_imp 0.32 vs 0.32 · rms 1.01 vs 1.01 px · apex 34.3 vs 34 m · hang 7.15 vs 7.2 s.

IMG_3649 sits close to the wave-2 row it is no longer strictly comparable to (θ 7.54 vs 7.6,
φ −0.67 vs −0.7, rpm 2270 vs 2208, rms 2.57 vs 2.38 px) — the residual is the added frame 431,
not the port.

Feeding the lab's own pixel carry back in as a GPS distance gives `carry_consistent`, z = 0.00, on
both — the joint fit does not fight a carry that agrees with it.

**Tolerance claimed: 0.01 % on v0, carry and χ²_px.** Observed max deviation **0.005 %**.

### 5c. The one gap, chased down: σ(carry) was 20 % low, and it was the LAB that was noisy

At the shipped default `mcSamples = 64` the port's σ(carry) came out **2.56 m vs the lab's 3.29**
(−22 %) and **9.64 vs 12.06** (−20 %) — the only disagreement anywhere in the comparison, and in
the direction that would make a rendered distance look more precise than it is. So it was worth
running down rather than noting.

Both sides were re-run at increasing Monte-Carlo sample counts, five PRNG seeds each — the TS port
here, and **the lab's own Python** through its `.venv` (read-only; the script lives in my
scratchpad, not in the lab):

| samples | IMG_3631 TS | IMG_3631 lab | IMG_3649 TS | IMG_3649 lab |
|---|---|---|---|---|
| 64 | 2.89 ± 0.34 | 3.07 ± 0.21 *(its seed-0 draw is 3.29)* | 10.67 ± 1.00 | 11.39 ± 0.69 *(seed-0 = 12.06)* |
| 1024 | 3.14 ± 0.05 | 3.11 ± 0.02 | 11.52 ± 0.26 | 11.48 ± 0.12 |
| 4096 | **3.12 ± 0.02** | **3.11 ± 0.02** | **11.46 ± 0.12** | **11.44 ± 0.07** |

**Converged, the two implementations agree to 0.4 % and 0.5 %.** The published 3.29 and 12.06 are
the lab's own single 64-draw at seed 0, sitting about one standard deviation above its own mean.
There is no defect: `mcSamples = 64` is simply a noisy estimator in both languages, and the
port inherits that honestly.

**And it does not reach the golfer.** The label's rounding step comes from `sigmaTotal.carryM`,
which is dominated by the ±12 % `f_px` systematic, not by the Monte Carlo: TS gives **30.2 m and
34.1 m**, inside `fit2` §4's stated "σ_total(carry) 30–36 m → label step 10 m" for drivers at the
f_px prior. Both clips label at a 10 m step either way.

### 5d. End to end through the app's own entry point, on real footage

`lib/tracerV3.traceClip` — everything downstream of the native detector — was then driven from the
same real tracks. Both clips reach `decision = fit`, and the render spec's invariants hold:

| | IMG_3631 | IMG_3649 |
|---|---|---|
| samples | 870 | 664 |
| `tSec[0] === 0`, strictly increasing | yes | yes |
| x, y within 0..1 | yes (x 0.11–0.34, y 0.27–0.64) | yes (x 0.30–0.50, y 0.28–0.56) |
| landing vs horizon | y 0.4535 **below** 0.4590 | y 0.4565 **below** 0.4608 |
| label | "250 m · apex 35 m · no GPS" | "240 m · apex 19 m · no GPS" |

Landing below the horizon on both — the wave-5 render check, reproduced here in the render's own
normalized bottom-left coordinates from the calibration's `horizon_row_px`.

### 5e. The finding: carry rides ~1:1 on the ADDRESS-BALL RADIUS, and nobody had put a number on it

Run end to end, `traceClip` gave carry **252.5 m** on IMG_3631 where the fit alone gave 244.4, and
**241.6 m** on IMG_3649 where the fit gave 220.0 — +3.3 % and +9.8 %.

That is not a port defect. The app has no calibration file, so `traceClip` derives the camera
height from the **address ball's apparent radius**; the lab read its `h_cam` from a *separately
measured* diameter of the same ball. The two measurements of the same ball disagree — label
`r = 14.20` px vs calibration `29.5/2 = 14.75` px on IMG_3631, and `11.00` vs `12.00` on IMG_3649.
Re-run with the calibration's number, the app's own path lands on the lab:

| | h_cam vs lab | v0 vs lab | carry vs lab |
|---|---|---|---|
| IMG_3631, calibration r | −0.43 % | **−0.03 %** | **+0.03 %** |
| IMG_3649, calibration r | −0.22 % | **+0.66 %** | **+1.34 %** |

So the pipeline is faithful, **and the sensitivity is now measured: a −3.7 % error in the address
radius moved carry +3.3 %; a −8.3 % error moved it +9.8 %.** Roughly **1.2 % of carry per 1 % of
radius** — because radius sets depth, depth sets h_cam, and h_cam scales ball speed ~1:1.

On IMG_3631 that is the difference between a pill reading **"250 m"** and **"240 m"** — one whole
step of the honest 10 m rounding, from one sub-pixel disagreement about how wide a golf ball is.
The lab's own two humans measuring the same stationary ball differed by 4 % and 8 %; a blob
detector on a phone will not do better. **This is a second systematic, comparable in size to the
±12 % `f_px` one that is already flagged, and it is not in anyone's risk list.** It needs to be.

(One ladder observation in passing: with the worse camera on IMG_3631 the hold-out check fired —
`holdout_refit:K30->39(held-out median 30.5px, all-frame rms 0.98)` — and refit on all frames. The
ladder noticed. It corrected the fit, not the camera, so the carry error survived.)

---
## 6. What I changed, and why

The branch arrived green, so there was nothing to repair. I made **one behavioural change**, plus
its test, plus my own scratch tool.

| File | Change | Reason |
|---|---|---|
| `app/(tabs)/profile.tsx` | `{isDevVariant() && (` → `{isDevVariant() && config.tracer.enabled && (`, plus the `config` import and a comment saying who added it and why | §3c(3). The one-line revert is documented as leaving no UI; it did not. One token, dev-only, no loss — with the tracer off the screen has no diagnostics to show and no knob it can usefully turn. |
| `tests/tracerV3Wiring.test.ts` | widened the existing `not on __DEV__` regex (which required ` && (` immediately after `isDevVariant()`), and **added** `the dev-settings row also honours the one-line revert` | The existing test's INTENT — "variant, not `__DEV__`" — is untouched and still asserted. The new test pins the behaviour I just added, so a future edit cannot quietly undo it. **Nothing was deleted and nothing was weakened**: the suite went 798 → 799. |
| `docs/tracer-v3/labCheck.ts` | new, my own | §5. Scratch, not a test, not in `tests/`, never run by `npm run verify`. It is inside the `tsconfig` include glob, so it is written to typecheck under `strict` with real types rather than `any`, and it skips with a printed message when the lab is absent. |

I ran **no `git` command that writes** — no add, commit, checkout, stash or clean — and no
`npm install`. `constants/config.ts` was edited twice for the flag-forced runs in §3d and restored
from a byte copy both times, verified by SHA-256.

---

## 7. What I could NOT verify — read this before believing anything above

**Nothing in this branch has run on a device, and no frame has been rendered.**

- **No Swift was compiled, linked or executed.** §2 is a front-end check. `ShotDetectorModule.swift`
  and `ShotTracer.swift` were only PARSED. Expo's `AsyncFunction` marshalling, the `.mlpackage` →
  `.mlmodelc` compile-and-cache, Core ML loading, every Vision call and every AVFoundation export
  path are untested. The seam in §2c was checked by reading, not by a compiler.
- **The native detector has never produced a real detection through this path.** §5 substitutes the
  lab's hand-made labels for it. That proves the ladder recovers a flight it is GIVEN; it says
  nothing about whether the Swift detector finds the ball. The lab's own figure is ~half of unseen
  clips.
- **No render has been judged, and I did not try.** House rule: tracer work is never judged from
  simulator renders. §5d checks the render SPEC's arithmetic — in range, monotonic, landing below
  the horizon — not a single drawn pixel. Occlusion, the comet head, the freeze tail and the pill
  are design intent from the render agents' reports, not results.
- **GPS is untested end to end.** The estimator is unit-tested as a pure function. No fix from a
  real receiver has been through the ring, the impact anchor or the re-derivation in this app.
- **The `.dev` bundle-id gate is untested on a device** — `Application.applicationId` is null under
  node, so only the pure predicate `tracerAllowedOnBinary` is covered.
- **Cost on a phone is unmeasured, both halves.** The fit is 26–30 ms per clip on this Mac in node
  (§5), which is encouraging but is not an A-series core, and the detector's cost is a Mac Python
  number.
- **The 5.9 MB resource bundle is asserted, not observed.** That CocoaPods copies an `.mlpackage`
  verbatim into every configuration comes from the podspec's own comment; I could not run
  `pod install` to confirm it, nor confirm that it is inert in a tracer-disabled build.
- **§5 covers two clips, both 4K60 drivers.** They are the product's main case and the lab's good
  cases. The soft pitches (IMG_3629, IMG_3652), where the lab reports 20–32 px hold-out errors, were
  not re-checked here.

---

## 8. Verdict, and the findings I am handing on

**The gate is green and the port is faithful.** `npm run verify` = tsc clean + **799/799**; five
Swift files parse and the three new ones typecheck; the flag-off path is proven by reading every
call site and by the suite's own three pinning tests; and the fit reproduces the lab's Python to
**0.005 %** on the numbers a golfer would see.

Ranked, what a reviewer should carry forward:

1. **The address-ball radius is an unlisted systematic of the same size as `f_px` (§5e).** Carry
   moves ~1.2 % per 1 % of radius error. The lab's own two measurements of the same stationary ball
   differ by 4 % and 8 %; on IMG_3631 that is the difference between a pill saying **250 m** and one
   saying **240 m**. A blob detector on a phone will not beat two humans with a zoom tool. This
   belongs on the risk list next to the ±12 % focal length, and it is not there.
2. **`f_px` is still a metadata prior.** The plan assumed `AVCaptureDevice` intrinsics; nothing
   reads them, so `fPxIsPrior` is always true and the ±12 % systematic is live. Every fit in §5
   carries `fpx_is_prior(+-12%_on_v0)`. (The `integrate` agent's risk 1 — confirmed, not new.)
3. **Digital pinch zoom is unmodelled and invisible** (`integrate` risk 2). Combined with 1 and 2,
   three independent multipliers land on one displayed distance.
4. **A production build from this branch is not the binary that shipped** (§3c(1)): ~5.9 MB of Core
   ML, ~5,200 lines of Swift, a `CoreML` link, three SQLite columns and 5,513 lines of TypeScript,
   all inert but all present. Nothing to fix — but "byte-identical" should be said as "identical in
   behaviour", because it is not identical in bytes.
5. **`mcSamples = 64` makes σ(carry) noisy by ±0.2–0.7 m** in both implementations (§5c). It does
   not reach the label today, because `sigmaTotal` is dominated by the f_px term. It would start to
   matter the moment intrinsics land and that term collapses — at which point the default should go
   up, and it is a one-line change.
6. **The scratch files `docs/tracer-v3/tracer-detect-core-check.swift` (37 KB) and
   `tracer-detect-core-params.py`** are the `native-detect` agent's working files, not documentation.
   They reach no build. Worth removing before merge.
7. **Never `git add -A` on this branch.** Seven untracked paths in this tree predate the session
   (`.vercel/`, `clippar_app/reg90.txt`, `clippar_mount/`, `logo_transparent/`, `migration/`,
   `CLIPPAR_PTY_LTD_APPLE_ACCOUNT.md`, `clippar_app/.playwright-mcp/`) and would be swept into the
   tracer commit. Name the paths.

**No test was deleted, skipped, weakened or marked `todo` to reach green**, and no failing test was
left behind. The only test edit widened one regex whose intent is unchanged, and added one alongside
it.
