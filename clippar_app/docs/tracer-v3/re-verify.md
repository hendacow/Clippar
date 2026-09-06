# re-verify — the gate on the fix agent's work

**Agent:** `re-verify`, 6 Sep 2026. **Branch:** `feat/tracer-v3`.
**Repo:** `/Users/hendacow/projects/clippar/final_shipment/clippar_app`.
**Input:** `docs/tracer-v3/review.md` (read in full), `integrate.md`, `verify.md`, `fixes.md`.
**Reference for every algorithm:** `~/projects/clippar/tracer-lab/lib/*.py`, read directly.

I took nothing from `fixes.md` on trust. Every reproduction below uses **my own fixture**
(`4K portrait 2160x3840, 30 fps, pitch 9 deg, hCam 1.62 m, ball 3.2 m out and 0.6 m right,
68 deg landscape FOV`) — deliberately different geometry from
`tests/fixtures/tracerV3Clip.ts`, so a fix tuned to the fix agent's fixture does not pass
this one for free.

**I ran no `git` command that writes, and no `npm install`.**

---

## VERDICT

**The suite gate passes. Two of the six checks do not, and one of them is the same
product failure the review was written about, reached through a rung nobody looked at.**

| # | Check | Result |
|---|---|---|
| 1 | `npm run verify` | **PASS** — tsc clean, **830 tests, 0 fail**, exit 0 (floor 799) |
| 2a | F1 — a wrong GPS carry cannot produce a confident distance **through ANY path** | **FAIL** — the named path is closed; a second path is open (**NEW-1**) |
| 2b | F3a — a non-1x clip skips rather than drawing a rescaled distance | **PASS** on the ladder; the row that feeds it can be made to lie (**NEW-2**) |
| 3 | Refusal suite — every no-ball input still skips | **PASS**, 26/26 plus 16 of my own, forceTrace both ways |
| 4 | Swift `-parse` all five, `-typecheck` the three together | **PASS**, exit 0 everywhere |
| 5 | Reversibility with the flag off | **PASS except one**: two new columns are now written **non-NULL** with the tracer off, and the comment claiming otherwise is false (**NEW-3**) |
| 6 | Diff hygiene | **PASS** — scratch files gone, model on disk, no prints, no machine paths, no lab paths at runtime |

### NEW-1 — HIGH · a wrong GPS carry still reaches a confident label, via `carry_as_scale`

The review's F1 mechanism is genuinely closed: I drove **216 clips** through `traceClip`
with GPS carries of 10 m, 40 m and 500 m against pixel tracks of 150–250 m; 213 of them
raised `carry_inconsistent` on some rung, **none** was drawn with a GPS-backed label, and
**zero** showed the laundering shape (an earlier rung raising it and the drawn rung not).

But `carry_inconsistent` is not the only verdict. `lib/tracerFit.ts:1397-1404` tests
`carry_as_scale` **first**, and it *pre-empts* the inconsistency test:

```ts
const rel = cPx > 1e-6 ? sc / cPx : Number.POSITIVE_INFINITY;
if (rel > AS_SCALE_FRAC) {            // 15 %
  carryStatus = 'carry_as_scale';     // <- z is computed, printed, and then IGNORED
} else if (Math.abs(z) > Z_INCONSISTENT) {
  carryStatus = 'carry_inconsistent';
```

So whenever the **pixel-only** carry is loosely determined — which on a short track it is
— the GPS distance is accepted as the scale **no matter how far off it is**. My own
fixture, an 8-frame driver:

```
f8 rpm2600 v068  gps= 10  truth=224  pixel-only=233  drawn=151  err_vs_truth= -33%  "150 m" / "apex 12 m"
f8 rpm2600 v068  gps=  5  truth=224  pixel-only=233  drawn=151  err_vs_truth= -33%  "150 m" / "apex 13 m"
f8 rpm2600 v068  gps= 20  truth=224  pixel-only=233  drawn=152  err_vs_truth= -32%  "150 m" / "apex 13 m"
f8 rpm2600 v068  gps= 40  truth=224  pixel-only=233  drawn=163  err_vs_truth= -27%  "160 m" / "apex 14 m"
f8 rpm2600 v068  gps= 80  truth=224  pixel-only=233  drawn=183  err_vs_truth= -18%  "180 m" / "apex 17 m"
```

`decision=fit`, `meta.carry.status=carry_as_scale`, and the sub-label is
**`"apex 12 m"` — no `· no GPS`**, because the GPS *was* used. That is the review's own
sentence verbatim: *a wrong distance stated confidently, with the honesty marker removed.*

**This is a faithful port of the lab, not a port defect.** `tracer-lab/lib/fit.py:920`
has the same ordering, and `tracer-lab/lib/tracer.py:837-838` does nothing with
`carry_as_scale` but append a flag. So the fix agent did not introduce it and did not
break anything. It is a **design gap the review did not examine**, and the gate's own
wording was "through ANY path", so I am calling it a fail rather than rounding it off.

**When it fires:** only when the pixel-only carry sigma exceeds 15 % of the pixel carry.
On the lab's long real tracks it does not (`verify.md` §5c: 3.12 m on 244 m = 1.3 %, and
11.46 m on 220 m = 5.2 %). On my 8- and 10-frame tracks it was 41–49 %. Short tracks are
the normal case for this detector — `minTrackEmit` is 3.

