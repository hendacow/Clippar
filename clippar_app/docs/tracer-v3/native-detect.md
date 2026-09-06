# native-detect — Swift port of the tracer lab's wave-4 ball detector

**Agent:** `native-detect`, tracer-v3 build wave, 6 Sep 2026.
**Source of the algorithm:** `~/projects/clippar/tracer-lab/lib/detect.py` at wave-4 final
(= `experiments/detect2/detect_final.py`). Read `experiments/detect2/report.md`,
`experiments/judge/report.md` and `experiments/skeptic-vision/report.md` before changing any
number here.

## Files I own (nothing else touched)

| File | Lines | What |
|---|---|---|
| `modules/shot-detector/ios/TracerDetectCore.swift` | 2265 | the algorithm — pure Swift, `Foundation` + `Accelerate` only. No `ExpoModulesCore`, no Vision, no Core ML, no AVFoundation. |
| `modules/shot-detector/ios/TracerDetect.swift` | 1056 | the driver — AVAssetReader frame pump, Vision body pose, Core ML ball model, and the orchestration that mirrors `detect()`. |
| `modules/shot-detector/ios/GolfBallDetector.mlpackage` | 5.9 MB | the lab's `experiments/det-yolo-ball/golfballyolov8n_640.mlpackage`, copied byte for byte. |
| `modules/shot-detector/ios/ShotDetector.podspec` | +5 | `CoreML` on the frameworks line, plus one `s.resource_bundles` line. |
| `docs/tracer-v3/tracer-detect-core-check.swift` | 661 | standalone numeric check. Lives under `docs/` **on purpose**: the podspec globs `**/*.swift` under `modules/shot-detector/ios`, so a test file there would compile an `@main` into the app. |
| `docs/tracer-v3/tracer-detect-core-params.py` | 90 | mechanical diff of the ported constants against the lab's `P` dict. |

---

## The API another agent calls

`TracerDetect` declares no Expo module and imports no `ExpoModulesCore` — the registering agent
adds the `AsyncFunction` in `ShotDetectorModule.definition()`:

```swift
AsyncFunction("detectBallTracerV3") { (videoUri: String, impactTimeMs: Double,
                                       optionsJson: String, promise: Promise) in
    DispatchQueue.global(qos: .userInitiated).async {
        autoreleasepool {
            let url = self.resolveFileURL(videoUri)          // existing internal helper
            promise.resolve(TracerDetect.detect(assetURL: url,
                                                impactTimeMs: impactTimeMs,
                                                optionsJson: optionsJson))
        }
    }
}
```

Signatures:

```swift
public struct TracerDetectOptions {
    public var params = TracerParams()   // the whole lab P dict, defaults = the lab's values
    public var useCoreML = true
    public var verbose = false
    public init()
    public init(json: String)
}

public struct TracerDetectPayload {           // named this, not `TracerDetection`, because Core
    public var address: (x: Double, y: Double, r: Double)   // already uses that for ONE detection
    public var launchFrame: Int
    public var impactFrameUsed: Int
    public var detections: [TracerDetection]
    public var confMean: Double
}
public enum TracerDetectResult { case ok(TracerDetectPayload); case none(reason: String) }
// TracerDetectResult is ON the decision path inside detect(), not beside it: the dictionary is
// built by switching on it, so a Swift caller and the JS caller cannot disagree about success.

public enum TracerDetect {
    public static func detect(assetURL: URL, impactTimeMs: Double, optionsJson: String) -> [String: Any]
    public static func detect(assetURL: URL, impactTimeMs: Double, options: TracerDetectOptions) -> [String: Any]
}
```

**It never throws and never rejects.** A missing file, a missing model, a golfer it cannot find,
a shot that never flew — all come back as `found: false` with a `notes.reason`. That is the
product rule from the lab: a failure must be a SKIP, and a rejected promise upstream is a skip
that looks like a bug.

**It is synchronous and blocking** — call it off the main thread (as above). One 1080p clip is
seconds of work; see Cost.

### Return value — SHARED CONVENTION 2, exactly

