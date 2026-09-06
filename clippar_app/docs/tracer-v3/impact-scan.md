# impact-scan — deriving the impact from the video instead of trusting the hint

**Owner:** `impact-scan` agent. **Files owned:**
`clippar_app/modules/shot-detector/ios/TracerDetect.swift`,
`clippar_app/modules/shot-detector/ios/TracerDetectCore.swift`.
Nothing in `lib/` or `docs/tracer-v3/bench/` is touched.

Also added: `clippar_app/tests/tracerV3ImpactScan.test.ts` (14 tests) and this document.

Written incrementally. Everything below is measured on this Mac unless it says otherwise.
**Nothing here has run on a phone.**

## The short version

* The impact the app hands the detector is out by a median of **0.17 s** and a worst case of
  **5.70 s** (its primary estimator, swing-vision, compiled and run here). Half a second wrong
  makes the detector return nothing.
* The detector now **finds the impact in the video**: one bounded window, the existing address
  finder run once at the head of it, each ball-like patch followed frame by frame, and the frame
  it leaves and never returns to is the impact.
* **On the 8 hand-labelled regression clips it reproduces the hand-labelled-impact result
  exactly** — 7/8 emitted, 184 detections, mean address error 1.71 px against the reference's
  1.91 px — from hints up to 2.6 s wrong. Every derived impact is within 3 frames of the label.
* Feed one clip seven hints spanning 5.5 s and it returns the **identical** answer seven times;
  the old code returned a track on exactly one of them.
* It cut the detector from up to 17 full passes to **one**: on 14 of the 17 lab clips it
  emits, the very first impact it derives is the one that works. Across the corpus, 404 detector
  passes became 61 and 2 417 s became 671 s.
* **It does not strictly dominate the brute-force ladder** and I was wrong to assume it would.
  The ladder still emits three lab clips the scan misses, so it stays on as a fallback behind
  the scan. That is §7.3, and it is the most important thing in this document.
* **Shipped defaults vs what ships today, on the same 36 clips:** 20/36 emitted against 19/36,
  8/36 arcs drawn inside the app's own trim window against 7/36, **319 detector passes against
  404**, **1 690 s against 2 417 s**. It loses nothing and gains one.

---

## 0. The measurement rig (built first, because the result is worthless without it)

### 0.1 The app has TWO impact estimators, and the primary one is not the obvious one

`hooks/useEditorState.ts` (both import call sites, ~line 846 and ~line 1080):

```ts
(await visionDetectAndTrim(originalSourceUri, { preRollMs, postRollMs })) ??
(await detectAndTrim(...))
```

`constants/config.ts` has `detection.swingVision: true`, and `lib/visionTrim.ts` returns null
only when the module is missing, the native call rejects, or `decision !== 'SWING'`. So the
impact an imported clip normally reaches the tracer with is **swing-vision's**
(`SwingLocalizer` motion profile -> candidates -> MobileCLIP prototype scoring ->
`tImpact`), and `detectAndTrim`'s pose state machine + its +300 ms calibration is the
**fallback**.

Both were reproduced and compiled here, without ExpoModulesCore, and run over the same clips:

* `svhint` — `SwingVisionModule.localize()` over the real `SwingLocalizer.swift` and
  `SwingPose.swift`, the real `MobileCLIP2S2Image.mlpackage` and the real
  `swing_prototypes.json`. This is the PRIMARY path.
* `hintgen` — `detectAndTrim`'s path, below. This is the FALLBACK.

### 0.2 A real app-condition impact hint — the fallback path

Henry's brief says the honest test uses the impact the APP produces, not an audio-derived or
hand-labelled one. So the app's own swing detector was reproduced verbatim from
`ShotDetectorModule.swift` into a scratch tool (`AppHint.swift`, never shipped):

* `extractPoseFrames` — AVAssetReader forced to **480x640**, `orientation: .up`, every
  `max(6, fps/5)`th frame. (Note: `.up` on a portrait clip means Vision sees the golfer
  **sideways**. That is what ships.)
* `detectAudioTransients` — 22 050 Hz mono, 20 ms windows / 10 ms hop, peak > 5x local
  median, 300 ms dedupe.
* `detectSwingEvent` — the `baseline` state machine, which is what
  `constants/config.ts` selects (`strategy: 'baseline'`).
* the duration/audio fallback when the state machine finds no swing.
* `calibrateImpact` — **+300 ms**, clamped to the clip.

### 0.3 What each hint is actually worth

Both estimators run here over the 36 lab clips, compared with the nearest impact in
`tracer-lab/data/impact_sounds.csv` (a lower bound on the error, since it takes the closest of
several transients):

| | **swing-vision (PRIMARY)** | detectAndTrim (fallback) |
|---|---|---|
| median error | **0.17 s** | 0.84 s |
| within 0.5 s | **24 / 36** | 13 / 36 |
| worst | **5.70 s** | 4.93 s |

Swing-vision answered `SWING` on **100 of 100** clips tried, so the fallback essentially never
runs in the field — which makes the left column the real condition and the right column a
stress test.

