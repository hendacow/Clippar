# native-render — `TracerRenderV3.swift`

**Agent:** `native-render` · **Owns exactly one file:**
`clippar_app/modules/shot-detector/ios/TracerRenderV3.swift` (1 866 lines, new).
**Did not touch** `ShotTracer.swift` (v1 render, must keep working untouched),
`ShotDetectorModule.swift`, the podspec, or any TypeScript. `git status` confirms the only
path this agent added under `modules/shot-detector/` is `TracerRenderV3.swift`.

> **Nothing in this file has ever been rendered.** There is no `pod install` in this
> checkout, so it has been `swiftc -parse`d and `swiftc -typecheck`ed and nothing more.
> Camera/video-pipeline behaviour is never judged from a simulator in this repo, and Core
> Animation through `AVVideoCompositionCoreAnimationTool` cannot be judged anywhere but on
> a device. Every visual statement below is a design intent traced to a lab measurement,
> **not a result**. §7 lists exactly what a device has to settle.

---

## 1. The API, exactly

```swift
enum TracerRenderV3 {
    /// - videoURL:  an ALREADY-RESOLVED file URL. This file has no Expo dependency, so the
    ///              caller does `resolveFileURL` (as renderTracerOnClipImpl does today).
    /// - specJson:  the V3 render spec (SHARED CONVENTION 3), normalized bottom-left.
    /// - outputURL: where to write. Any existing file there is replaced; the parent
    ///              directory is created if missing.
    static func render(videoURL: URL, specJson: String, outputURL: URL) throws -> [String: Any]
}
```

**Returns** `["tracerUri": String, "durationMs": Double, "stats": [String: Any]]`.
`durationMs` is the **composed** duration, so it already includes any freeze tail.

**Throws** `TracerRenderV3Error { let code: String; let message: String }` (a
`LocalizedError`). The registering agent maps it straight across:

```swift
} catch let e as TracerRenderV3Error {
    promise.reject(Exception(name: e.code, description: e.message))
}
```

Codes, all of them the same strings the shipped v1 renderer already emits, so JS error
handling does not have to fork:

| code | when |
|---|---|
| `ERR_TRACER_SPEC` | any spec invariant violated (see §3) |
| `ERR_FILE_NOT_FOUND` | `videoURL` does not exist |
| `ERR_NO_VIDEO_TRACK` | the clip has no video track |
| `ERR_COMPOSITION` | composition track could not be created / degenerate render size |
| `ERR_INSERT_VIDEO` | `insertTimeRange` failed |
| `ERR_TRACER_ANIM_WINDOW` | `animStartSec` within 0.4 s of the composed end |
| `ERR_EXPORT_GATE_TIMEOUT` | another V3 export wedged for >300 s |
| `ERR_EXPORT_SESSION` | `AVAssetExportSession` could not be created |
| `ERR_TRACER_RENDER_FAILED` | the export failed or was cancelled |

**Call it off the main thread.** `render` is synchronous and blocking — it waits on the
export with a semaphore, exactly as `renderTracerOnClipImpl` does inside its
`DispatchQueue.global(qos: .userInitiated).async`. (It is safe if you *do* call it on the
main thread — the `beginBackgroundTask` hop is guarded with `Thread.isMainThread` so it
cannot self-deadlock — but you will block the UI for the whole export.)

`stats` (for the device log and for the first field test):

```
engine, renderWidth, renderHeight, fps, sampleCount, keyframeCount, bands, depthsGiven,
taperMin, depthFadeMin, animStartSec, fittedDurationSec, drawDurationSec,
endAt{applied, sec}, freeze{applied, holdSec, capped},
occlusion{requested, applied, keyframes, sourceFrames, maskWidth, maskHeight, msTotal, reason?},
label{shown, atApex, showSec, clamped, xPx?, yPx?, overlapFrac?},
elapsedMs, maskOrientationAssumption
```

`label.overlapFrac` is deliberately the *same* number the lab reports (0.00 on all 19
renders, render3 §6), computed the same way, so a device log can be compared to it directly.

---

## 2. Where it sits