```ts
{
  found: boolean;
  method: 'blob-kalman' | 'none';
  fps: number; width: number; height: number;          // display-oriented pixels
  impactFrameGiven: number;
  impactFrameUsed: number | null;                       // = launchFrame - 1
  launchFrame: number | null;
  address: { x: number; y: number; r: number } | null;
  detections: Array<{ frame: number; t: number; x: number; y: number; r: number; conf: number }>;
  notes: Record<string, string | number | boolean>;
  msPerFrame: number;
}
```

Pixels, **top-left origin, display-oriented** (the driver rotates every frame by
`preferredTransform` before anything else touches it). No normalized coordinates are produced
anywhere in these two files — that conversion belongs in `lib/tracerV3.ts` per SHARED
CONVENTION 1.

`t` is `frame / fps` in seconds. `null` is emitted as `NSNull()` (the `resolveBallLaunch`
convention next door); note that `x as Any? ?? NSNull()` does **not** work in Swift — an
`Optional` bridged through `Any?` stays wrapped and the coalesce never fires. Unwrapped explicitly.

### `notes` keys

Always: `coords`, `conf`, `reason` (only when nothing was emitted).
On a run that got as far as reading frames: `backgroundFrames`, `oneOffMsBackground`,
`oneOffMsPoseAddress`, `oneOffMsAddress`, `pose` (`"none…"` or `"L=… side=±1"`), `poseLegLength`,
`poseSide`, `coreml` (`"ok"` / `"unavailable: …"` / `"disabled by options"`), `coremlDetections`.
Once an address was chosen: `addressSource` (`yolo` | `blob` | `pose_roi`), `addressContrast`,
`addressPath`, `addressInRoi`, `addressChosenBy`, `weakAddressContrast`, `impactCorrected`,
`impactCorrectedDetail`. After tracking: `trackDetections`, `trackConfMean`, `reseeds`,
`seedSwitches`, `poseVetoesSeed`, `poseVetoesTrack`, `framesAnalysed`, `rhoFinal`, and
`trackLog` when `verbose`.

**`impactCorrected` is the one a caller must not ignore.** The departure cue, not the audio
transient, defines the launch frame, and `impactFrameUsed` can differ from `impactFrameGiven` by
several frames. Downstream timing must use `impactFrameUsed`.

### `optionsJson` keys (all optional)

`preFrames`, `postFrames`, `bgStartFrames`, `bgEndFrames`, `maxFrames` (0 = no ceiling) ·
`peakThr`, `acceptScore`, `acceptFirst`, `confFloor`, `minTrackEmit`, `addrWeakC` ·
`pose`, `localBg`, `useCoreML`, `verbose`. Anything absent keeps the lab's value.

---

## Ported vs changed

### Ported verbatim (structure and numbers)

Per-pixel median background from 9 frames before impact · signed differences to the background
and to the previous frame · the coarse local-median offset · multi-scale DoG blob candidates in
BOTH polarities with radius / contrast / isolation / anisotropy / motion features · the
`|d|` centroid refinement · the pose-seeded colour-agnostic address finder with the Lab-chroma
channel and the per-frame presence test · the Core ML ball model and bright-blob finders with
the ROI re-weighting · the departure test (step + persistence + plateau) that defines the launch
frame · the sector launch search with the crowd penalty (off) · the straight-line cone for the
second detection · the decaying-velocity Kalman with adaptive rho and radius prediction · seed
switching and the one second-chance re-seed · the pose SKELETON veto (capsules, discs, torso —
**not** a convex hull) · the weak-address refusal · the emission rule (**>= 3 detections AND mean
confidence >= 0.4, else emit nothing**) · the ordinal confidence heuristic with its 0.7 cap.

### Changed, and why

