# Tracer V3 — integrating the lab pipeline into the app (dev build, config-gated)

**Brief (Henry, 6 Sep 2026):** "integrate this into the app for the dev build but make it a config so
it's super easy to revert, but yes integrate with GPS and ensure location etc… if it can be done
locally that's good too."

**Source of the work:** `~/projects/clippar/tracer-lab` (5 waves, ~28 agents, three adversarial
reviews). Read `tracer-lab/NEXT.md` and the component reports before changing any maths here.

## The one-line revert

`constants/config.ts` → `tracer.enabled`. Off = the app is byte-identical to today: no GPS session,
no detection, no render, no new columns written, no UI. It ships **on for `APP_VARIANT=development`
only** (`variantIsDev()`), off for preview/production. A second knob, `tracer.engine: 'v1' | 'v3'`,
selects the old Vision-trajectory/Bézier path or the new physics path, so v3 can be disabled without
losing v1.

## What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Capture: per-shot GPS fix + accuracy, compass heading, CoreMotion pitch | `hooks/useCamera.ts`, `app/(tabs)/record.tsx`, gated on `config.tracer.enabled` | works; **replaced** by the continuous GPS session below |
| Storage: `tracer_file_uri/status/meta/rendered_at`, `gps_*`, `camera_heading_*`, `camera_pitch_deg`, invalidation + predecessor staling | `lib/storage.ts` | reuse as-is |
| Orchestration: `processAllTracers` batch, pending gates on export/save/share | `hooks/useEditorState.ts`, `app/round/editor.tsx` | reuse; swap the per-clip body |
| Native render: `renderTracerOnClipImpl` CALayer burn-in with every export landmine guarded | `modules/shot-detector/ios/ShotTracer.swift` | reuse the pipeline, replace the geometry |
| **Polyline (`samples[]`) render spec + CAKeyframeAnimation** | `origin/tracer-v2:…/ShotTracer.swift` (+535 lines over HEAD) | **port it** — it is the v3 spec shape |
| **GPS session: 180 s ring, impact-anchored estimator, staleness, effAcc** | `origin/tracer-v2:clippar_app/lib/gpsSession.ts` (453) + `hooks/useGpsSession.ts` (157) + `tests/gpsSession.test.ts` | **port it** — this is the "integrate with GPS" half |
| Dev settings screen | `origin/tracer-v2:clippar_app/app/profile/tracer-dev-settings.tsx` | port, extend for v3 |
| CoreML bundling: `.mlpackage` → `resource_bundles` → compile-once-at-runtime cache | `modules/swing-vision/` | copy the pattern for the golf-ball model |

## Where each stage runs

**On-device, always. No server, no network.** Same shape as the existing on-device trimming.

| Stage | Home | Why |
|---|---|---|
| Ball detection (background model, DoG blobs, pose-seeded address, launch search, Kalman) | **Swift** — `TracerDetect.swift` (new) | needs per-frame pixels; vImage/Accelerate; one 5.9 MB CoreML model for the address ball; Vision pose is already in the app |
| Camera model (pinhole, horizon, depth-from-diameter) | **TS** — `lib/tracerCamera.ts` | pure algebra, must be unit-testable |
| Flight physics (RK4, drag + Magnus, spin decay) | **TS** — `lib/tracerPhysics.ts` | pure; validated against TrackMan averages by test |
| Inverse fit (bounded LM over v0/θ/φ/spin/tilt/t0, carry constraint, error budget) | **TS** — `lib/tracerFit.ts` | pure; the lab's whole hold-out validation transfers as tests |
| Decision ladder + refusals (putt, topped, unfittable, implausible) | **TS** — `lib/tracerV3.ts` | pure; testable |
| Render (polyline, glow, comet, person+club occlusion, freeze completion, pill) | **Swift** — `TracerRenderV3.swift` (new) | pixels; AVFoundation + CoreAnimation |

The lab measured every stage cheap on a phone (detector 1–3 ms/frame in vImage est., fit tens of ms,
physics microseconds, render = the existing export cost). **`npm run verify` is the gate**, which is
why the maths lives in TS: the flight model, the camera, the fit and the ladder are all covered by
node tests. Swift is only what must touch pixels.

## GPS, precisely

1. `hooks/useGpsSession.ts` runs `watchPositionAsync({BestForNavigation, distanceInterval: 0})` while
   the record tab is focused; `Balanced` on blur; re-warms on AppState resume. **When-in-use only —
   no background modes, no Always prompt.**
2. Per shot the fix is an accuracy-weighted median over the stationary window **anchored at IMPACT**
   (`recording_start_ts + impact_time_ms`), never the start press (the golfer presses at the bag and
   walks 5–20 s to the ball). Stop-press anchor is the fallback until impact lands.
3. Carry = haversine(this shot's fix, the immediate same-hole next shot's fix), with the lab's
   uncertainty model: GPS + bag offset (~3 m) + club-bucket roll + the lens-focal-length systematic.
4. The carry enters the fit as a **scale constraint**, not as truth: `carry_as_scale` when the
   pixel-only carry is loose, `carry_tension`/`carry_inconsistent` when it fights the pixels. The
   label is rounded to the honest step (1/5/10 m) and reads "no GPS" when there is none.
5. **The last shot of a hole has no successor**, so no GPS carry — it renders pixel-only and unlabelled.

## Honest limits carried in from the lab (state these, do not paper over them)

- Ball speed and carry ride on the lens focal length. **On device we read it from `AVCaptureDevice`
  intrinsics** (`isCameraIntrinsicMatrixDeliveryEnabled`, else `videoFieldOfView` ÷ zoom), which is the
  fix the lab could not have — its footage had no FOV metadata and carried a ±12 % systematic.
- Camera pitch maps 1:1 into launch angle: CoreMotion's ±0.5° is the floor.
- A shot hit exactly down the camera axis has no lateral information and renders as a near-vertical
  line. Real, not a bug. Mitigation is a capture tip, not code.
- The detector finds the ball on ~half of unseen footage; yellow balls and far cameras defeat the
  address finder. Every failure must be a **skip**, never a fabricated arc.
- 6 of 19 lab renders put the landing behind the golfer. Correct occlusion, unlucky framing.

## Build

`eas build --profile development --platform ios` (dev client, `com.clippar.app.dev`). **Not run by
this session — EAS build credits are nearly exhausted (5 Sep) and spending the last ones is Henry's
call.** `npm run verify` must be green first.