The left column is much better and **it is still not good enough**. One clip in three is more
than half a second out, and the brief's §2 measurement is that half a second wrong is total
failure. The worst case is 5.7 s.

For the record on the fallback path, because it is what runs if swing-vision is ever
unavailable: its hint source across all 150 clips was `fallback-audio` 146, `fallback-mid` 2,
`fallback-nopose` 1, **`pose` 1**. Its pose state machine essentially never fires on this
footage — it reads a portrait golfer sideways, because `extractPoseFrames` hands Vision
`orientation: .up` on a 480x640 buffer — so its answer is nearly always "the audio transient
closest to the middle of the clip, plus 300 ms".

**What these proxies are and are not.** Both are re-implementations, compiled and run on this
Mac — not the shipped binaries, and not a recording of what a phone produced. The swing-vision
one links the REAL `SwingLocalizer.swift`, `SwingPose.swift`, `MobileCLIP2S2Image.mlpackage` and
`swing_prototypes.json` and reproduces `SwingVisionModule.localize()` step for step; the
fallback one transcribes `extractPoseFrames`, `detectAudioTransients`, `detectSwingEvent` and
`calibrateImpact`. Three things could still differ on a phone and none was checked: Vision's
pose model may version-differ between macOS and iOS, the JS side can pass non-default options,
and a clip reaching the tracer through `original_file_uri` carries an impact on a timeline these
proxies reproduce but do not verify. **Nothing here has run on a phone.**

---

## 1. Design

### 1.1 What was wrong with the shape, not just the number

`impactSearchOffsets` retries a FAILED detection at 17 offsets across +-3 s. Measured here on
IMG_3629 with the app's own hint (8 202 ms, truth 5 610 ms):

| | old (offset ladder) | new (scan) |
|---|---|---|
| wall clock, this Mac | **41 902 ms** | **3 859 ms** |
| full detector passes | 14 | 1 |
| detections | 47 | 45 |
| impact used | 8 202 - 2 500 = 5 702 ms | **5 600 ms** (truth 5 610) |

The ladder does eventually find it. It finds it by running the entire detector — background
stack, pose, Core ML, departure scan, tracking — fourteen times, at a coarse 8-frame grid it
then has to refine. Both rows are single runs on a quiet machine. **Nothing here has run on a
phone, so I will not tell you what fourteen passes costs on one.**

### 1.2 The scan

One pass, in four steps, and every step is machinery that already existed:

1. **A window, bounded to the clip.** `hint +- scanRadiusMs` (3.5 s), clamped so every impact
   considered leaves room for what the detector does around it — 30 frames back for the
   background stack and the address frames, 8 forward for the departure. A 4.5 s import
   (IMG_0594, the SIGTRAP from the last widening) simply gets a smaller window. §4 exercises it
   at four hints including one past the end of the clip and it does not crash on any of them;
   the clamp itself is pinned by a test.

2. **Anchor frames at the HEAD of the window.** Three frames spread over 0.6 s, all *before*
   the earliest impact the window allows. Wherever the true impact is inside the window, the
   ball is still on the ground on those three frames — that is the whole reason the scan can
   find it without already knowing when it left.

   The assumption underneath is that the ball is already placed at the head of the window. I
   suspected that was the cause of the zero-departure failures and tested it directly by moving
   the window later on IMG_3646, IMG_3648 and IMG_3663; the outcome did not change on any of
   them, so anchor placement is not what those failures are. It could still bite a clip where
   the golfer walks up and tees a ball inside the window, and I did not construct that case.

3. **The existing address finder, unchanged**, on those three frames: `TracerVisionPose` ->
   `tracerGolferGeometry` -> `TracerBallModel` (Core ML) -> `tracerAddressCandidates`, which is
   the same union of model detections, bright static blobs and colour-agnostic pose-ROI
   candidates the detector already uses, with the same ROI re-weighting. No second scorer was
   written.

4. **Follow each patch, frame by frame, to the end of the window** — literally Henry's
   "extend it out frame by frame" — and take the frame it leaves and never comes back to.

### 1.3 Why the scan is cheap

The follow pass reads **only the pixels under the candidates**. `TracerFramePump.forEachRaw`
hands the scan the raw, unrotated pixel buffer, and `boxLumaMeans` maps each candidate's
15x15-ish box backwards through the rotation instead of rotating the whole 1080x1920 frame.
Per frame that is ~24 boxes x ~200 px = ~5 000 pixel reads, against 2.07 M for a rotation
gather plus another 2.07 M for a luma plane. The anchor pass uses the same trick from the other
side: `forEach(wants:)` decodes the 19-frame span and materialises only the three frames it
wants.

**It needs no background model**, which is the thing that could not be built without knowing the
impact. The departure test only ever reads DIFFERENCES between frames of a mean over a FIXED
box, and the background is a constant offset over that box, so it cancels exactly.

### 1.4 The departure test