| # | Change | Why | Risk |
|---|---|---|---|
| 1 | **Core ML input is fixed 640x640; the lab ran ultralytics at `imgsz=1920`.** Mitigated by running the model on a whole-frame letterbox **plus** native-resolution 640x640 tiles centred on the pose ROI, and merging with NMS. | The exported `.mlpackage` has a fixed input. A whole-frame letterbox of 1080x1920 shrinks the address ball from ~30 px to ~10 px. The tiles restore the lab's effective resolution. | Medium — untested on device. Tiles add ~2 ms each. |
| 2 | **NMS is mine** (greedy, IoU 0.7, conf 0.15, max 300). | The export is `nms=False`, so the raw `[1,5,8400]` head comes back. 0.7/0.15 are ultralytics' defaults and the lab's `conf=0.15`. | Low. Output decode verified against the real `.mlpackage` (best anchor 302.75, 436.5, 7.5, 7.5 at score 0.745 on IMG_3629 impact-0.8 s, which maps back onto the labelled address ball). |
| 3 | **Vision `VNDetectHumanBodyPoseRequest` replaces yolov8n-pose.** Joint order is already COCO-17, so indices are unchanged. "Largest person" is now the largest **confident-keypoint** box, because a `VNHumanBodyPoseObservation` carries no bounding box. | The app already runs Vision pose (`tracerAnkleSamples`); shipping a second pose network is not worth 6 MB. | Medium. The box is used for one thing — the `L = 0.45 * boxHeight` fallback when the hips are bent or missing — and a keypoint hull runs a little short, so that fallback under-estimates leg length. `pose_imgsz` has no equivalent and is dropped. |
| 4 | **The veto mask is analytic, not rasterised.** Capsule / disc / polygon distance tests with the dilation margin folded into the radii, instead of drawing into a bitmap and dilating with an elliptical structuring element. | Mathematically the same set (dilating a union of discs and capsules by a disc = the same union with radii + margin), and cheaper for the few hundred points actually queried. OpenCV's thick lines have flat ends where a capsule has round caps — the difference is a half-disc at each joint, and adjacent limbs share joints. | Low. The property that matters is tested: the gap between raised arms and torso stays OPEN (§7 of the check). |
| 5 | **Gaussian blur border is REFLECT_101 via my own separable vDSP loop.** | Matches `cv2.GaussianBlur`'s default exactly, including OpenCV's implicit kernel size `round(8*sigma+1)|1` for a float image. `vImageConvolve` offers no reflect-101. | Low. Impulse response and mass conservation are tested. |
| 6 | **The wave-1 convex-hull / silhouette golfer veto is NOT ported** (`golfer_veto` and its six constants). | The lab ships it OFF, having measured it removing one correct frame and zero wrong ones. The pose skeleton veto replaced it. Porting 120 lines nothing calls is dead code. | None. Listed in the constants table as NOT PORTED. |
| 7 | **`accept_score_nodepart` is not ported.** | Unused since detect2 step 1 removed the no-departure fallback — which is the path that fabricated the IMG_3632 −3-frame track. | None. |
| 8 | **`CALIB` (the logistic confidence hook) is not ported.** | It is `None` in the lab and there has never been a negative class to fit it against. An empty hook invites someone to fill it with a guess. | None. The heuristic is ported exactly and documented as ordinal, not a probability. |
| 9 | **HSV: only S and V are computed**, and S uses round-half-up rather than OpenCV's fixed point. | Hue is never read. S enters through `soft(110 - S, 0, 60)` and one `S > 70` gate; a ±1 difference cannot move either. | Negligible. |
| 10 | **Four AVAssetReader passes** instead of Python's nested `read_frames` re-reads (background+address, departure scan, launch validation, tracking). | Same windows, same order; iOS cannot nest readers on one instance and buffering the windows would cost 90 MB+. | Low. Costs a little extra hardware decode. |
| 11 | **`maxFrames`** added to `TracerParams` (default 0 = off). | Not in the lab, which reads a fixed window. A ceiling so a corrupt or very long asset cannot pin the CPU. | None when left at 0. |
| 12 | **The median filter's two-level histogram** and the removal of a kernel-size clamp I had written. | Exact same answer, ~8x faster on the address ROI. The clamp was mine and was WRONG — it shrank the kernel near a small ROI. Caught by the brute-force cross-check, not by reading. | None; verified against a brute-force median at k = 3, 7, 13, 21, 59. |

### Not attempted