```
parentLayer (renderSize)
 ├─ videoLayer                    filled by AVVideoCompositionCoreAnimationTool
 ├─ traceContainer                mask = per-frame inverted person mask
 │    ├─ glow  band 0..N-1        far → near
 │    ├─ mid   band 0..N-1        far → near
 │    ├─ core  band 0..N-1        far → near  (+ layer shadow = the glow)
 │    └─ comet head               position / scale / opacity keyframes
 └─ pill                          OUTSIDE the container — never occluded
```

The mask sits on the container, so it multiplies into every trace layer — strokes, comet
and halo — and the pill, being outside, is never occluded. That is the lab's rule verbatim
(render2 §1, §5).

---

## 3. Spec validation — loud, not lenient

Ported from `TracerRenderSpecV2.parse` on `origin/tracer-v2` (invariant I11b). A `samples`
array that is present but wrong is a **hard reject**, never a silent downgrade and never a
`CAKeyframeAnimation` that no-ops:

- `>= 2` samples
- every `x`/`y`/`tSec` finite
- `tSec` **strictly** increasing (equal keyTimes glitch a keyframe animation)
- `tSec[0] == 0` (CA needs `keyTimes[0] == 0`)
- `tSec.last == animDurationSec` (CA needs `keyTimes.last == 1`)
- non-degenerate arc length (a zero-length path makes every arc-length fraction 0 and the
  `strokeEnd` draw-on silently no-ops)
- `depths`, if given, must be the same length as `samples` and every entry finite `> 1e-3`

Two spec fields are **clamped, not rejected**, and the clamp is reported in `stats`:
`endAtSec` past the fitted landing is clamped to it, and an over-long `labelText` /
`labelSubText` is truncated (24 / 40 chars). A cosmetic string is not worth failing a
render over; a malformed polyline is.

`endAtSec <= 0`, non-finite, or one that leaves fewer than 2 samples after truncation **is**
`ERR_TRACER_SPEC`.

The V3 spec puts styling at the **top level**, per SHARED CONVENTION 3. The v2 branch nested
it under `styling` — that shape is *not* accepted, because nothing emits it any more.

---

## 4. Every requirement, and the lab line it comes from

### 4.1 Polyline + comet head, tip on the ball

`strokeEnd` is a `CAKeyframeAnimation` whose `values` are **cumulative arc-length
fractions** and whose `keyTimes` are `tSec / duration`, `calculationMode = .linear`. This
is `buildTracerV2Overlay` ported unchanged, which is itself the render report's "Draw-on
timing" recipe: it paces the draw by real flight timing, so the tip sits on the ball's
projected position rather than on a uniform fraction of the path (the lab measured
tip-on-ball to ~1 px median; the property preserved here is the *pacing rule* that produces
it).

The comet is a `CAKeyframeAnimation(keyPath: "position")` with **explicit values** = the
sample points and the same keyTimes — never `.paced`, which moves at constant arc speed and
drifts off the ball (render report, "Comet"). The shipped v1 renderer uses `.paced`; that is
one of the things V3 fixes.

Geometry is never decimated: the `CGPath` uses every sample. Only the *pacing keyframes* are
thinned, and only above 600 of them (a 120 Hz 8 s flight is ~960 keys × 18 layers), and CA
interpolates linearly between the survivors exactly as it would have between the dropped
ones.

### 4.2 Person occlusion

`VNGeneratePersonSegmentationRequest`, `qualityLevel = .balanced`,
`outputPixelFormat = kCVPixelFormatType_OneComponent8` — on-device, free, Apple's, as
instructed. One request instance reused across frames.

**Frames are read through an `AVAssetReaderVideoCompositionOutput` carrying the same
`renderSize`, `frameDuration` and fill transform as the export**, so every mask is in
exactly the pixel space the trace is drawn in. Reading the raw track and orienting with
`CGImagePropertyOrientation` would be wrong the moment the source and render aspect ratios
differ, because `computeFillTransform` aspect-**fills** and therefore crops.