`tracerScanDeparture` is `tracerDepartureFrame` widened, not replaced: same one-frame step
against `departFrac * cRef`, same persistence, same `departDriftMax` drift rule, so the three
shapes that must fail there still fail. Three things are added, and each only means something
over a long series:

* **The pre-level is local** (4 x the persistence horizon). Over six seconds the sun moves.
* **The pre-window must be mostly quiet — counted, not maxed.** This one is measured. The
  ball's own patch on IMG_3629 reads 226, 224, ..., 223, then **98.5 for exactly one frame at
  f146** (a waggle putting the club over the ball), then 223 again until the real departure at
  f169. A max-deviation quietness rule threw the true ball away and left a fence post.
* **It must not come back.** Over ten frames you cannot tell a ball from a shadow crossing the
  disc; over six seconds you can, because the shadow comes back and the ball does not. At most
  `scanReturnFrac` (12 %) of the frames after the persistence horizon may return to within
  `departFrac * cRef` of the pre-step level.

It returns the **best** departure, not the first: over several seconds the first qualifying step
is often the club entering the frame.

### 1.5 Choosing between candidates

`score = departureStrength x candidatePrior x hintProximity`, where `hintProximity` is a broad
Gaussian (sigma 60 frames) mapped into **[0.35, 1.0]** — it can move a decision by at most a
factor of three, so it is a tie-break and never a gate. It exists for one reason: a clip with
two shots in it must stay on the shot the app meant.

The top `scanMaxTries` (3) derived impacts are then handed to the **unchanged** detector in rank
order, and the first that emits a track wins. That is the "prefer the candidate whose departure
is followed by a plausible launch" test, done with the real launch search and the real Kalman
gate rather than a re-implementation of them.

### 1.6 What it reports

Every row carries the impact it was GIVEN, and — whenever the scan derived one, whether or not
the detector could then use it — the impact it DERIVED:
`impactGivenMs`, `impactDerivedMs`, `impactShiftMs`, `impactSource`
(`scan` | `given` | `offset-ladder` | `none`), `impactTriesUsed`, `scanCandidates`,
`scanDepartures`, `oneOffMsImpactScan`. A field sweep can therefore tell "the detector rescued
a bad impact" from "the impact was right all along", and a systematic bias in the app's swing
detector shows up as a pattern instead of as a scattering of clips that traced nothing.

### 1.7 Reversibility

The pre-change behaviour is reachable **without a native rebuild**, through the options JSON the
JS side already passes: `{"scanEnabled": false, "scanFallbackLadder": true}` is exactly what
shipped before. That is how the before/after numbers below were measured — same binary, same
clips, same hints.


---

## 2. The lab regression set — it does not get worse

The 8 hand-labelled clips in `tracer-lab/data/labels/`. Two runs of the SAME binary (the
whole-corpus before/after against the shipped ladder is §7.3):

* **old + truth** — `{"scanEnabled":false,"scanFallbackLadder":false}` fed the hand-labelled
  `impact_frame`. This is the reference: the best the detector has ever done on these clips.
* **new + app hint** — the scan, fed the app's own impact.

`addrErr` is against `label.address`; `trkErr` is the mean position error of every emitted
detection against the hand-labelled track on the same frame.

### 2.1 New (app hint) vs the truth-anchored reference

| clip | truth f | derived f | app hint off by | new det | new addrErr | ref det | ref addrErr | trkErr (both) |
|---|---|---|---|---|---|---|---|---|
| IMG_3629 | 168 | **168** | -2.60 s | 45 | 0.45 px | 45 | 0.45 px | 0.32 px |
| IMG_3631 | 425 | **424** | -0.81 s | 34 | 4.03 px | 34 | 4.03 px | 32.92 px |
| IMG_3632 | 213 | **216** (+3) | -2.49 s | 15 | 2.60 px | 15 | 3.26 px | 0.55 px |
| IMG_3640 | 216 | **215** | -2.25 s | 4 | 2.20 px | 4 | 2.20 px | 104.05 px |
| IMG_3641 | 261 | **261** | -0.31 s | 0 | — | 0 | — | — |
| IMG_3649 | 430 | **430** | -0.15 s | 21 | 0.81 px | 21 | 1.02 px | 1.24 px |
| IMG_3650 | 217 | **216** | -1.89 s | 20 | 0.78 px | 20 | 0.78 px | 23.95 px |
| IMG_3652 | 142 | **142** | -0.31 s | 45 | 1.12 px | 44 | 1.60 px | 0.25 px |

| | old + truth (reference) | new + truth | **new + APP HINT** |
|---|---|---|---|
| emitted | 7 / 8 | 7 / 8 | **7 / 8** |
| total detections | 183 | 184 | **184** |
| mean address error | 1.91 px | 1.68 px | **1.71 px** |
| mean track error | 23.33 px | 23.33 px | **23.33 px** |

**Every derived impact is within 3 frames of the hand-labelled impact** (six of the eight are
within one), from hints that were 0.15 s to 2.60 s wrong. The scan does not merely avoid
regressing the reference — it reproduces it, detection for detection, without being told where
the impact was. The run was repeated on a second build and came back identical.