* No 4K downscale before Vision pose. The lab downscales 4K to 1080p first (5x cheaper) and
  measures 73–75 ms per pose frame at 4K anyway. The app records 1080x1920, so this is the
  non-production case and I did not add untested code for it. A 4K clip works, just slower, and
  uses ~4x the memory (see Risks).
* No pyramid / downsampled sector search. It is the obvious optimisation and it would change the
  measured numbers, so it is not in a port.
* Nothing was re-tuned. No constant was chosen by me.

---

## Constants cross-checked against the lab's `P`, line by line

Generated mechanically, not transcribed: the check binary dumps every `TracerParams` field and
`tracer-detect-core-params.py` diffs it against `lib.detect.P`.

```
cd clippar_app && xcrun swiftc -O modules/shot-detector/ios/TracerDetectCore.swift \
    docs/tracer-v3/tracer-detect-core-check.swift -o /tmp/tracer-core-check && \
  /tmp/tracer-core-check > /tmp/tracer-params.txt
cd ~/projects/clippar/tracer-lab && ./.venv/bin/python \
  ~/projects/clippar/final_shipment/clippar_app/docs/tracer-v3/tracer-detect-core-params.py \
  /tmp/tracer-params.txt
```

**Result: 66/66 lab constants match, 0 problems.**

| lab `P` | lab value | Swift `TracerParams` | verdict |
|---|---|---|---|
| `pre_frames` | `3` | `3` | ok |
| `post_frames` | `45` | `45` | ok |
| `bg_start` | `30` | `30` | ok |
| `bg_end` | `6` | `6` | ok |
| `bg_step` | `3` | `3` | ok |
| `addr_frames` | `24,15,6` | `24,15,6` | ok |
| `sigmas` | `1.0,1.35,1.8,2.4,3.2,4.3,5.7,7.6` | `1.0,1.35,1.8,2.4,3.2,4.3,5.7,7.6` | ok |
| `dog_k` | `1.6` | `1.6` | ok |
| `peak_thr` | `4.0` | `4.0` | ok |
| `sector_dist` | `25,520` | `25.0,520.0` | ok |
| `sector_half_angle_deg` | `65` | `65.0` | ok |
| `step2_along` | `0.4,5.0` | `0.4,5.0` | ok |
| `accept_score` | `0.22` | `0.22` | ok |
| `accept_first` | `0.35` | `0.35` | ok |
| `accept_score_nodepart` | `0.5` | `NOT PORTED` | unused since detect2 step 1 removed the no-departure fallback |
| `max_miss_early` | `3` | `3` | ok |
| `max_miss_late` | `5` | `5` | ok |
| `min_radius` | `0.7` | `0.7` | ok |
| `depart_frac` | `0.45` | `0.45` | ok |
| `golfer_min_height` | `250` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `golfer_margin` | `15` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `golfer_head_frac` | `0.3` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `golfer_carry` | `8` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `golfer_scale` | `0.5` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `golfer_veto` | `false` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `golfer_mode` | `mask` | `NOT PORTED` | wave-1 hull veto, shipped OFF in the lab |
| `min_track_emit` | `3` | `3` | ok |
| `refine_frac` | `0.3` | `0.3` | ok |
| `refine` | `true` | `true` | ok |
| `young_vel_noise` | `0.35` | `0.35` | ok |
| `vel_noise` | `0.18` | `0.18` | ok |
| `motion_young_n` | `6` | `6` | ok |
| `motion_min_step_r` | `3.0` | `3.0` | ok |
| `depart_scan` | `-4,6` | `-4,6` | ok |
| `depart_persist` | `2` | `2` | ok |
| `impact_flag_frames` | `2` | `2` | ok |
| `conf_floor` | `0.4` | `0.4` | ok |
| `reseed_max` | `1` | `1` | ok |
| `reseed_window` | `6` | `6` | ok |
| `seed_r_max` | `1.3` | `1.3` | ok |
| `pose` | `true` | `true` | ok |
| `pose_imgsz` | `640` | `NOT PORTED` | a yolov8n-pose input size; Vision has no equivalent knob |
| `pose_conf` | `0.25` | `0.25` | ok |
| `kp_conf` | `0.3` | `0.3` | ok |
| `pose_frames` | `8` | `8` | ok |
| `pose_carry` | `8` | `8` | ok |
| `limb_frac` | `0.1` | `0.1` | ok |
| `head_frac` | `0.22` | `0.22` | ok |
| `hand_frac` | `0.13` | `0.13` | ok |
| `veto_margin` | `8` | `8.0` | ok |
| `veto_hard_n` | `3` | `3` | ok |
| `roi_dx` | `0.2,1.6` | `0.2,1.6` | ok |
| `roi_dy` | `0.45` | `0.45` | ok |
| `r_exp_frac` | `0.024` | `0.024` | ok |
| `roi_presence_frac` | `0.3` | `0.3` | ok |
| `roi_inside_factor` | `1.2` | `1.2` | ok |
| `roi_outside_factor` | `0.6` | `0.6` | ok |
| `local_bg` | `true` | `true` | ok |
| `local_bg_scale` | `4` | `4` | ok |
| `local_bg_k` | `13` | `13` | ok |
| `seed_polarities` | `1,-1` | `1,-1` | ok |
| `depart_drift_max` | `1.5` | `1.5` | ok |
| `crowd_radius` | `40` | `40.0` | ok |
| `crowd_k` | `0.0` | `0.0` | ok |
| `crowd_rel` | `0.5` | `0.5` | ok |
| `addr_weak_c` | `8.0` | `8.0` | ok |