Mask → grow 2 px → feather 2.5 px → invert (person = alpha 0) → `CALayer.mask` on the trace
container, stepped with a **discrete** `CAKeyframeAnimation` on the mask layer's `contents`.
A per-frame mask cannot be expressed any other way in a static layer tree, which is what the
animation tool composites.

**The two wave-4 bugs are structurally impossible here, not tuned away.** render3 §7.1 found
that both failures were in the *gate*, not the mask: a person box refreshed every 10 frames
(so a golfer bending at 60 fps was masked from a stale box), and a hit test that compared
the trace bbox against the person box with a 24 px margin — on IMG_3622 the trace was
x 441–736 and the person x 787–1080, so **the occluder never ran** over the driver head and
shaft. Vision's segmentation is a whole-frame request with no box step, so this file simply
**segments every frame the trace can be on screen**. There is no cadence to go stale and no
hit test to be too narrow. The only gate is exact: frames before the draw starts have
nothing to occlude.

The window runs from `animStartSec - 0.1` to the **end of the source**, not to the end of
the draw: the arc persists after it is drawn and the golfer keeps walking through it
(render2 measured 1 496–2 371 trace pixels on the torso at k435+, well after the draw
finished). During a freeze tail the last mask is held, which is what render3 §4 does
("the occluder is pinned to the last real frame index").

The pill is added to `parentLayer`, not to the masked container. **The pill is never
occluded.**

If segmentation is unavailable or fails, the render continues **without** occlusion and says
so in `stats.occlusion.reason`. That is the lab's own rule for a missing segmenter: warn,
draw anyway, fail nothing.