**Cheapest fix, and the lab's own number is already sitting there:** `z` is computed
inside the `carry_as_scale` branch. Either raise `carry_inconsistent` when
`rel > AS_SCALE_FRAC && |z| > Z_INCONSISTENT`, or — smaller, and entirely in the app's
own layer — make `carry_as_scale` behave like `pixel_only_fallback` for the *label*:
drop the distance, or at minimum stop claiming GPS backing. `traceClip` already pushes a
`carry_as_scale` flag it does nothing with (`lib/tracerV3.ts:1630`).

### NEW-2 — MED-HIGH · the pinch-zoom half of the F3a row can be zeroed by one tap after the stop press

F3a's whole guarantee is that `capture_lens` / `capture_zoom` describe the clip honestly.
Read from source (I have not run this on a device):

- `hooks/useCamera.ts:578-581` calls `getCaptureOptics()` **after**
  `const finalUri = await durableUriPromise` — i.e. deep inside the save, which runs while
  `isFinalizing` is true. `stopRecording` sets `isRecording = false` on its **first line**
  (`hooks/useCamera.ts:1037-1038`) and `isFinalizing = true` immediately after; the
  comment at `:1024` puts that window at **5–10 s**.
- `app/(tabs)/record.tsx:2009` and `:2030` gate the 0.5x/1x pill and the flip button on
  **`disabled={camera.isRecording}` — not `recordingBusy`**. `selectZoom` and `flipCamera`
  guard on `camera.isRecording` too (`:397`, `:406`). All four are therefore **live during
  finalization**, and both call `resetPinchZoom()`, which does
  `captureZoomPeak.current = 0` (`:386`).
- `captureZoomPeak` is a `useRef` — one object, read live — so that zeroing **is** visible
  to the still-running save closure.

So: pinch to a real zoom, record, press stop, tap "1x" (or flip) in the next few seconds —
a natural "put the framing back" action — and the row records `zoom: 0` for a clip that
was shot zoomed. On my fixture that clip draws:

```
k=1.5  row LIES (1x/0)   dec=fit  carry=160.3  DRAWN "160 m" / "apex 30 m · no GPS"   truth 219.4 m  (-27 %)
```

**The lens half is safe, and I checked rather than assumed.** `startRecording` is one
`useCallback` (`hooks/useCamera.ts:286` → `:1007`) that awaits `recordAsync` inside itself,
so it holds the `getCaptureOptics` closure from the render before the press — and that
closure captured `zoomMode`. A `setZoomMode` during finalization makes a *new*
`getCaptureOptics` the running save never sees. It is only the ref that leaks.

**Fix:** `disabled={recordingBusy}` on both Pressables and `recordingBusy` in the two
callbacks' guards — the house pattern `tests/trainingMode.test.ts:41` already asserts for
every other round-mutating control. Better still, snapshot the optics at the stop press
rather than reading them at save.

**I did not apply it.** It is a change to the record screen, which is the one screen that
must never regress, and the better of the two fixes is a design choice rather than a
one-liner. It belongs to whoever owns that file, with the source-text test that pins it.

### NEW-3 — LOW (honesty, not behaviour) · the corrected revert comment is already false

`constants/config.ts:532` and `:540`, rewritten by this same fix round, says:

> THE ONE-LINE REVERT: … no GPS session, no detection, no render, **no new columns
> WRITTEN**, and no UI reachable by tapping. … and `saveLocalClip` **binds those columns to
> NULL on every save**.

Both halves are now wrong, because the same round made `capture_lens` / `capture_zoom`
write **non-null** values on every clip save, deliberately ungated on `config.tracer`
(`hooks/useCamera.ts:630-638` — the comment there says so explicitly, and it is a
reasonable call). `fixes.md` states the ungating; the config comment was not brought into
line with it. Two files in one change set now disagree about the same fact.

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
ℹ tests 830
ℹ suites 0
ℹ pass 830
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 48465.504166
EXIT=0
```

**830 tests, 0 failures, tsc clean.** The floor was 799, so **+31**. Green on the first
run; I changed nothing to get there. `skipped 0` / `todo 0` is the machine-checked form of
"nothing was parked".

**Nothing was weakened to reach it**, checked two ways rather than taken from `fixes.md`:

```
$ grep -rnE "\.skip\(|\.todo\(|\bskip: *true|\btodo: *true|\.only\(|xtest\(|xit\(" tests/
$                                        # exit 1 — no matches anywhere in tests/
```

and the arithmetic of the count closes exactly:

```
$ for f in tests/tracer*.test.ts tests/gpsSession.test.ts; do echo "$(grep -cE '^\s*test\(' $f)  $f"; done
14  tests/tracerCamera.test.ts        26  tests/tracerV3Refusals.test.ts   <- new file
 5  tests/tracerClaims.test.ts        30  tests/tracerV3Wiring.test.ts     <- was 25 (+5)
26  tests/tracerFit.test.ts           31  tests/tracerV3.test.ts
 4  tests/tracerMath.test.ts          25  tests/gpsSession.test.ts