66/66 lab constants match; 0 problems.

---

## Verification — what actually ran

There is **no `pod install` in this checkout**, so nothing here has been compiled as part of the
app, and per the house rule I did not judge any video behaviour on the simulator. What ran:

| # | Check | Command | Result |
|---|---|---|---|
| a | `TracerDetectCore.swift` **typechecks** against the iOS SDK | `xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios15.0 modules/shot-detector/ios/TracerDetectCore.swift` | **PASS**, no warnings. It imports only `Foundation` and `Accelerate` — no `ExpoModulesCore`, which is what makes (c) possible. |
| b | `TracerDetect.swift` **parses** | same, `-parse`, driver only | **PASS** |
| b2 | Both files **typecheck together** (stronger than asked; the driver references Core's types) | same, `-typecheck`, both files | **PASS**, no warnings |
| c | Numeric check, compiled and **run** | `xcrun swiftc -O …TracerDetectCore.swift …tracer-detect-core-check.swift -o /tmp/tracer-core-check && /tmp/tracer-core-check` | **63/63 checks passed** |
| d | Constants diff against `lib.detect.P` | `tracer-detect-core-params.py` | **66/66 match, 0 problems** |
| e | Podspec is valid Ruby | `ruby -c modules/shot-detector/ios/ShotDetector.podspec` | **Syntax OK** |
| f | Core ML output decode | ran the real `.mlpackage` under coremltools on a real IMG_3629 frame | best anchor `(302.75, 436.5, 7.5, 7.5)` score `0.745`; letterbox-inverted to `(488, 1310)` against the labelled address `(475, 1300)` r 15 — the decode and the units are right |

### What the 63 checks cover

1. **Image primitives** — OpenCV's implicit Gaussian kernel size (`round(8σ+1)|1`: 9 at σ=1.0,
   21 at σ=2.4), normalisation, symmetry; blur of an impulse reproduces `k[c]²` at the centre and
   conserves mass; the rectangular max filter; the median filter **against a brute-force median at
   k = 3, 7, 13, 21, 59** (this found a real bug — a kernel clamp of mine that silently shrank the
   window near a small ROI); INTER_AREA block averaging.
2. **Blob scorer** — radius grows with blob width and the radius-per-sigma ratio is scale
   invariant (1.52 vs 1.55, which is what every size gate depends on); a round blob measures
   anisotropy ~1.00 and a 2x7 blob 3.09; the centroid offset recovers a deliberate 2-px
   displacement; the `|d|` refinement pulls a lit-side centre 1.14 px back toward a half-lit ball.
3. **Blob candidates** — ranking, SNR against a noise floor, isolation, the `allowed` mask
   actually excluding, and the negative polarity finding a DARK blob (the ball-on-cloud case).