Grow/feather arithmetic, stated because it is a compromise: the mask raster's long side is
capped at 640 (Vision's `.balanced` mask is itself only ~504 px on its long side, so this
costs no detail). At 1080p that is 360×640, where the lab's 2 px grow is 0.67 mask px and
its 2.5 px feather is 0.83 — both round **up** to 1, which over-grows slightly. The lab's own
comment says that is the safe direction ("hide a little too much rather than paint on the
golfer"). Core Animation's bilinear upscale back to 1080 adds ~3 px of its own ramp, so the
net edge softness is ~6 px at 1080 against the lab's ~5.

### 4.3 Depth cues

| lab symbol | value | here |
|---|---|---|
| `taper_gamma` | 0.7 | `V3Look.taperGamma` |
| `taper_min` | **0.25** (0.35 → 0.18 → 0.25 across waves) | spec default, `V3Look.taperMinDefault` |
| `depth_fade_min` | **0.75** (0.5 → 0.75 in wave 5) | spec default, `V3Look.depthFadeMinDefault` |
| `depth_fade_ratio` | 20.0 | `V3Look.depthFadeRatio` |
| `depth_order` | True | band z-order |

Width multiplier `clip((d0/d)^0.7, taper_min, 1)` with `d0` = the **launch** depth
(`track_from_flight`); alpha multiplier `1 - (1-fade_min)·clip(log(d/d0)/log(20), 0, 1)`
with `d0` = the **minimum** depth on the track (`_segment_alpha`). That asymmetry is the
lab's, and it is kept on purpose rather than "tidied".

A `CAShapeLayer` has exactly one `lineWidth`, so the taper has to be stepped: the polyline is
split into **6 arc-length bands**, each a full-path layer clipped by a static `strokeStart`
plus a `strokeEnd` keyframe clamped into its band (the v2 3-band trick, widened). Bands are
**inserted far → near by depth**, so where the descending leg crosses the ascending one the
near leg sits on top — render2 proved that ordering by pixel-identity against a
near-leg-only render. Depth order, not time order, so a shot coming back toward the camera
still works. Global stroke order stays glow → mid → core, matching the lab's compositing.

**Without `depths` there is no taper and no fade at all** (one flat band). That is the honest
fallback and the one `track_from_pixels` takes when it has no radii — not a guessed
arc-length taper.

### 4.4 Freeze-frame completion

`freezeCompleteToSec` is a **clip-timeline** second the output must reach. When it exceeds
the source duration, the last frame's one-frame range is re-inserted at the end and
`scaleTimeRange`d to the hold — a genuine freeze that stays inside the composition, so the
export path below is untouched. Capped at `freeze_max_s = 6.0` (the lab's own cap) so a bad
spec cannot turn a 10 s clip into a minute of frozen frame; `stats.freeze.capped` says when
that bit. The trace animation is unchanged and simply keeps drawing into the frozen region,
which is what makes every trace end on the ground. Audio runs out, as it does in the lab. A
freeze that cannot be built is logged and skipped — it is not a reason to lose the render.

### 4.5 End override

`endAtSec` truncates the polyline **in time only**: keep every sample at `tSec <= endAtSec`,
plus one linearly interpolated point at exactly `endAtSec`. The alternative — retargeting
the last 0.3 s onto a measured landing pixel — is implemented in the lab as
`Track.retargeted` and was **reverted**: a touchdown pixel 7 px off pulled the tip 6–9 px
above the real ball on the four frames before touchdown (render2 §6). So this file never
moves the trace in space, only shortens it in time.

### 4.6 Label pill

Headline 64 px bold + optional 34 px second line at the 1080 reference (≈23 pt / 12 pt when
the frame fills a phone) — the lab raised these from 44/26 precisely because the first
version was not legible at phone scale. Padding 26/14, gap 6, corner radius min(H/2, 22),
background alpha 0.6, second line at 92 % white: `_make_pill`, field for field.

Fades in over `label_fade_s = 0.3` **at the apex** (`t_show = min(t_apex, t_end)` when
`labelAtApex`), which is what lets a clip that ends mid-flight still carry its distance —
render3 §6 got a pill onto all 19 renders that way, including four that used to run out of
clip with no label at all. `labelAtApex: false` falls back to "at completion".

Placement is the lab's cost map (`_pill_position` + `_avoid_mask` + `_pill_anchor`), ported
into bottom-left space: a coarse grid carrying the whole arc dilated by 2 × the glow width,
the landing burst at 4 × the comet radius, and the person mask **sampled at both the apex
frame and the end frame** (the golfer moves in between — render3 §6), dilated by 24 px;
a summed-area table; cost `10·overlap + dist_to_anchor + 0.3·(prefer upper frame)`. The
anchor is the highest **in-frame** node (`Track.apex_pixel`), which matters on clips whose
apex is above the frame.

---

## 5. Landmine guards — line-by-line against the shipped `renderTracerOnClipImpl`

Method: a normalised diff (comments and whitespace stripped) of the export block of
`ShotTracer.swift` HEAD against the export block of `TracerRenderV3.renderImpl`. The only
differences the diff shows are `promise.reject/resolve` → `throw/return`, the freeze
insertion, the occluder pass, and the overlay call. **Every guard is present.**

| # | landmine (HEAD comment) | present? | `TracerRenderV3.swift` |
|---|---|---|---|
| 1 | Audio track ONLY if the source has one — an empty audio track + custom videoComposition fails export with **-11838** | yes, verbatim | L1592 |
| 2 | `AVAssetExportPreset1920x1080`, **not** HighestQuality — HighestQuality + custom composition on HEVC/HDR is **-11838** | yes, verbatim | L1738 |
| 3 | `frameDuration` from `srcVideoTrack.nominalFrameRate` (clamped ≤60) — a hardcoded 1/30 silently halves a 60 fps source | yes, verbatim | L1613 |
| 4 | **Never** a literal `beginTime` 0 — CA remaps it to "now" and the animation silently never renders in an export | yes, both timelines | L1699 (trace/comet/pill), L1448 (mask) |
| 5 | `UIBackgroundTask` around the export — backgrounding mid-render kills it with **-11847** | yes | L1754 |
| 6 | `cancelExport()` in the expiration handler so a partial file surfaces as an error | yes | L1756 |
| 7 | `beginBackgroundTask` on the **main thread** | yes, **plus** a `Thread.isMainThread` guard so a synchronous API cannot deadlock on `.main.sync` | L1759 |
| 8 | `endBackgroundTask` in a `defer` | yes (captures the id into a `let` first) | L1763 |
| 9 | `.cancelled` is an error too — JS must not record a half-written file as `done` | yes, verbatim | L1772 |
| 10 | Partial output removed on failure | yes | L1784 |
| 11 | `outputFileType = .mp4`, `shouldOptimizeForNetworkUse = true` | yes | L1743, L1745 |
| 12 | Portrait `renderSize` via `preferredTransform` (`abs(b)==1 && abs(c)==1`) | yes, verbatim | L1602 |
| 13 | `computeFillTransform` on the layer instruction | yes — **duplicated** as `TracerRenderV3.fillTransform`, arithmetic identical (see §6.4) | L1719 |
| 14 | `animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer:in:)` | yes | L1713 |
| 15 | `instruction.timeRange` = the whole **composition** duration | yes (recomputed *after* the freeze insert) | L1717 |
| 16 | `animStartSec < duration - 0.4` → `ERR_TRACER_ANIM_WINDOW` | yes (against the **composed** duration) | L1655 |
| 17 | Fresh layers, **never** attached to any view | yes | L1691 |
| 18 | Layer shadows rasterise through the animation tool; **CIFilter blur does not** — never attempt it | yes: the glow is `shadowRadius`/`shadowOpacity` on the core layer and on the comet. No `CIFilter` anywhere in the file | L1314 |
| 19 | `CATextLayer` renders upright with **no** flip transform | yes — no transform on either text layer | L978, L992 |
| 20 | Semaphore-wait on `exportAsynchronously` | yes | L1779 |
| 21 | `autoreleasepool` around the work | yes (plus one per decoded frame in the occluder pass) | L1535 |

Two additions on top of HEAD, both taken from `origin/tracer-v2`:

| | | |
|---|---|---|
| A6 serial export gate | present, but **file-private** (`tracerV3ExportGate`) | see §7.3 |
| I11b strict spec validation | present, ported | §3 |

---

## 6. Ported verbatim vs changed

### 6.1 Ported essentially unchanged
- The entire composition/export pipeline from `renderTracerOnClipImpl` (table above).
- `TracerRenderSpecV2.parse`'s I11b validation → `TracerRenderV3Spec.parse`.
- `buildTracerV2Overlay`'s cumulative-arc-length `strokeEnd` keyframes and its band trick
  (full path + static `strokeStart` + clamped `strokeEnd` values).
- The comet's explicit-values position keyframes and its 0.25 s fade.
- `tracerColor` (renamed `tracerV3Color`; the ShotTracer one is file-private).
- `_make_pill`, `_pill_anchor`, `_pill_position`, `_avoid_mask` geometry and costs.
- The taper and depth-fade formulas and every constant in `V3Look`.

### 6.2 Deliberate changes from the v2 branch, and why
| change | why |
|---|---|
| core stroke alpha 0.75 → **0.95** | `TracerStyle.core_alpha` is 0.95 and every measured lab render used it |
| comet diameter 10 px → **12 px**, shadow radius 8 → **9**, opacity 0.9 → **0.85** | `comet_r = 6` (⇒ Ø12), `comet_glow_sigma = 9`, `comet_glow_alpha = 0.85` |
| pill background alpha 0.55 → **0.6**, fonts 44/26 → **64/34**, pad 22/12 → **26/14** | `TracerStyle.label_*` after render2 §3.4 measured the 44 px version illegible at phone scale |
| 3 arc-length bands with widths 1.0/0.6/0.35 → **6 depth bands** with measured taper + fade | the v2 taper was an invented cosmetic; V3 has real depths |
| pill at 55 % of the draw → **at the apex** | render3 §6 |
| ease curve `(0.17, 0.67, 0.45, 1.0)` on the draw | **removed.** The keyframe pacing *is* the timing; an ease on top of it would pull the tip off the ball, which is the exact bug the arc-length keyframes exist to fix |
| `debugBareExport` / `debugNoShadow` | **dropped.** They were a crash-bisect ladder for the tracer-sim harness; carrying dead debug switches into a new file is dead code |
| output path chosen internally | **caller supplies `outputURL`** (the API asked for it) |

### 6.3 Deliberate changes from the lab, and why
| lab | here | why |
|---|---|---|
| true Gaussian glow (σ 8 / 2 / 0.6 px, three blurred masks) | layer **shadows** | CIFilter blur does not rasterise through the animation tool — the in-repo landmine. Same substitution the render report recommends |
| continuous per-node width taper (56–81 polyline runs/frame) | 6 stepped bands | a `CAShapeLayer` has one `lineWidth`; render2's app-path paragraph specifies exactly this |
| per-frame CPU compositing of the trace prefix | one static layer tree + keyframes | keeping `AVAssetExportSession` + the animation tool is what preserves all 21 landmine guards; the alternative is ~600 lines of new Metal and a new colour-management surface |
| `yolov8n-seg` masks | `VNGeneratePersonSegmentationRequest` `.balanced` | instructed, and the lab's own app-path note |
| box-gated segmentation (`refresh_near`, `limb_reach_px` margin) | segment **every** frame in the window | Vision has no cheap box step, and per-frame removes the two wave-4 gate bugs by construction |
| **moving-limb / club mask** (`limb=True`, bg thr 24, motion thr 16, lag 0.06·fps, `limb_max_growth = 0.25`) | **NOT implemented** | see §7.4 — this is the one named lab mechanism deliberately left out, with reasons |

### 6.4 Duplication that has to be watched
`TracerRenderV3.fillTransform` is a copy of `ShotDetectorModule.computeFillTransform`
(plus a divide-by-zero guard). It is duplicated because that method lives on an
ExpoModulesCore module type and this file must stay compilable without the pods. **If one
changes, they must change together** — the comment in the file says so.

---

## 7. What could NOT be verified, and what a device has to settle

### 7.1 Nothing renders
`swiftc -parse` and `swiftc -typecheck` both pass, clean, at
`-target arm64-apple-ios15.1` **and** `-target arm64-apple-ios15.0` **and**
`-target arm64-apple-ios14.0` (the podspec's declared floor), `-swift-version 5`, against
the iPhoneOS 26.5 SDK. No warnings. That is the whole of the verification. **This file has
never produced a frame.**

Commands actually run:
```
xcrun swiftc -parse     -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios15.0 -swift-version 5 TracerRenderV3.swift
xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios{14.0,15.0,15.1} -swift-version 5 TracerRenderV3.swift
```

### 7.2 The highest-risk unverified assumption: mask image orientation
`CALayer.contents` images are assumed to composite through
`AVVideoCompositionCoreAnimationTool` **upright**, i.e. CGImage row 0 at the top of the
frame. The reasoning: this repo has device-verified that the parent layer's +y is up (the v1
pill sits above the apex with `apexPx.y + pillH * 1.2`) and that `CATextLayer` glyphs render
upright with **no** flip. Layer `contents` has not been exercised in this pipeline at all.

If it is wrong, the occlusion cut appears **vertically mirrored** — the trace is punched out
where the golfer is *not*. It is unmissable in one frame, and the fix is one line:
`maskLayer.transform = CATransform3DMakeScale(1, -1, 1)` (the pill's cost map would flip with
it, since both read the same buffers). `stats.maskOrientationAssumption` carries the flag so
the first device log says which assumption was in force.

**First device test should be: one clip with a person clearly on one side of the frame.**

### 7.3 The export gate does not cover `composeReelOnDevice`
`tracerV3ExportGate` is file-private, so it makes concurrent *V3* renders impossible but does
**not** serialise against `composeReelOnDevice`'s export session. `origin/tracer-v2` solved
that with a module-level `tracerExportSerialGate` shared by both files — which would require
editing `ShotTracer.swift`, which this agent must not do. If that symbol ever lands, replace
this one with it: the shape is identical and the change is two lines. Until then, two
concurrent exports (a tracer batch racing a reel compose) can still hit **-11838**, exactly
as they can today on HEAD.

### 7.4 The wave-5 moving-limb / club mask is NOT implemented
render3 §7.2 lists three occlusion fixes. Two of them — per-frame refresh and a hit test
widened by the club reach — are here by construction (§4.2). The third, a frame-difference
limb/club mask, is not, and that is a judgement call, not an oversight:

- Its thresholds (24 and 16 grey levels, a `0.06·fps` lag, a 0.25 growth cap) were measured
  against a lab pipeline and against `yolov8n-seg` masks, which behave differently from
  Apple's person segmentation. They cannot be re-measured without a device and real footage.
- Its known failure mode is the **bad** direction. At the first growth cap the lab tried
  (0.6) it grabbed a driving-range safety net on IMG_7600 and **hid the trace behind it** —
  253 px of trace wrongly hidden at k300. Shipping a mechanism whose calibration is
  unverifiable, whose failure is "the tracer disappears", into a dev build, is a worse trade
  than a club occasionally drawn over.
- The measured benefit is real but modest: trace-orange on the club region 146 → 94 px over
  four frames (−36 %), on one clip.

**What it costs:** on a shot where the club crosses the trace in the first frames, the trace
may be drawn over the shaft. Apple's person segmentation does include arms and often
includes held objects, so this may not reproduce at all; that is exactly what a device round
would settle.

**Path back:** it slots in as one extra pass inside `TracerOccluder.run`, between the
resample and the dilate, plus a connected-components step against the person mask. Nothing
else in the file changes.

### 7.5 Other things stated rather than asserted
- **Discrete `contents` keyframes through the animation tool.** Masks are core CA
  compositing and should rasterise, but this specific combination (an animated `contents` on
  a `CALayer.mask`, through `AVVideoCompositionCoreAnimationTool`) is unexercised in this
  repo. If it does not work the symptom is a trace that is never occluded (or, if the model
  value is somehow lost, never drawn — which is why the mask layer's model value and first
  keyframe are a fully-**opaque** image, not `nil`).
- **`scaleTimeRange` on a one-frame segment.** AVFoundation holds frames when a segment is
  stretched (it is how slow-motion export works), so this should be a true freeze. Untested.
- **Cost.** The occluder is a **second full decode pass** over the clip from impact to the
  end, plus one Vision segmentation per frame. The lab measured 11.8–13.0 ms per
  `yolov8n-seg` full pass on a Mac; Apple's `.balanced` on an A17 is likely comparable but
  that is an inference, not a measurement. Budget roughly *(frames after impact) × ~15 ms*
  on top of the export. `stats.occlusion.msTotal` measures it for real on the first run.
- **Mask memory.** Masks are PNG round-tripped and reopened with
  `kCGImageSourceShouldCache: false` so the keyframe array holds compressed silhouettes
  (tens of KB each) instead of ~230 KB rasters. Whether Core Animation then retains the
  decoded bitmaps is not controllable from here; a hard cap of 1 200 mask frames bounds the
  worst case, and `stats.occlusion.reason` says when it bit.
- **Two-line pill stacking.** The headline is placed at the higher y on the inference that a
  sublayer inherits the parent's +y-is-up geometry. If a device shows the lines swapped, swap
  the two `position` lines in `TracerLabel.makePill` and nothing else.
- **4K.** `AVAssetExportPreset1920x1080` downscales a 4K source, as it does today on HEAD.
  Untouched, but worth knowing the V3 look was measured by the lab at both 1080p and 4K.

- **Framework linking.** The file imports `ImageIO` and `UniformTypeIdentifiers`, neither of
  which is in the podspec's `s.frameworks`. Swift autolinking emits the linker directive from
  `import`, and this pod already relies on that — `ShotTracer.swift` imports `UIKit`,
  `QuartzCore` and `CoreMotion`, none of them listed, and that ships today. So this should be
  fine; if a link error ever says otherwise, adding the two names to `s.frameworks` is the fix
  (the podspec is not this agent's file).

### 7.6 One thing noticed in passing, not fixed (not this agent's file)
`modules/shot-detector/ios/ShotDetector.podspec` declares `:ios => '14.0'` even though the
app ships min iOS 15.1. Any iOS-15 API in the module fails to compile at that floor —
`VNGeneratePersonSegmentationRequest` did, and it is guarded here with
`guard #available(iOS 15.0, *)`. Other agents adding Swift to this module need the same
guard, or the podspec needs raising to 15.1. Not changed: the podspec is not this agent's
file.