Two honest notes:

* **IMG_3641 emits nothing, and that is not the scan's doing.** It derives f261, which IS the
  labelled impact frame, and the detector still emits nothing there. It emits nothing at f261 in
  the truth-anchored reference too. That is a pre-existing detector limitation on that clip.
* **The three large track errors (IMG_3640 104 px, IMG_3631 33 px, IMG_3650 24 px) are
  byte-identical old and new.** They are pre-existing and this change neither causes nor fixes
  them.


---

## 3. Cost

Measured with the compiled harness on this Mac (M-series, 4 clips in parallel, and a second
agent's simulator harness competing for CPU for part of the run — so these are pessimistic,
not best-case). **None of it has run on a phone.**

### 3.0 What the corpora actually are, because it changes the numbers by 8x

| corpus | 1920x1080 @ 30 | 3840x2160 @ 60 |
|---|---|---|
| Henry's Downloads (64) | 44 | **20** |
| lab `inputs/` (36) | 32 | 4 |
| `jobs/*/inputs/` (50) | 47 | 3 |

A 4K60 clip is **8x the pixel throughput** of a 1080p30 one — four times the pixels, twice the
frames — and every timing below is dominated by which of the two a clip is. Quoting one median
across a mixed corpus hides that, so both are given.

### 3.1 The scan itself

Over the 36 lab clips (a ~7 s window; 200-260 frames followed at 1080p30, ~500 at 4K60):

| | 1080p30 (n=32) | 4K60 (n=4) |
|---|---|---|
| median | **1 460 ms** | 5 030 ms |
| min / max over the whole set | 708 ms | 8 680 ms |

What dominates: **H.264 decode of the window**. The scan's own arithmetic is ~24 boxes x ~200
px x ~230 frames ~= 1.1 M pixel reads for the whole clip, against 2.07 M **per frame** for a
rotation gather. The anchor pass adds three Vision pose requests and three Core ML passes
(whole-frame letterbox + ROI tiles), which is the same work one `detectOnce` already does on
its three address frames.

### 3.2 End to end, one clip

| | old (offset ladder) | new (scan) |
|---|---|---|
| IMG_3629, app hint 2.6 s wrong | **41 902 ms**, 14 detector passes | **3 859 ms**, 1 detector pass |
| lab set, detector passes | up to 17, plus 2 refinement | **1 on 23/36, 2 on 6, 3 on 2, 4 on 5** |
| lab set, median wall (3 in parallel) | 61 398 ms | **9 320 ms** scan only, 38 500 ms shipped (§7.3) |

The four-pass rows were run before `scanTryGivenLast` was measured and defaulted OFF; on the
shipped defaults the maximum is three. Every wall-clock figure in this document was taken with
three harnesses in parallel and, for part of the session, another agent's simulator harness on
the same machine — so they are pessimistic, and the per-stage `oneOffMs*` splits are the honest
part.

**The scan itself is seconds, not minutes** — 1.5 s at 1080p30 and 5-6 s at 4K60 — which is the
budget the brief set. The whole pipeline is not: on a 4K60 clip that takes three detector passes
it is minutes here, and that cost is `detectOnce`'s, not the scan's. §7.0 splits it. On a phone
the decode is hardware and the Core ML is on the Neural Engine, so the shape should improve, but
that is an expectation and not a measurement, and nothing here has run on a phone.


---

### 3.3 The property being bought, on one clip

IMG_3629, hand-labelled impact **5 610 ms**, address ball at (487.3, 1310.4). The same binary,
the same clip, seven different hints spanning **5.5 s**:

| hint | trust the hint (`scanEnabled:false`) | **the scan** |
|---|---|---|
| 3 000 ms | 0 — `no persistent departure` | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |
| 4 000 ms | 0 — `no persistent departure` | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |
| 5 000 ms | 0 — 1 detection, suppressed | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |
| **5 610 ms (truth)** | **45 dets** | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |
| 6 500 ms | 0 — `address refused: weak contrast` | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |
| 7 500 ms | 0 — `no persistent departure` | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |
| 8 500 ms | 0 — `no first detection within 4 frames` | **45 dets, derived 5 600 ms, (487.5, 1310.8)** |

Every scan row is **byte-identical**, one detector pass each. The old column is the brief's §2
in one table: the answer was only ever right when the number handed in was right.

---

## 4. Bounded on a short clip — the SIGTRAP case

IMG_0594 is 4.47 s. The previous +-3 s widening died on it with SIGTRAP. Four hints, from before
the clip's usable start to past its end:

| hint | outcome |
|---|---|
| 200 ms | derived **2 433 ms**, no crash |
| 2 200 ms | derived **2 433 ms**, no crash |
| 4 400 ms | derived **2 433 ms**, no crash |
| 8 000 ms (past the end of a 4.47 s clip) | `window empty after clamping to the clip`, no crash |