4. **The Kalman gate** — fed the collapse ratios the lab measured on IMG_3622 (231 → 99 → 57 → 36
   px), rho converges to 0.647, the prediction lands 2 px from the continuing track, the true next
   position passes the m² ≤ 12 gate at 0.08 and a point 200 px away fails it at 917.
5. **The departure detector — all four rejection shapes**: a clean step is a departure; a gradual
   shadow ramp is not; a patch already changed at the start of the window is not; a change with
   nothing left to confirm it is not; a step that keeps drifting afterwards is not (the plateau
   rule); a step **back toward** the background still is (the IMG_8116 case); a step below
   `departFrac * cRef` is not.
6. **Address validation scoring** — a departing candidate outscores a ramping one; a dark
   candidate from the generic bright-blob finder is scored at half weight while the same contrast
   from the model or the pose ROI is trusted.
7. **Pose geometry and the veto** — ankle midpoint, leg length, ball side from the head lean, the
   ROI rectangle to the pixel (x 130..480, y 987..1212 for L=250), and **the gap between the raised
   arms and the torso is NOT vetoed** while the arm, torso and head are. That is the property the
   convex hull broke; it is the difference between IMG_3652 scoring 45 detections and scoring 0.
8. **Sector search on a synthetic frame** — a ball 60 px above the address is seeded at f=0.44
   (threshold 0.35); the same blob below the address is not; a blob under the golfer's hand is
   vetoed.
9. **The cone stage** — a ball continuing straight up is accepted; one 120 px off the launch line
   is rejected.
10. **Confidence and emission** — 0.8·score for a seed, 0.6·score + 0.4·support after,
    the 0.7 cap for sub-1.5-px specks; a 2-detection track emits nothing; 3 detections at mean
    conf 0.21 emit nothing; 3 at 0.80 are emitted.

### Cost — measured on a Mac, NOT on a phone

`-O`, single thread, 1080x1920 synthetic frames, from section 11 of the check:

| Stage | ms (this Mac) |
|---|---|
| sector search, `steps=1` (address r0=15) | 81 |
| sector search, `steps=3` (ROI clipped to the whole frame) | 210 |
| one tracking frame (cone stage) | 17 |
| 9-frame background median | 26 |
| BGRA → luma plane | 2 |

The lab's own OpenCV detector measures **8.9–15.8 ms per analysed frame** at 1080p on this same
Mac and **1.5–3.8 s wall per clip**, with the address stage 190–2470 ms. My tracking frame at
17 ms and my launch-validation arithmetic (≈16 sector searches × 81–210 ms ≈ 1.3–3.4 s) land in
the same place, which is the main evidence that the vDSP port is not accidentally an order of
magnitude off.

**Per clip on device: I estimate 5–25 s**, from the Mac total (roughly 2.5–6 s) scaled by the
2–4x an A-series typically gives up to an M-series on this kind of work. **That is an estimate,
not a measurement — nothing here has run on a phone.** It is an offline, post-shot job on the
same footing as the app's existing on-device trimming (`processAllTracers` already batches), not
a capture-time path. If it turns out too slow, the first thing to try is a downsampled pyramid
for the sector search, which is deliberately not in a port.

---

## What I could NOT verify — read this before trusting anything above

* **Nothing has been compiled into the app and nothing has run on a device or on video.** There
  is no `pod install` here. `TracerDetect.swift` has been PARSED and TYPECHECKED against the iOS
  SDK; it has never executed. Every claim about frames, orientation, Vision, Core ML loading and
  AVAssetReader behaviour is design intent, not observation.
* **The rotation to display orientation is derived algebraically, not observed.**
  `CGRect(0,0,w,h).applying([0,1,-1,0])` sends `(x, y)` to `(-y, x)`, which after translation is
  `(H-1-y, x)` — a clockwise quarter turn; the 180 and 270 cases follow the same way. If this is
  wrong, every coordinate the detector emits is wrong, and it is the first thing to check on the
  first real clip. A one-frame screenshot with the address marked settles it.