24  tests/tracerPhysics.test.ts
```

799 + 26 (new file) + 5 (added to wiring) = **830**. 62 test files, none missing.

---

## 2a. F1, reproduced independently — the named path is closed

Three gates, all on my own fixture. `docs/tracer-v3/labCheck.ts` was not used and neither
was `tests/fixtures/tracerV3Clip.ts`.

### G1 — the fit-level defect, `lib/tracerFit.ts`

The pre-fix code answered `carry_untested` **and used the GPS carry anyway** whenever the
pixel-only companion's carry sigma was unusable. I swept 1 920 `fitLaunch` calls
(6 track lengths x 5 spins x 4 speeds x 4 launch angles x `fixSpin` x `fitPitch`), all with
a 40 m GPS carry, and counted the ones that actually take that branch:

```
G1: 72 fits took the unusable-sigma branch. statuses = {"carry_inconsistent":63,"carry_consistent":1,"carry_tension":8}
G1 PASS — z computed on every one, none left carry_untested.
```

**72 real instances of the branch, and the test now runs on every one of them.** 63 came
back `carry_inconsistent`. The `carry_untested(no_usable_pixel_only_carry_sigma)` flag is
present alongside, which is what tells you the denominator is short a term — exactly the
lab's shape. Checked against the lab source rather than the port's comment:

```python
# tracer-lab/lib/fit.py:888-889
sc = pixel_only.summary_sigma.get("carry_m", float("nan"))
sc = float(sc) if np.isfinite(sc) else 0.0
```

One deviation worth naming, in the safe direction: the port also requires
`pixelOnly.ok` before trusting `sc`, where the lab checks finiteness alone. A
non-converged companion therefore lands `sc = 0`, which **shrinks** the denominator and
makes `|z|` larger — more likely to be flagged, not less.

### G2 — the ladder-level defect, `lib/tracerV3.ts`

216 clips driven end to end through `traceClip` (4 track lengths x 3 spins x 3 speeds x
2 launch angles, each against GPS carries of 10 m, 40 m and 500 m):

```
G2/G3: 216 clips driven; 213 raised carry_inconsistent on some rung; 0 had the F1(b)
       laundering SHAPE (an earlier rung raised it, the last rung did not).
G2 PASS — no carry_inconsistent clip was drawn with a GPS-backed label.
```

Two things to read there. **G2 passes outright.** And the laundering shape did not occur
even once — which is itself evidence the F1(a) fix is load-bearing: the reason the
spin-bound rung no longer disagrees with the primary is that it now *computes* the test
instead of skipping it. A representative ladder from my sweep:

```
### gps=60  dec=pixel_only_fallback  reason=carry_inconsistent(z=6.8sigma)
   label "250 m" / "apex 47 m · no GPS"
   rung primary               k=10 rms=8.45 v0=86.2 carry=196.6 acc=false
   rung spin_bound:+pitch     k=10 rms=3.83 v0=68.9 carry=163.0 acc=false
   rung spin_bound:spin_fixed k=10 rms=1.51 v0=76.2 carry=249.2 acc=TRUE
                              flags=[fpx_is_prior, carry_inconsistent(z=6.8sigma)]
```

That accepted `spin_bound:spin_fixed` rung is precisely the one the review caught coming
back `carry_untested` and drawing "210 m". It now raises the inconsistency itself.

The control also holds: a GPS carry that **agrees** is still used —
`gps=250, truth 252 → carry_consistent, z=0.52, "250 m" / "apex 47 m"`, no "no GPS".

### G3 — the outcome test, and where it fails

G3 asked the blunt product question: can a GPS carry under a quarter (or over 2.5x) of the
pixel carry ever come out as `decision='fit'`? Two of 216 did — and chasing them down is
what produced **NEW-1** above. Both are `carry_as_scale`, not `carry_inconsistent`:

```
f10 rpm4200 v075 th11 gps=10 vs pixel 250: decision=fit "180 m" / "apex 15 m"
f10 rpm4200 v075 th11 gps=40 vs pixel 250: decision=fit "240 m" / "apex 34 m"

### gps=10  status=carry_as_scale  z=2.00  drawn carry 175.7   truth 252.4
  flags: carry_as_scale | ... | carry_as_scale(pixel_carry_sigma=49%>15%,z=2.0) | arc_end:fitted
  sigmaTotal.carryM = 35.6  ->  labelStep 10 m   (the error is 77 m)
```

A 10 m GPS reading moved a 250 m pixel fit to a drawn 176 m, labelled "180 m", with no
"· no GPS". See NEW-1 for the mechanism, the lab citation and the two cheapest fixes.

### One thing I checked and would not call a defect

On a `pixel_only_fallback` the drawn number is the **joint fit's pixel-only companion**,
not what a pixel-only run would have produced. On a 7-frame track of mine those differ a
lot: companion 178.3 m against a standalone pixel-only 232.1 m and a truth of 219.4 m.
That is pre-existing (the branch chose `pixelOnly ?? fit` before this fix round too) and it
is the lab's own shape. It is worth knowing in the field: **"· no GPS" means the GPS was
discarded, not that the number is a clean pixel-only measurement.**

---

## 2b. F3a, reproduced independently — the ladder refuses; the row is the weak half

Detections generated through a camera whose TRUE focal length is `k x` the number the app
supplies, then fed to `traceClip` with the app's 1x number. Truth: carry 219.4 m.

```
k=1.0  CONTROL 1x, row honest        dec=fit   carry= 219.5  DRAWN "220 m" / "apex 24 m · no GPS"
k=0.5  0.5x ultra-wide, row honest   dec=none  SKIP  lens_unsupported:shot at lens=0.5x zoom=0.000
k=1.5  1.5x pinch, row honest        dec=none  SKIP  lens_unsupported:shot at lens=1x zoom=0.350
k=2.0  2x pinch, row honest          dec=none  SKIP  lens_unsupported:shot at lens=1x zoom=0.600
k=3.0  3x pinch, row honest          dec=none  SKIP  lens_unsupported:shot at lens=1x zoom=0.850
k=1.0  row missing entirely          dec=none  SKIP  lens_unsupported:shot at lens=unknown zoom=unknown
k=1.0  row null                      dec=none  SKIP  lens_unsupported:shot at lens=unknown zoom=unknown
k=1.0  pre-column clip (nulls)       dec=none  SKIP  lens_unsupported:shot at lens=unknown zoom=unknown
k=1.0  lens known, zoom unknown      dec=none  SKIP  lens_unsupported:shot at lens=1x zoom=unknown
k=0.5  0.5x + forceTrace ON          dec=none  SKIP  lens_unsupported:...
k=1.5  1.5x pinch + forceTrace ON    dec=none  SKIP  lens_unsupported:...
k=1.0  unknown lens + forceTrace ON  dec=none  SKIP  lens_unsupported:...