Two things are worth reading off that table. It does not crash. And **the derived impact does not
move when the hint does** — 200 ms and 4 400 ms produce the same answer to the millisecond,
which is the whole property being bought.

(That clip still emits no track: the detector reports `no first detection within 4 frames of
launch f74` at the derived impact. The scan found the moment; the detector could not follow the
ball out of it. That is a pre-existing limitation, not a scan failure, and it is counted as a
failure below.)

---

## 5. A limitation that is NOT in these files

**The app trims the clip around the impact it guessed, and renders on that trim.**
`hooks/useEditorState.ts` detects on `original_file_uri` (or the trimmed file) but renders on
`row.file_uri`, passing `detectToRenderOffsetSec = auto_trim_start_ms / 1000`. The trim is built
by `detectAndTrimVideo` as `impact - preRollMs` .. `impact + postRollMs`, and the shipped
fullSwing window is **2 500 ms before / 1 500 ms after** the app's own impact.

So when the scan derives an impact 2.6 s earlier than the hint — which is exactly what it did on
IMG_3629 — the ball's launch is **outside the rendered clip**. `buildSpec` catches this
correctly and honestly (`render_spec:animStartSec ... out of range`, or `anim window too short`),
so nothing wrong is ever drawn. But nothing is drawn at all.

**The detector finding the ball and the app being able to draw it are now two different
questions**, and this change only settles the first. The follow-up is one line of intent in a
file this agent does not own: the batch should build its render window from
`detection.notes.impactDerivedMs` when the detector derived one, instead of from
`row.impact_time_ms`. Both numbers are on the row for exactly that reason.