* **The Core ML model has never been loaded on iOS.** The `.mlpackage` → `.mlmodelc` compile-and-
  cache path is copied from `SwingVisionModule.loadResources()`, which ships and works, but the
  bundle name is new (`ShotDetectorResources`) and has never been produced by CocoaPods here.
  If the resource is not found, `notes.coreml` says so and the address finder degrades to
  blob + pose ROI — which is a real degradation: on the lab's footage the model-sourced address
  is what most working clips use (`address_path=yolo+roi`).
* **The 640 vs 1920 model input is the biggest unquantified risk.** I mitigated it with native-
  resolution tiles, but I have not scored the tiled arrangement against the lab's `imgsz=1920`
  on a single clip, because scoring needs the lab's runner and the lab is Python.
* **Vision pose has not been compared with yolov8n-pose on the same frames.** Keypoint
  conventions match (COCO-17), but confidence scales and the missing person box do not, and every
  veto-mask dimension is a fraction of the leg length that comes out of them.
* **Per-frame timings for Vision pose and Core ML on device are unmeasured.** The Core ML numbers
  in the lab (1.9 ms at 640 on a Mac's Neural Engine) are Mac numbers.
* **`nominalFrameRate` is an average.** The lab reads ffprobe's `r_frame_rate`. On a variable-
  frame-rate clip the frame indices would drift; the pump keys off PTS, so detections stay
  correctly stamped, but `fps`-derived window sizes would be slightly off.
* **Memory.** Peak working set at 1080p is roughly 50 MB (background + current luma + previous
  luma + S/V + the three address BGRA frames, which stay alive for the whole call). At 4K that is
  ~200 MB and could be a problem. Not measured.
* **`crowd_k` ships at 0**, as in the lab, which means the turf/debris/canopy penalty is present
  but inert. The lab measured `k=0.1` costing IMG_3640 its whole track.
* **The known-wrong output is still known-wrong.** On IMG_2329 — a topped shot that must stay
  silent — the lab's detector emits 3 wrong detections from a weak in-ROI grass "address" plus
  two seed switches. This port reproduces that behaviour faithfully. It is the one clearly wrong
  output of wave 4 and nothing here fixes it.
* **Recall is the product problem, not precision.** On unseen footage the lab gets a track on 5 of
  11 airborne shots; yellow balls defeat the address finder on 3 of them. Half the shots in a real
  round should be expected to produce nothing, and the caller must treat "nothing" as normal.

## Bundle-size note (not behaviour, but Henry should know)

`s.resource_bundles` puts the 5.9 MB `.mlpackage` in the binary **whether or not
`config.tracer.enabled` is true** — that is what bundling means. Runtime behaviour with the flag
off is untouched: the model is loaded lazily on the first `detect()` call, never in `OnCreate`,
so with the flag off no model is compiled, no Neural Engine is woken and app launch is unchanged.

## Integration notes for whoever wires this up

* **No symbol collisions.** Every top-level name I introduce (`PlaneF`, `PlaneU8`, `TracerBGRA`,
  `TracerParams`, `TracerDetection`, `TracerTrack`, `TracerPose`, `GolferGeometry`,
  `GolferSkeleton`, `AddressCandidate`, `AddressInfo`, `BlobCandidate`, `SectorHit`,
  `TracerHalfMax`, `TracerComponents`, `TracerYoloDetection`, `TracerFramePump`,
  `TracerVisionPose`, `TracerBallModel`, and the `tracer…` free functions) was scanned against
  `ShotDetectorModule.swift`, `ShotTracer.swift` and `TracerRenderV3.swift` — zero hits in all
  three.
* **Call it off the main thread**, inside an `autoreleasepool`, and expect seconds not
  milliseconds.
* **Use `impactFrameUsed`, not `impactFrameGiven`,** for anything downstream that needs the
  moment of impact.
* **Treat `found: false` as the normal case, not an error.** Roughly half of real shots will
  produce nothing, by design.
* Nothing in either file runs unless `detect()` is called, and the model is not loaded until
  then. `config.tracer.enabled === false` therefore costs nothing at runtime.