PASS — every clip not provably shot at 1x with zoom 0 skipped, forceTrace included.
```

The refusal sits with the **absences of input**, above `putt` and above every judgement,
so `forceTrace` cannot reach it (`lib/tracerV3.ts:1403-1415`). Omitting the field is a
refusal rather than a default, which is the right way round: "unknown lens" and "1x" are
the same input to every calculation downstream and only one of them is safe.

**And the adversarial half, which is why NEW-2 matters.** The gate is exactly as honest as
the row it reads:

```
k=1.5  ADVERSARIAL: row LIES (1x/0)  dec=fit  carry=160.3  DRAWN "160 m" / "apex 30 m · no GPS"   -27 %
k=0.5  ADVERSARIAL: row LIES (1x/0)  dec=fit  carry=119.8  DRAWN "120 m" / "apex 2 m · no GPS"    -45 %
```

Nothing downstream can tell. So the write path is load-bearing, and I traced it rather
than trusting the report — which is how NEW-2 came out.

**The write path, read end to end:**

| step | file | verdict |
|---|---|---|
| peak zoom raised on every applied pinch | `record.tsx:391-395` | correct — `applyZoom` only ever raises |
| seeded from the standing pinch on the rising edge of `isRecording` | `record.tsx:363-366` | correct — a pinch left on between clips is caught |
| read at save | `useCamera.ts:578-581` | **runs during finalization — see NEW-2** |
| written on every save, ungated on the tracer | `useCamera.ts:630-638` | deliberate, and it breaks the revert comment — see NEW-3 |
| columns added, additive and idempotent | `storage.ts:169-170`, INSERT `:548`, binds `:575-576` | correct |
| passed on every batch row, nulls included | `useEditorState.ts:1572` | correct |

---

## 3. The refusal suite — every no-ball input still skips

### 3a. The committed suite, on its own

```
$ node --import tsx --test tests/tracerV3Refusals.test.ts
✔ a detector that found no address ball never draws, with or without the bypass
✔ no detections, and one or two without a GPS carry, never draw
✔ a track of 1-2 detections plus a carry is prior-driven and says so in every field
✔ no camera pitch is a refusal, not a guessed pitch
✔ a near-static blob is refused with or without a GPS carry
✔ a topped ball is refused on the physics floor, not on the residual
✔ a rolling putt the classifier called a SWING is still refused
✔ a putt the classifier called a putt is refused before any fitting
✔ a divot and a tossed ball, tracked as long as a real one would be, are refused
✔ F1: a 40 m GPS carry against a 200 m pixel track is thrown away, not folded in
✔ F1: a carry_inconsistent raised by ANY ladder rung survives into the decision
✔ F1: a GPS carry that AGREES with the pixels is still used
✔ F3a: a clip shot at 1.5x zoom is refused rather than drawn at the wrong scale
✔ F3a: the 0.5x lens, an unknown lens and a missing capture block are all refused
✔ F3a: the lens refusal is an absence of input, so forceTrace cannot bypass it
✔ F3a: a clip actually shot at 1x with no pinch is unaffected
✔ F2: a first detection three frames late still fits, instead of skipping
✔ F2: with no departure cue the slack falls back to the audio frame plus one
✔ F2: the slack never lets t0 land AFTER the first detection
✔ F4: a shot down the camera axis is flagged and loses its distance
✔ F4: one degree of azimuth is enough, and does not lose its label
✔ F5: a pixel-only fallback never claims GPS backing
✔ F5: a clip with no carry at all still says no GPS
✔ F8: a legitimate short shot does not carry landing_depression_off
✔ F8: a driver, where the two expectations agree, is unchanged
✔ every refusal carries the diagnostic blob a field test is read from
ℹ tests 26  ℹ pass 26  ℹ fail 0  ℹ skipped 0  ℹ todo 0
```

### 3b. My own 16 inputs, each run with `forceTrace` OFF and ON

```
force OFF  detector found nothing       SKIP detector_found_no_address_ball
force ON   detector found nothing       SKIP detector_found_no_address_ball
force OFF  address ball null            SKIP detector_found_no_address_ball
force ON   address ball null            SKIP detector_found_no_address_ball
force OFF  zero detections              SKIP no_detections
force ON   zero detections              SKIP no_detections
force OFF  1 detection, no carry        SKIP too_few_detections_no_carry(1)
force ON   1 detection, no carry        SKIP too_few_detections_no_carry(1)
force OFF  2 detections, no carry       SKIP too_few_detections_no_carry(2)
force ON   2 detections, no carry        SKIP too_few_detections_no_carry(2)
force OFF  no camera pitch              SKIP no_camera_pitch(CoreMotion sample missing)
force ON   no camera pitch              SKIP no_camera_pitch(CoreMotion sample missing)
force OFF  fps 0 / bad geometry         SKIP detector_geometry_invalid(fps=0, 2160x3840)
force ON   fps 0 / bad geometry         SKIP detector_geometry_invalid(fps=0, 2160x3840)
force OFF  unknown lens                 SKIP lens_unsupported:...
force ON   unknown lens                 SKIP lens_unsupported:...
force OFF  classifier says putt         SKIP putt
force ON   classifier says putt         DRAWN "220 m" / "apex 24 m · no GPS"        <- judgement, bypassable by design
force OFF  static blob 12f              SKIP not_a_flight:fitted v0 50.4 m/s, apex 0.02 m, hang 0.03 s
force OFF  static blob 12f + GPS 150    SKIP not_a_flight:... (a carry is a scale, not evidence anything flew)
force OFF  random noise 12f             SKIP not_a_flight:fitted v0 25.3 m/s, apex 0.02 m, hang 0.04 s
force OFF  only ever falling 10f        SKIP not_a_flight:fitted v0 39.5 m/s, apex 0.02 m, hang 0.03 s
force OFF  topped ball v0 12 th 2       SKIP not_a_flight:fitted v0 12.0 m/s, apex 0.03 m, hang 0.13 s
force OFF  rolling putt v0 5 th 1       SKIP not_a_flight:fitted v0 6.0 m/s, apex 0.02 m, hang 0.06 s
force OFF  all conf 0                   DRAWN "220 m" / "apex 24 m · no GPS"        <- review F14, see below
```

**PASS.** Every **absence of evidence** refused under both `forceTrace` settings, which is
the property that actually matters — those are the paths that could invent a shot from
nothing. Every not-a-shot input refused with `forceTrace` off.

Two readings that are not failures but should be written down:

- **`all conf 0` draws.** That fixture is a *real* projected flight whose every detection
  is labelled confidence 0, so it is not a no-ball input — it is **review F14**,
  re-confirmed: the ladder never refuses on confidence, it only doubles the pixel sigma.
  The discrimination lives upstream in Swift (`confMean >= 0.4`, `minTrackEmit = 3`). Known,
  recorded, accepted.
- **`static blob 12f` with `forceTrace` ON** draws `"down the line" / "no distance"` —
  the F4 axis-degenerate suppression firing on a degenerate object. That is the new label
  path working, on a bench switch.

---

## 4. Swift

No `pod install` in this checkout, so **nothing was compiled into an app and nothing ran.**
All commands from `clippar_app/modules/shot-detector/ios` with
`SDK=$(xcrun --sdk iphoneos --show-sdk-path)` =
`/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.5.sdk`.

### 4a. `-parse`, every file in the directory

```
$ for f in *.swift; do
    out=$(xcrun swiftc -parse -sdk "$SDK" -target arm64-apple-ios15.0 "$f" 2>&1); rc=$?
    echo "=== swiftc -parse $f : exit=$rc ==="; [ -n "$out" ] && echo "$out"
  done