Section 7 measures both. **Measured, it costs one clip in nine on the lab set (9 drawn on the
whole clip, 8 inside the app's trim) and one in fifteen on Henry's (15 -> 14)** — smaller than I
expected before measuring it, because most derived impacts land within the 2.5 s lead-in. It is
worth fixing, and it is not the main thing holding the drawn count down: that is the fit
(`not_a_flight`, `track_not_ballistic`) working from a 12 deg assumed camera pitch on clips that
carry no CoreMotion data.


---

## 6. It refuses. Three adversarial checks

**A window that does not contain the shot.** IMG_3629 (real impact 5.61 s) given a hint of
11 500 ms, so the clamped window is roughly 8.0-12.9 s and the shot is outside it:

```
nDet=0  cands=24  deps=0  derived=None
"24 static patch(es) found, none of them departed and stayed gone"
```

Twenty-four ball-like patches were found, and **none of them was allowed to become an impact**.
That is the failure mode that matters, and it fails closed.

**A hint past the end of the clip.** IMG_0594 at 8 000 ms on a 4.47 s clip:
`window empty after clamping to the clip`, no crash, nothing emitted.

**A hint that lands the window on the right shot from the wrong side.** IMG_3652 given 8 000 ms
against a real impact of 4 733 ms: derived 4 733 ms, 45 detections, the correct address ball.
The window clamped to include the shot and the scan found it.

Nothing in the detector's own refusals was touched — `addrWeakC`, `minTrackEmit`, `confFloor`,
`acceptFirst`, `departFrac`, the weak-contrast-outside-the-ROI refusal and the
no-persistent-departure refusal are all at their previous values, and there is a test that fails
if any of them move.


---

## 7. Corpus results

Read these with §5 in mind: **"emitted a track" and "would draw an arc" are different
questions.** The scan settles the first. The second also depends on the fit (an imported clip
has no camera pitch, so `traceClip`'s fit is working from a 12 deg assumption) and on whether
the app's trim window contains the moment the scan found. ("Ladder" below always means
`impactSearchOffsets`, the 17-offset brute force — not `traceClip`'s decision ladder.)

### 7.0 The corpora, with the FALLBACK app hint

> **Read the emitted counts here as the SCAN ALONE.** Both of these runs were taken with
> `scanFallbackLadder` off, before §7.3's measurement showed the ladder still earns its place.
> On the lab set the shipped default (scan, then ladder) reaches **20/36** where the scan alone
> reaches 17/36. **I did not re-run Henry's 64 with the shipped default**, so 28/64 is a floor
> there, not the shipped number. §9.

Both runs use the same binary and the same app-derived hints (`detectAndTrim`'s path, §0.2).
Section 7.2 repeats the lab set on the PRIMARY (swing-vision) hint; §7.3 is the before/after against the shipped ladder.

| | lab `inputs/` (36) | Henry's Downloads (64) |
|---|---|---|
| **emitted a track** | **17 / 36** (47.2 %) | **28 / 64** (43.8 %) |
| arc drawn by `traceClip`, whole clip as render surface | 9 / 36 | 15 / 64 |
| arc drawn, inside the app's own trim window | 8 / 36 | 14 / 64 |
| detector passes used | 1 on 23, 2 on 6, 3 on 2, 4 on 5 | 1 on 33, 2 on 9, 3 on 3, 4 on 19 |
| clips where the scan found no departure at all | 9 / 36 | 5 / 64 |

**Impact accuracy, against an independent acoustic reference** (the strongest audio transients,
computed with ffmpeg — not the app's audio detector, not the labels):

| | lab, emitted rows | Henry, emitted rows | lab, every derived row | Henry, every derived row |
|---|---|---|---|---|
| **derived** median error | **0.01 s** | **0.04 s** | **0.02 s** | 0.28 s |
| **app hint** median error, same rows | 0.32 s | 0.34 s | 0.49 s | 0.37 s |
| derived within 0.2 s | 14/17 | 19/28 | 18/27 | 29/59 |
| app hint within 0.2 s | 5/17 | 7/28 | 6/27 | 11/59 |

The last column is the honest one to look at hardest: across **all 59** of Henry's clips where
the scan derived an impact — including the ones the detector then could not follow — the median
error is 0.28 s against 0.37 s for the hint. The scan is not magic on a clip whose ball it
cannot find; it is decisive on the clips where it can.

Cost, split by what the clip actually is (3 clips in parallel, so per-clip serial time is lower):

| | scan, median | whole clip, median | whole clip, max |
|---|---|---|---|
| 1080p30 (lab n=32) | 1 460 ms | 7 742 ms | 53 102 ms |
| 1080p30 (Henry n=44) | 1 386 ms | 12 042 ms | 63 983 ms |
| **4K60 (lab n=4)** | 5 030 ms | 50 568 ms | 142 374 ms |
| **4K60 (Henry n=20)** | 5 806 ms | 43 224 ms | 249 996 ms |

**4K60 is the cost problem, and it is not the scan's** — the scan is 5-6 s of it. The rest is
`detectOnce`, which decodes a 90-frame analysis window and a 60-frame background stack at
8.3 megapixels a frame. 20 of Henry's 64 clips are 4K60. This change cut the number of those
passes from up to 17 to 1-3; making one of them cheaper is a separate piece of work in code this
agent does not own.

### 7.1 Determinism

The 36 lab clips were run twice, on two separate builds. Across `nDetections`, the derived
impact, the impact source, the departure count, the candidate count and the launch frame, the
two runs differ in exactly **nine fields, all of them the same one**: on the nine clips where the
scan derived nothing, the earlier build echoed the hint back as `impactDerivedMs` and the later
one omits the key. That was the fix, and the detection behaviour is otherwise identical
row for row.

### 7.2 The same lab set, on the PRIMARY (swing-vision) hint

The runs above use the fallback estimator's hints, which are the worse ones. Repeating the lab
set on swing-vision's — the impact an import actually arrives with:

| | PRIMARY (swing-vision) hint | fallback hint |
|---|---|---|
| emitted a track | **17 / 36** | **17 / 36** |
| detector passes | 58 | 61 |
| median wall | 7.5 s | 9.3 s |
| derived impact vs audio strike, median | 0.05 s | 0.01 s |
| the HINT vs audio strike, median | 0.14 s | 0.32 s |

**On the 14 clips both runs emitted, the derived impact agrees to within 100 ms on 14 of 14** —
two materially different hints, the same answer. That is the property, measured rather than
argued.

It is not perfect hint-independence, and the honest line is the next one: the emitted SETS are
not identical. Three clips emit on one hint and not the other, each way (IMG_3622, IMG_3645,
IMG_3650 vs IMG_3626, IMG_3627, IMG_3653). At the margin, where the window edge or the ranking
is close, the hint still decides.

### 7.3 BEFORE and AFTER on the lab set — and the thing I got wrong

Same binary, same 36 clips, same app-derived hints. **BEFORE** =
`{"scanEnabled":false,"scanFallbackLadder":true}`, exactly what shipped before this change.
**scan only** = `{"scanFallbackLadder":false}`. **SHIPPED** = the new defaults: the scan first,
the ladder behind it.

| | BEFORE (ladder only) | scan only | **SHIPPED (scan, then ladder)** |
|---|---|---|---|
| emitted a track | 19 / 36 | 17 / 36 | **20 / 36** |
| arc drawn, whole clip | 9 / 36 | 9 / 36 | **9 / 36** |
| arc drawn, inside the app's trim | 7 / 36 | 8 / 36 | **8 / 36** |
| total detector passes | 404 | **61** | **319** |
| total wall clock | 2 417 s | **671 s** | **1 690 s** |
| median wall | 61.4 s | **9.3 s** | 38.5 s |
| max wall | 282 s | **142 s** | 265 s |

Against the shipped BEFORE, the shipped AFTER **loses nothing and gains IMG_3640**, at 21 %
fewer detector passes and 30 % less wall clock. Of the 20 it emits, **17 come from the scan in
1-3 passes** and 3 from the ladder behind it.

**I expected the scan to strictly dominate the ladder and it does not** — that is why the middle
column exists and why the ladder is still on. The scan alone gains IMG_3640 and loses IMG_3622,
IMG_3623 and IMG_3645. I had already written "the ladder rescued nothing the scan missed" into
the code, the tests and this document before this run finished; it was wrong, and it is
corrected everywhere rather than softened.

Looking at the three it loses, with the scan's own verbose output:

* **IMG_3622** — the scan found six departures and the best scored one at f246. The ladder
  landed the clip at f276 (9 201 ms, which is 0.02 s from an audio strike). f276 is not in the
  scan's list at all: the ball's own departure was never detected.
* **IMG_3623** — `scanDepartures = 0`. The ladder found it at 8 501 ms, 0.01 s from a strike.
* **IMG_3645** — three departures found, all three tried, none worked; the ladder found it at
  7 017 ms, 0.09 s from a strike.

So this is a **sensitivity gap in `tracerScanDeparture`**, not a window problem and not a
ranking problem on two of the three — the departure simply was not seen. `scanMaxTries` cannot
fix that.

**The decision, which the brief asked to be made on the measurement:** the ladder stays, as a
FALLBACK, defaulted on. That is the right-hand column — strictly better than what ships today on
every count. The honest cost of keeping it is in the middle column: a clip the scan cannot
settle now pays the scan's up-to-three passes *and* the ladder's, which is why the shipped
median (38.5 s) sits above the scan-only median (9.3 s). The ladder skips any impact the scan
already handed to the detector, so the duplicates are gone, but the wasted tries on a clip that
ends up needing the ladder are real.

### 7.4 What still fails, and whether the impact was the reason

The honest test of an impact fix is not the hit rate — it is whether the clips that still fail
fail *for a reason the impact could ever have fixed*. So every failing lab clip was re-run with
the scan OFF at each independently-derived audio strike, i.e. handed a good impact directly.

**Of the 19 clips the scan alone emitted nothing on, the detector can do 4 of them from a good
impact. The other 15 it cannot do at all.** (Three of the four are exactly the ones the ladder
fallback now rescues, so the shipped configuration reaches 20/36 against a ceiling of 21.)

| clip | scan departures found | passes tried | best detections from any audio strike | |
|---|---|---|---|---|
| IMG_3622 | 6 | 3 | 9 | **sensitivity** — six departures found, none of them at f276 where the ladder lands it (§7.3) |
| IMG_3623 | 0 | 1 | 8 | **sensitivity** — the ball departed and the scan saw no departure at all |
| IMG_3636 | 1 | 1 | 20 | **sensitivity** — one departure found and it was not the ball |
| IMG_3645 | 3 | 3 | 35 | **ranking or sensitivity** — all three tried and none worked; I did not separate "the right departure was not found" from "it was found and the detector failed at it" |
| the other 15 | 0-4 | 1-4 | **0** | the detector emits nothing on these even when handed a good impact |

So the ceiling on this corpus for an impact fix alone is **21/36**. The scan alone reaches
17/36; three of the four it misses are the same three the brute-force ladder rescues (§7.3),
which is why the ladder is kept as a fallback rather than deleted.

The four are the scan's own **departure sensitivity**, not the window: on all four the window
contained the strike and the scan produced ball-like candidates. `scanMaxTries` is the crude
version of the fix and a bad trade at 4K60, where one extra pass is tens of seconds — and on
IMG_3622 and IMG_3623 it would not have helped at all, because the departure was never in the
list to rank.


---

## 8. The API — what changed for a caller

`TracerDetect.detect(assetURL:impactTimeMs:optionsJson:)` is unchanged in signature and in the
shape it returns (SHARED CONVENTION 2). `impactTimeMs` is now a **hint**, not an instruction.

### 8.1 New keys on `notes` (every row, success or failure)

| key | meaning |
|---|---|
| `impactGivenMs` | the impact the caller passed in |
| `impactDerivedMs` | what the scan derived. **Absent** when it derived nothing |
| `impactShiftMs` | `derived - given`. Absent when there is no derived impact |
| `impactSource` | `scan` \| `given` \| `offset-ladder` \| `none` |
| `impactTriesUsed` | full detector passes actually run (was up to 19) |
| `scanCandidates` | static ball-like patches the address finder produced |
| `scanDepartures` | how many of them left and stayed gone |
| `scanFrames` | frames followed |
| `oneOffMsImpactScan` | scan cost, ms |
| `impactScan` | why the scan produced nothing, when it did not |
| `scanHits`, `scanCandidateList` | verbose only, one compact string each |

All values are `string | number | boolean`, matching `lib/tracerV3.ts`'s `notes` type — a key is
**omitted** rather than set to null. (One pre-existing exception, `addressContrast`, predates
this and is named in the test rather than hidden.)

`lib/tracerV3.ts` copies `notes` into `meta.detectorNotes` untouched, and the editor batch
persists that as `tracer_meta`, so **all of this reaches a field row with no JS change at all**.

### 8.2 New options (all optional, all in the same options JSON the bridge already sends)

| option | default | what it does |
|---|---|---|
| `scanEnabled` | `true` | master switch |
| `scanRadiusMs` | `3500` | half-width of the window searched around the hint |
| `scanPersist` | `6` | 30 fps-equivalent frames a departure must hold |
| `scanMaxTries` | `3` | full detector passes tried, best-scoring first |
| `scanMaxCandidates` | `24` | patches carried into the follow pass |
| `scanReturnFrac` | `0.12` | how much of the tail may come back before it is not a departure |
| `scanPreNoiseFrac` | `0.2` | how much of the pre-window may already be disturbed |
| `scanHintSigmaFrames` | `60` | softness of the "prefer the shot the app meant" tie-break |
| `scanTryGivenLast` | `false` | an EXTRA pass at the given impact after the scan's candidates fail. Measured: rescued **0** clips in 100, off |
| `scanFallbackLadder` | **`true`** | the old 17-offset brute force, reached ONLY after the scan. It emits 3 lab clips the scan alone misses, so it stays. See §7.3 |

**Reverting needs no rebuild:** `{"scanEnabled": false}` is exactly what shipped before this
change (the ladder default is already what it was).


---

## 9. What I did not do, and what is not verified

* **Nothing here has run on a phone.** Not one frame. Every number is a macOS harness around the
  shipped Swift, on a machine that was also running another agent's simulator harness and my own
  parallel batches for most of the session. The wall-clock figures are therefore pessimistic and
  the per-stage split (`oneOffMs*`) is the honest part.
* **The app hints are re-implementations, not recordings.** §0.3 says exactly what that means and
  what could differ.
* **I did not re-run the `jobs/*/inputs` corpus** (50 clips, "nobody tuned on"). It was queued and
  dropped in favour of measuring the primary swing-vision hint, which was the more load-bearing
  gap. So the scan has been measured on 100 clips, not 150.
* **The scan misses departures the brute force finds, and I did not fix that.** §7.3. On
  IMG_3622 and IMG_3623 the ball's own departure was never detected by `tracerScanDeparture` —
  not out-ranked, not outside the window, not seen. That is the single most valuable thing left
  to work on in these two files, and I ran out of session before I could do it properly. The
  ladder is kept on as a fallback precisely because of it.
* **I did not re-run Henry's 64 clips with the shipped default** (scan + ladder fallback). The
  28/64 in §7.0 is the scan ALONE. On the lab set the fallback moved 17/36 to 20/36, so 28/64 is
  a floor and not the shipped number. The run would take about half an hour on this machine and
  the session ran out first.
* **I did not measure the ladder on the PRIMARY hint.** The before/after in §7.3 uses the
  fallback estimator's hints on both sides, which is a fair comparison but not the field
  condition. That run was queued and killed to free the machine for the more decisive
  scan-versus-ladder measurement.
* **I did not change `detectOnce`.** Every threshold, refusal and emission rule inside it is
  where it was. That is deliberate — the regression set had to stay put — but it also means the
  15 lab clips the detector simply cannot do are untouched by this work.
* **The 4K60 cost is real and I did not fix it.** 20 of Henry's 64 clips are 3840x2160 at 60 fps
  and the whole pipeline is minutes-per-clip on them here. The scan is 5-6 s of that. Cutting
  the rest means decoding `detectOnce`'s analysis window at reduced resolution, which is a change
  to code this agent does not own and would need its own regression pass.
* **`scanRadiusMs` at 3 500 ms is a judgement, not a measurement.** It is deliberately wider than
  the app's own 2 500 ms trim lead-in, so the window is never the binding constraint on
  something the app could render anyway. Two lab clips had their strike outside it. Widening it
  would raise the emitted count and would not, today, raise the drawn count — see §5.
* **The three large track errors on the labelled set (IMG_3640 104 px, IMG_3631 33 px,
  IMG_3650 24 px) are byte-identical before and after.** I did not investigate them; they are
  not this change's business, and saying they are fixed would be false.

---

## 10. Recommendation, in order

1. **Take this change.** Against what ships today, on the same 36 clips and the same hints, it
   loses nothing and gains one (20/36 vs 19/36 emitted, 8/36 vs 7/36 arcs drawn inside the app's
   trim) for 319 detector passes instead of 404 and 1 690 s instead of 2 417 s. On the
   hand-labelled regression set it reproduces the hand-labelled-impact result exactly, from
   hints up to 2.6 s wrong.
2. **Then make the app trim around `impactDerivedMs`** (§5). Until that happens the detector can
   find a ball the app cannot draw, because the render surface is still built around the guess.
   One clip in nine on the lab set already lands there.
3. **Then close the departure-sensitivity gap** (§7.3, §7.4). On two of the three clips the
   ladder rescues, the scan never saw the ball leave at all — so the fix is in
   `tracerScanDeparture`, not in `scanMaxTries` and not in a wider window. Closing it is what
   would let the ladder finally be deleted, and until it is closed, deleting the ladder costs
   real clips.
4. **Do not delete the brute-force ladder.** I expected to and the measurement said no: it
   emits three lab clips the scan alone misses. It now runs only after the scan, so it is paid
   for by clips that were going to draw nothing — but it is not dead code and §7.3 is the reason.