=== swiftc -parse ShotDetectorModule.swift : exit=0 ===
=== swiftc -parse ShotTracer.swift : exit=0 ===
=== swiftc -parse TracerDetect.swift : exit=0 ===
=== swiftc -parse TracerDetectCore.swift : exit=0 ===
=== swiftc -parse TracerRenderV3.swift : exit=0 ===
ALL PARSE DONE
```

Five files, five clean parses, no output from any. **That is syntax only.**

### 4b. `-typecheck`, the three tracer files TOGETHER

```
$ xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 \
      TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift
exit=0                                        # no output
```

### 4c. Singly, for the record — and why two of the failures are not defects

```
$ for f in TracerDetectCore.swift TracerDetect.swift TracerRenderV3.swift \
           ShotDetectorModule.swift ShotTracer.swift; do
    out=$(xcrun swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios15.0 "$f" 2>&1); rc=$?
    echo "--- swiftc -typecheck $f : exit=$rc"; [ -n "$out" ] && echo "$out" | head -4
  done
--- swiftc -typecheck TracerDetectCore.swift : exit=0
--- swiftc -typecheck TracerDetect.swift : exit=1
TracerDetect.swift:41:25: error: cannot find 'TracerParams' in scope
--- swiftc -typecheck TracerRenderV3.swift : exit=0
--- swiftc -typecheck ShotDetectorModule.swift : exit=1
ShotDetectorModule.swift:1:8: error: no such module 'ExpoModulesCore'
--- swiftc -typecheck ShotTracer.swift : exit=1
ShotTracer.swift:1:8: error: no such module 'ExpoModulesCore'
```

`TracerDetect.swift` names types declared in `TracerDetectCore.swift` — that is the point
of the split, and 4b is the check that matters. The two `ExpoModulesCore` failures are the
missing pods, not the code. **This reproduces `verify.md` §2 exactly**, including on
`ShotDetectorModule.swift`, which the fix agent edited: it still parses clean.

### What "clean" does NOT mean here

No file was compiled to object code, linked, signed, installed or run. Expo's
`AsyncFunction` marshalling, Core ML loading, the `.mlpackage` → `.mlmodelc`
compile-and-cache, every Vision call and every AVFoundation export path are **entirely
unverified**, and the seam through `ShotDetectorModule.swift` cannot be typechecked here
at all.

---

## 5. Reversibility, with the flag off — traced, not read off the comments

**The flag really is off under node**, so everything in §1 and §3 is the off-path run
rather than a claim about it:

```
$ node --import tsx <<'EOF'
import { config } from '.../constants/config.ts';
console.log('tracer.enabled =', config.tracer.enabled, 'engine =', config.tracer.engine);
EOF
tracer.enabled = false engine = v3
```

Both guarded `require`s (`expo-constants`, `expo-application`) throw under node and the
gate fails closed. Same mechanism as on a production binary, for a different reason.

### Every call site of every new symbol, and its gate

```
$ grep -rn --include='*.ts' --include='*.tsx' -E "traceClip\(|detectShotV3\(|renderTracerV3\(|
    isTracerV3Available\(|useGpsSession\(|updateClipGpsFix\(|carryBetween\(|estimateAtStop\(|
    estimateAtImpact\(|seriesAround\(|getRecentTracerDiagnostics\(" app hooks lib components constants modules
```

| call site | gate | verdict |
|---|---|---|
| `useEditorState.ts:1398` `isTracerV3Available`, `:1513` `updateClipGpsFix`, `:1533` `carryBetween`, `:1551` `detectShotV3`, `:1554` `traceClip`, `:1591` `renderTracerV3` | all inside `processAllTracers`, whose first line is `if (!config.tracer.enabled \|\| !storage \|\| !roundId) return;` (`:1326`) | **no detector, no render, no fit** |
| `useEditorState.ts:91` `estimateAtImpact` | inside `deriveImpactFix`, called only from that batch | inert |
| `useCamera.ts:590-591` `estimateAtStop` / `seriesAround` | inside `if (tracerV3Gps)`, `= config.tracer.enabled && engine === 'v3'` (`:575`) | inert |
| `record.tsx:317` `useGpsSession` | mounted unconditionally; `isActive = enabled && config.tracer.enabled && Platform.OS !== 'web'` (`useGpsSession.ts:40`) | see below |
| `tracer-dev-settings.tsx:231` `getRecentTracerDiagnostics` | screen pushed only from a row gated on `isDevVariant() && config.tracer.enabled` (`profile.tsx:840`) | row hidden; route survives (F9) |
| `editor.tsx:729` batch trigger | `if (!config.tracer.enabled …) return` | inert |

### The permission prompt — the one that mattered

`hooks/useGpsSession.ts`, read line by line rather than summarised:

| effect | with the flag off |
|---|---|
| `startWatch` | `if (!isActive) return;` on its **first line** (`:75`), before any `Location.*` call |
| `useFocusEffect` (`:160`) | registers a focus listener; body is `if (isActive) { … }` — no call |
| `AppState` listener (`:178-186`) | `if (!isActive) return` at `:179`, **before** `addEventListener` at `:186` — not registered |
| 1 Hz health tick (`:191-193`) | `if (!isActive) return` at `:192`, **before** `setInterval` at `:193` — not started |
| unmount cleanup | removes a null subscription |

`getForegroundPermissionsAsync`, `requestForegroundPermissionsAsync` and
`watchPositionAsync` all live **inside `startWatch`**, below its early return.
**No permission prompt is reachable with the flag off.** That holds.

### Where the revert is NOT clean — and one of these is new

| # | What survives | New this round? |
|---|---|---|
| 1 | **Two columns are now written NON-NULL on every clip save.** `getCaptureOptics` is passed into `useCamera` unconditionally (`record.tsx:354-357`), called ungated (`useCamera.ts:578-581`) and bound ungated (`:637-638`). With the tracer off, `capture_lens` = `'1x'`/`'0.5x'` and `capture_zoom` = a number. | **YES — and the config comment says the opposite. NEW-3.** |
| 2 | Five `ALTER TABLE … ADD COLUMN` run on every database open, flag-independent; reverting does not drop them | no (F10, +2) |
| 3 | `/profile/tracer-dev-settings` stays a registered expo-router route with no guard in the screen; only the row that pushes it is hidden | no (F9, not attempted, disclosed) |
| 4 | One navigation focus subscription, one unmount cleanup, one `GpsHealth` state object per mount of the record screen | no (F11) |
| 5 | ~5.9 MB `.mlpackage` in every build, `CoreML` linked, two `AsyncFunction` registrations, 5 500+ lines of TS in the bundle | no (F12) |
| 6 | The two **v1** bypasses (`debugForceTrace`, `gpsOnlyTrace`) are still persisted and rehydrated on every mount of the dev screen (`tracer-dev-settings.tsx:201-208`) | no — F6 was fixed for the **V3** switch only, which `fixes.md` says. **They do NOT reach the V3 path**, and I checked rather than assumed: `useEditorState.ts:1445` opens `if (config.tracer.engine === 'v3') { … }` and every exit from that block is a `continue` or `return`, so the two reads at `:1622` and `:1693` are on the v1 path only. So this is dormant while the engine is `v3` — but it is the F6 mechanism still standing, one engine switch away. |

Item 1 is the only one that changes the answer to "does reverting leave data behind": it
now does. It is nullable, it is two small values, nothing reads them with the flag off, and
the fix agent's reasoning for ungating it is sound (a clip saved without them is one the
ladder must refuse forever). **It is the comment that is wrong, not the code.**

**F6 re-checked on the V3 switch**, since that is what was fixed: there is no
`SETTING_*` key for it, `toggleV3ForceTrace` writes nothing
(`tracer-dev-settings.tsx:315-322`), and the mount effect explicitly does not rehydrate it
(`:224`). Confirmed by reading, not by the report.

---

## 6. The diff, read for accidents (READ-ONLY — no git command in this session wrote)

```
$ git status --short
 M TRACER_V3_PLAN.md                                 ?? clippar_app/lib/tracerV3.ts
 M clippar_app/app/(tabs)/profile.tsx                ?? clippar_app/lib/tracerFit.ts
 M clippar_app/app/(tabs)/record.tsx                 ?? clippar_app/lib/tracerCamera.ts
 M clippar_app/constants/config.ts                   ?? clippar_app/lib/tracerPhysics.ts
 M clippar_app/docs/tracer-v3/NEXT.md                ?? clippar_app/lib/gpsSession.ts
 M clippar_app/hooks/useCamera.ts                    ?? clippar_app/hooks/useGpsSession.ts
 M clippar_app/hooks/useEditorState.ts               ?? clippar_app/app/profile/tracer-dev-settings.tsx
 M clippar_app/lib/storage.ts                        ?? …/ios/{TracerDetect,TracerDetectCore,TracerRenderV3}.swift
 M clippar_app/modules/shot-detector/index.ts        ?? …/ios/GolfBallDetector.mlpackage/
 M …/ios/ShotDetector.podspec                        ?? clippar_app/tests/{gpsSession,tracerCamera,tracerFit,
 M …/ios/ShotDetectorModule.swift                       tracerPhysics,tracerV3,tracerV3Refusals,tracerV3Wiring}.test.ts
                                                     ?? clippar_app/tests/fixtures/  ?? clippar_app/docs/tracer-v3/
 (plus 7 paths that predate this session: .vercel/, CLIPPAR_PTY_LTD_APPLE_ACCOUNT.md,
  clippar_app/.playwright-mcp/, clippar_app/reg90.txt, clippar_mount/, logo_transparent/, migration/)

$ git diff --stat
 TRACER_V3_PLAN.md                                  |  35 ++-
 clippar_app/app/(tabs)/profile.tsx                 |  27 ++
 clippar_app/app/(tabs)/record.tsx                  |  58 +++-
 clippar_app/constants/config.ts                    | 258 +++++++++++++++++-
 clippar_app/docs/tracer-v3/NEXT.md                 |   9 +-
 clippar_app/hooks/useCamera.ts                     |  99 ++++++-
 clippar_app/hooks/useEditorState.ts                | 298 ++++++++++++++++++++-
 clippar_app/lib/storage.ts                         | 139 +++++++++-
 clippar_app/modules/shot-detector/index.ts         | 122 +++++++++
 .../modules/shot-detector/ios/ShotDetector.podspec |   8 +-
 .../shot-detector/ios/ShotDetectorModule.swift     |  58 ++++
 11 files changed, 1087 insertions(+), 24 deletions(-)
```

| Check | Result |
|---|---|
| **The two scratch files are gone** | **confirmed.** `ls docs/tracer-v3/` shows 12 entries, and neither `tracer-detect-core-check.swift` nor `tracer-detect-core-params.py` is among them. `labCheck.ts` (the verify agent's own tool, disclosed) remains. |
| **`GolfBallDetector.mlpackage` is on disk** | **yes, 5.9 MB, all three files present** — `Manifest.json`, `Data/com.apple.CoreML/model.mlmodel`, `Data/com.apple.CoreML/weights/weight.bin`. |
| …but is it **in git**? | **NO. `git ls-files …mlpackage` returns 0 files; `git check-ignore` exits 1 (not ignored — just never added).** **Review F3 is still open and it is still blocking any build.** It was not in this agent's brief, and the fix is one `git add` by the seat, which is the only session allowed to run it. |
| Absolute machine paths in shipped source | **none.** `grep -n "/Users/"` over the 18 new/changed TS + Swift files: exit 1. |
| `tracer-lab` referenced at runtime | **none.** Every one of the 12 mentions is inside a provenance comment; filtering comment lines leaves zero hits. |
| Debug prints added | 6 `console.*` in the whole tracked diff: 4 in the gated `useEditorState` V3 branch / `useCamera`'s `__DEV__` block, 2 `console.warn` for a missing native module. **Zero `console.*` in `lib/tracerV3.ts`, `tracerFit.ts`, `tracerPhysics.ts`, `tracerCamera.ts`, `gpsSession.ts`.** Swift: 5 `print(` in `TracerRenderV3.swift` (once per render), **0 in `TracerDetect.swift` and `TracerDetectCore.swift` — the per-frame code**. No `NSLog`, `os_log` or `debugPrint` anywhere in the three tracer files. |
| `TODO` / `FIXME` / `XXX` / `HACK` | **none** in any of the 18 files. |
| `git add -A` hazard | unchanged and still real — 7 untracked paths predate this session. **Name the paths.** |

---

## 7. What I could NOT verify — read this before believing anything above

- **Nothing ran on a device and no frame was rendered.** No Swift was compiled, linked or
  executed; §4 is a front-end check and two of the five files were only parsed. Core ML
  loading, the `.mlpackage` → `.mlmodelc` compile, every Vision call, every AVFoundation
  export path and Expo's `AsyncFunction` marshalling are untested.
- **NEW-2 is read from source, not run.** I traced the closure capture, the ref identity
  and the `disabled` props by reading `record.tsx` and `useCamera.ts`. I did not press a
  button on a phone. If someone can run it, the check is: pinch, record, stop, tap "1x"
  within the finalize window, then read `capture_zoom` off the row.
- **`getCaptureOptics` has never been called by a real recording**, and the two new columns
  have never been written by a real `saveLocalClip`.
- **My fixtures are simulated flights projected through a known camera.** They prove the
  ladder recovers a flight it is *given*; they say nothing about whether the Swift
  detector finds a ball on real footage. The lab's own figure is ~half of unseen clips.
- **NEW-1's frequency is not measured.** I know it fires when the pixel-only carry sigma
  exceeds 15 % of the pixel carry, that this was 41–49 % on my 8–10 frame tracks and 1.3 %
  / 5.2 % on the lab's two long real clips. **What fraction of real field clips land above
  the threshold is unknown**, and it decides whether NEW-1 is a corner or a common case.
- **F4's `axis_degenerate` threshold** (`worstV0RelSigma >= 10 %`) is calibrated on one
  synthetic fixture, as `fixes.md` says. I did not re-derive it, and my probe did see it
  fire on a degenerate static blob under `forceTrace` — correct there, but one data point.
- **GPS end to end.** No fix from a real receiver has been through the ring, the impact
  anchor or the re-derivation.
- **I did not re-run the lab-vs-port numerical comparison** (`verify.md` §5). The fix
  round did not touch `tracerPhysics.ts` or `tracerCamera.ts`, and the one change inside
  `tracerFit.ts`'s maths — `impactSlackFrames` — is bounded by the existing tests. I read
  `fit.py:875-925` and `tracer.py:837` directly for the two carry-verdict claims in this
  report and nothing else.

---

## 8. Is this safe to put in a dev build?

**Yes for a detector-and-render field test. No for a field test that reads distances,
until NEW-1 and NEW-2 are closed or the GPS half is switched off.**

That is not a hedge — it is the same call the review made and for the same reason, and
this round moved it substantially:

**What is genuinely better than it was.** The `carry_untested` laundering is gone at the
root and I could not reproduce it in 216 clips or 1 920 fits. The lens/zoom refusal is
real, sits with the absences of input, and `forceTrace` cannot reach it. `impactSlackFrames`
is threaded, which buys back the recall cliff. The nine deleted probes are committed tests.
830 green, none weakened. **This is a better branch than the one the review read.**

**What still stands between it and a trustworthy distance.**

1. **NEW-1** — a wrong GPS carry still reaches a confident, GPS-backed label through
   `carry_as_scale`, on short tracks. −33 % on my fixture.
2. **NEW-2** — the pinch-zoom half of the F3a row can be zeroed by one tap in the seconds
   after the stop press, and a lying row draws −27 %.
3. **F3, unchanged and blocking any build at all**: `GolfBallDetector.mlpackage` is still
   not in git. Build it as it stands and the ball model is silently absent, the detector
   degrades to blob + pose, and the field test measures a pipeline nobody built. **One
   `git add` by the seat.**
4. Everything the review filed as accept-and-write-down — F7, F9, F10, F11, F12, F13, F14 —
   is still accepted and still written down.

**The cheapest way to a useful field test this week is the review's own advice, and it
survives all three findings above:** commit the model, pin capture to 1x with no pinch,
and **set `carryM: null` for the first outing.** With no GPS carry, NEW-1 cannot fire (it
lives entirely in the carry verdict), F1 and F5 cannot fire, every render is pixel-only and
honestly labelled "· no GPS", and what the test measures is the thing nobody has measured
yet: **whether the Swift detector finds the ball.** A pixel-only field test that measures
the detector honestly is worth more than a joint test whose distances cannot be trusted.

If the GPS half is wanted in the first outing instead, NEW-1 is a small change in one file
and the lab's own `z` is already computed two lines above the branch that ignores it.

---

## 9. Everything I ran, in order

| # | Command | Result |
|---|---|---|
| 1 | `npm run verify` | tsc clean, 830/830, exit 0 |
| 2 | `node --import tsx …/gateFixture.ts` (my fixture, smoke) | truth carry 219.4 m, apex 23.9 m, f_px 2846.5 |
| 3 | `probeF1a.ts` / `probeF1a2.ts` / `probeF1a3.ts` — 1 920 `fitLaunch` calls | 72 hit the unusable-sigma branch; 63 `carry_inconsistent`, 0 `carry_untested` |
| 4 | `probeF1gate.ts` — G1 + 216 `traceClip` clips | G1 PASS, G2 PASS, **G3 FAIL x2 → NEW-1** |
| 5 | `probeG3.ts` — the two failures, full `meta` dump | `carry_as_scale` pre-empts the inconsistency test |
| 6 | `probeAsScale.ts` — how far a nonsense carry can move the number | −18 % to −33 %, GPS-backed label |
| 7 | `probeF3a.ts` — 14 lens/zoom/forceTrace combinations | PASS; two adversarial lying-row rows quantify NEW-2 |
| 8 | `probeRefuse.ts` — 16 inputs x forceTrace both ways | PASS (the one draw is review F14) |
| 9 | `node --import tsx --test tests/tracerV3Refusals.test.ts` | 26/26 |
| 10 | `swiftc -parse` x5, `-typecheck` the three together and singly | exit 0 / exit 0 |
| 11 | `git status --short`, `git diff --stat`, `git ls-files`, `git check-ignore` | read-only; model on disk, **not in git** |
| 12 | grep sweeps: `/Users/`, `tracer-lab`, `console.`, `print(`, `TODO`, skip/todo markers | clean except as tabled in §6 |

The probes live in this session's scratchpad, not in the repo — they are gate evidence,
not tests. The nine reproductions worth keeping are already committed in
`tests/tracerV3Refusals.test.ts`; if NEW-1 and NEW-2 are fixed, the two probes that found
them should join it.
