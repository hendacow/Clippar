import AVFoundation
import CoreGraphics
import ImageIO
import QuartzCore
import UIKit
import UniformTypeIdentifiers
import Vision

// ============================================================================
// MARK: - TracerRenderV3 — the V3 polyline tracer burn-in
// ============================================================================
//
// WHAT THIS IS
// A second, independent renderer for the shot tracer. It consumes the V3
// render spec (a time-sampled polyline plus per-sample depth) and burns an
// animated trace into a clip with AVFoundation + Core Animation, exactly the
// way `renderTracerOnClipImpl` in ShotTracer.swift does — that file is the
// shipped v1 path and is deliberately NOT touched, so turning V3 off restores
// today's behaviour by not calling this file at all.
//
// WHY IT IS A SEPARATE FILE AND A SEPARATE TYPE
// `renderTracerOnClipImpl` lives in an `extension ShotDetectorModule` and
// speaks ExpoModulesCore's `Promise`/`Exception`. This file deliberately
// imports NO ExpoModulesCore: it is pure AVFoundation/CoreAnimation/Vision, so
// it can be type-checked on its own with
//   xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
//       -target arm64-apple-ios15.0 -swift-version 5 TracerRenderV3.swift
// without the pods being installed. The Expo registration (another agent's
// file) wraps `TracerRenderV3.render` and maps `TracerRenderV3Error` onto
// `Exception(name: err.code, description: err.message)`.
//
// COORDINATE CONVENTIONS (shared with the TS side — see lib/tracerV3.ts)
// The render spec is NORMALIZED, display-oriented, BOTTOM-LEFT origin — the
// same convention as `TracerRenderSpec`/`TracerRenderSpecV2` and the same one
// AVVideoCompositionCoreAnimationTool uses, so mapping to render pixels is a
// pure scale with NO y-flip. Detector/camera/fit space (top-left pixels) never
// reaches this file: exactly one function converts, in lib/tracerV3.ts.
//
// PROVENANCE OF EVERY NUMBER
// The look is ported from ~/projects/clippar/tracer-lab (`lib/render.py`,
// `experiments/render{,2,3}/report.md`). Constants live in one place —
// `V3Look` below — and each carries the lab symbol it came from. Where this
// file deviates from the lab or from the v2 branch, the comment says so and
// says why; those deviations are also listed in
// docs/tracer-v3/native-render.md.
//
// WHAT THIS FILE CANNOT DO
// Nothing here has been rendered. There is no pod install in this checkout, so
// the file has been `-parse`d and `-typecheck`ed and NOTHING MORE. Camera,
// video-pipeline and Core-Animation-through-the-export-tool behaviour is never
// judged from a simulator in this repo (house rule), so every visual claim
// below is a design intent, not a result. The report names the specific
// assumptions a device has to settle.
// ============================================================================

// MARK: - Errors

/// Error surface of this file. `code` is the string the JS side sees as the
/// exception name (the Expo wrapper does `Exception(name: code, description:
/// message)`), so it is part of the API and must stay stable. Codes mirror the
/// shipped v1 renderer's so the JS error handling does not have to fork.
struct TracerRenderV3Error: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Look constants (every one traced to tracer-lab/lib/render.py)

/// Widths, radii and font sizes are pixels **at a 1080-wide render** and are
/// multiplied by `widthScale = renderSize.width / 1080` at use, which is both
/// the lab's `ref_width` convention and the shipped v1 renderer's.
private enum V3Look {
    /// `TracerStyle.ref_width` (lib/render.py).
    static let refWidth: CGFloat = 1080

    // ---- strokes: TracerStyle.{glow,mid,core}_{w,alpha} --------------------
    static let glowAlpha: CGFloat = 0.45
    static let midAlpha: CGFloat = 0.60
    /// 0.95 in the lab. The v2 branch used 0.75; the lab raised the core to
    /// near-opaque and every measured render in `out/e2e3/` used 0.95.
    static let coreAlpha: CGFloat = 0.95
    /// `shadowRadius` on the core layer, standing in for the lab's Gaussian
    /// glow. Layer shadows DO rasterize through the animation tool; CIFilter
    /// blur does NOT (in-repo landmine, see ShotTracer.swift).
    static let coreShadowRadiusPx: CGFloat = 8.0
    static let coreShadowOpacity: Float = 0.9

    // ---- depth cues: TracerStyle.taper_* / depth_fade_* --------------------
    /// `taper_min` — wave 3 0.35 → wave 4 0.18 → **wave 5 0.25**, raised
    /// because at 0.18 the far glow measured 0–3 px at 1080p, under the
    /// visibility floor (render3 report §8).
    static let taperMinDefault: Double = 0.25
    /// `taper_gamma`: width multiplier = clip((d0/d)^gamma, taper_min, 1).
    static let taperGamma: Double = 0.7
    /// `depth_fade_min` — wave 4 0.5 → **wave 5 0.75**, same reason.
    static let depthFadeMinDefault: Double = 0.75
    /// `depth_fade_ratio`: alpha = 1 at d0, depth_fade_min at d0 × ratio.
    static let depthFadeRatio: Double = 20.0
    /// How many depth bands the polyline is split into. The lab draws a
    /// continuous per-node taper (56–81 `cv2.polylines` runs per frame); a
    /// CAShapeLayer has exactly one `lineWidth`, so the taper has to be
    /// stepped — render2's app-path paragraph says "a handful of CAShapeLayer
    /// sub-layers by depth band". 6 bands × 3 strokes = 18 shape layers, which
    /// is the trade: more bands is a smoother taper and more layers for the
    /// animation tool to composite on every exported frame.
    static let depthBands = 6

    // ---- comet: TracerStyle.comet_* / land_* ------------------------------
    /// `comet_r` = 6 px radius at ref width → 12 px diameter. (The v2 branch
    /// used 10 px; the lab's own renders are 12.)
    static let cometRadiusPx: CGFloat = 6.0
    /// `comet_glow_sigma` 9 px / `comet_glow_alpha` 0.85, as the layer shadow.
    static let cometGlowSigmaPx: CGFloat = 9.0
    static let cometGlowAlpha: Float = 0.85
    /// `comet_fade_s` — fade after the arc completes.
    static let cometFadeSec: Double = 0.25
    /// `comet_min_scale` — the comet never shrinks below this fraction.
    static let cometMinScale: Double = 0.5
    /// `land_hold_s` default, and `land_burst_gain` — the comet holds and
    /// flares on the landing point before it fades. 1.6 "looked like a blob on
    /// the 23 m chip", hence 1.4.
    static let landHoldSecDefault: Double = 0.2
    static let landBurstGain: Double = 1.4

    // ---- label: TracerStyle.label_* + _make_pill ---------------------------
    static let labelFadeSec: Double = 0.3
    /// 64 px at 1080 ≈ 23 pt when the frame fills a phone; the first version
    /// was 44 px and was not legible at phone scale (render2 §3.4).
    static let labelFontPx: CGFloat = 64.0
    /// 34 px ≈ 12 pt on a phone.
    static let labelSubPx: CGFloat = 34.0
    static let labelAlpha: CGFloat = 0.6
    /// `_make_pill`: pad_h 26, pad_v 14, gap 6, radius min(H/2, 22).
    static let labelPadHPx: CGFloat = 26.0
    static let labelPadVPx: CGFloat = 14.0
    static let labelGapPx: CGFloat = 6.0
    static let labelRadiusPx: CGFloat = 22.0
    /// `_pill_anchor`: 30 px beside the apex, 12 px frame margin.
    static let labelAnchorOffsetPx: CGFloat = 30.0
    static let labelMarginPx: CGFloat = 12.0
    /// A runaway label would blow the pill off the frame. The lab's strings are
    /// "250 m" / "apex 21 m"; these caps are generous and are CLAMPED (with a
    /// note in `stats`) rather than rejected, because a cosmetic string is not
    /// worth failing a whole render over.
    static let labelMaxChars = 24
    static let labelSubMaxChars = 40

    // ---- occlusion: TracerStyle.occlusion_* -------------------------------
    /// `occlusion_grow_px` — dilate the person mask first: "hide a little too
    /// much rather than paint on the golfer".
    static let occlusionGrowPx: CGFloat = 2.0
    /// `occlusion_feather_px` — Gaussian sigma on the mask edge.
    static let occlusionFeatherPx: CGFloat = 2.5
    /// Long side of the per-frame mask raster. Vision's `.balanced` person mask
    /// is itself only ~504 px on its long side, so 640 does not throw away
    /// information; it keeps the per-frame masks small enough to hold for a
    /// whole clip.
    static let maskLongSide = 640
    /// `_avoid_mask`: people are dilated by 24 px at ref width before the pill
    /// placement, and the trace by 2 × glow width.
    static let pillAvoidPersonDilatePx: CGFloat = 24.0
    static let pillAvoidTraceWidthMul: CGFloat = 2.0
    static let pillAvoidCometRadiusMul: CGFloat = 4.0

    // ---- freeze completion: render_track(freeze_max_s=) --------------------
    /// `freeze_max_s` — the held tail is capped so a bad spec cannot turn a
    /// 10 s clip into a minute of frozen frame.
    static let freezeMaxSec: Double = 6.0

    // ---- keyframe budget ---------------------------------------------------
    /// The fit produces 120 Hz samples, so an 8 s flight is ~960 of them and
    /// every one of the 18 stroke layers would carry that many keys. The PATH
    /// keeps every point (geometry is never decimated); only the pacing keys
    /// are thinned, and CA interpolates between them linearly exactly as it
    /// would have between the dropped ones.
    static let maxKeyframes = 600
}

/// Parse "#RRGGBB" into UIColor at the given alpha; falls back to the design's
/// tracer orange (#FF3B1F) on malformed input so a bad config can't crash a
/// render. Same behaviour and same fallback as `tracerColor` in
/// ShotTracer.swift — duplicated rather than shared because that one is
/// file-private and this file must stay independent of it.
private func tracerV3Color(_ hex: String, alpha: CGFloat) -> UIColor {
    var h = hex.trimmingCharacters(in: .whitespaces)
    if h.hasPrefix("#") { h.removeFirst() }
    guard h.count == 6, let v = UInt32(h, radix: 16) else {
        return UIColor(red: 1.0, green: 0.23, blue: 0.12, alpha: alpha)
    }
    return UIColor(
        red: CGFloat((v >> 16) & 0xFF) / 255.0,
        green: CGFloat((v >> 8) & 0xFF) / 255.0,
        blue: CGFloat(v & 0xFF) / 255.0,
        alpha: alpha
    )
}

// ============================================================================
// MARK: - The render spec
// ============================================================================

/// The V3 render spec (SHARED CONVENTION 3). Normalized, display-oriented,
/// BOTTOM-LEFT origin.
///
/// Validation is strict and LOUD, inherited from the v2 branch's invariant
/// I11b: a spec that violates it is `ERR_TRACER_SPEC`, never a silent downgrade
/// and never a CAKeyframeAnimation that no-ops. The four hard invariants are
/// `samples.count >= 2`, `tSec` strictly increasing, `tSec[0] == 0`, and
/// `tSec.last == animDurationSec` — the last three are what CA needs for
/// `keyTimes` (first 0, last 1, strictly increasing) and the first is what a
/// keyframe animation needs to exist at all.
///
/// Unlike the v2 spec, styling fields sit at the TOP level (not nested under
/// `styling`) because that is what SHARED CONVENTION 3 fixes; nothing emits the
/// v2 shape any more, so the nested form is not accepted.
struct TracerRenderV3Spec {

    struct Sample {
        let x: CGFloat
        let y: CGFloat
        let tSec: Double
    }

    let samples: [Sample]
    /// Per-sample depth along the optical axis, metres. Optional: without it
    /// there is no depth information, so the taper and the depth fade are
    /// switched off entirely (scale = 1 everywhere) rather than guessed —
    /// which is what `lib/render.py:track_from_pixels` does when it has no
    /// radii.
    let depths: [Double]?
    let animStartSec: Double
    let animDurationSec: Double

    var color: String = "#FF3B1F"
    var coreColor: String = "#FFD9A0"
    var lineWidthPx: CGFloat = 4
    var midWidthPx: CGFloat = 8
    var glowWidthPx: CGFloat = 16
    var cometHead: Bool = true
    var taperMin: Double = V3Look.taperMinDefault
    var depthFadeMin: Double = V3Look.depthFadeMinDefault
    var occlusion: Bool = true

    var labelText: String?
    var labelSubText: String?
    var labelAtApex: Bool = true
    /// True when a label string was longer than the cap and was clamped;
    /// surfaced in `stats` so a device log shows it rather than it being silent.
    var labelClamped: Bool = false

    /// Stop the trace at the SEEN touchdown instead of the fitted landing.
    /// End-time truncation only — the lab measured that retargeting the
    /// polyline onto a landing pixel pulled the tip off the real ball by 6–9 px
    /// on the four frames before touchdown (render2 §6, `land_px` reverted).
    var endAtSec: Double?
    /// Clip-timeline second the OUTPUT must reach. When the fitted flight
    /// outlasts the clip, the last source frame is held to here so the trace
    /// still lands (render3 §4).
    var freezeCompleteToSec: Double?
    var landHoldSec: Double = V3Look.landHoldSecDefault

    // MARK: parse

    static func parse(json: String) throws -> TracerRenderV3Spec {
        func bad(_ why: String) -> TracerRenderV3Error {
            TracerRenderV3Error(code: "ERR_TRACER_SPEC", message: why)
        }
        guard !json.isEmpty,
              let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw bad("V3 spec: not a JSON object")
        }
        guard let rawSamples = obj["samples"] as? [[String: Any]] else {
            throw bad("V3 spec: missing `samples` array")
        }
        guard let start = (obj["animStartSec"] as? NSNumber)?.doubleValue,
              let dur = (obj["animDurationSec"] as? NSNumber)?.doubleValue,
              start.isFinite, start >= 0, dur.isFinite, dur > 0 else {
            throw bad("V3 spec: animStartSec/animDurationSec missing or non-finite/non-positive")
        }
        // >= 2 samples: a keyframe animation needs at least two keys.
        guard rawSamples.count >= 2 else {
            throw bad("V3 spec: need >=2 samples, got \(rawSamples.count)")
        }
        var samples: [Sample] = []
        samples.reserveCapacity(rawSamples.count)
        var prevT = -Double.greatestFiniteMagnitude
        for (i, s) in rawSamples.enumerated() {
            guard let x = (s["x"] as? NSNumber)?.doubleValue,
                  let y = (s["y"] as? NSNumber)?.doubleValue,
                  let t = (s["tSec"] as? NSNumber)?.doubleValue,
                  x.isFinite, y.isFinite, t.isFinite else {
                throw bad("V3 spec: sample \(i) has missing/non-finite x/y/tSec")
            }
            // Strictly increasing: equal keyTimes glitch a CAKeyframeAnimation.
            if t <= prevT {
                throw bad("V3 spec: sample \(i) tSec \(t) not strictly greater than previous \(prevT)")
            }
            prevT = t
            samples.append(Sample(x: CGFloat(x), y: CGFloat(y), tSec: t))
        }
        // First keyTime must be 0.
        if abs(samples[0].tSec) > 1e-6 {
            throw bad("V3 spec: first sample tSec must be 0, got \(samples[0].tSec)")
        }
        // Last keyTime must be exactly 1.0, i.e. tSec.last == animDurationSec.
        let lastKeyTime = samples[samples.count - 1].tSec / dur
        if abs(lastKeyTime - 1.0) > 1e-6 {
            throw bad("V3 spec: last keyTime \(lastKeyTime) != 1.0 (tSec.last \(samples[samples.count - 1].tSec) must equal animDurationSec \(dur))")
        }
        // A zero-length path makes every arc-length fraction 0 and the
        // strokeEnd draw-on silently no-ops (v2's degenerate-polyline check).
        var arc = 0.0
        for i in 1..<samples.count {
            let dx = Double(samples[i].x - samples[i - 1].x)
            let dy = Double(samples[i].y - samples[i - 1].y)
            arc += (dx * dx + dy * dy).squareRoot()
        }
        if !(arc > 1e-9) {
            throw bad("V3 spec: degenerate polyline (zero arc length)")
        }

        // Depths are optional, but if present they must line up 1:1 with the
        // samples and be positive — a depth of 0 divides by zero in the taper.
        var depths: [Double]? = nil
        if let rawDepths = obj["depths"] as? [NSNumber] {
            guard rawDepths.count == samples.count else {
                throw bad("V3 spec: depths has \(rawDepths.count) entries, samples has \(samples.count)")
            }
            var d: [Double] = []
            d.reserveCapacity(rawDepths.count)
            for (i, n) in rawDepths.enumerated() {
                let v = n.doubleValue
                guard v.isFinite, v > 1e-3 else {
                    throw bad("V3 spec: depths[\(i)] = \(v) is not a finite positive distance")
                }
                d.append(v)
            }
            depths = d
        }

        var spec = TracerRenderV3Spec(samples: samples, depths: depths,
                                      animStartSec: start, animDurationSec: dur)

        if let v = obj["color"] as? String { spec.color = v }
        if let v = obj["coreColor"] as? String { spec.coreColor = v }
        if let v = (obj["lineWidthPx"] as? NSNumber)?.doubleValue, v > 0 { spec.lineWidthPx = CGFloat(v) }
        if let v = (obj["midWidthPx"] as? NSNumber)?.doubleValue, v > 0 { spec.midWidthPx = CGFloat(v) }
        if let v = (obj["glowWidthPx"] as? NSNumber)?.doubleValue, v > 0 { spec.glowWidthPx = CGFloat(v) }
        if let v = obj["cometHead"] as? Bool { spec.cometHead = v }
        if let v = (obj["taperMin"] as? NSNumber)?.doubleValue, v.isFinite, v > 0, v <= 1 { spec.taperMin = v }
        if let v = (obj["depthFadeMin"] as? NSNumber)?.doubleValue, v.isFinite, v > 0, v <= 1 { spec.depthFadeMin = v }
        if let v = obj["occlusion"] as? Bool { spec.occlusion = v }
        if let v = obj["labelAtApex"] as? Bool { spec.labelAtApex = v }

        if let v = obj["labelText"] as? String, !v.isEmpty {
            if v.count > V3Look.labelMaxChars {
                spec.labelText = String(v.prefix(V3Look.labelMaxChars))
                spec.labelClamped = true
            } else {
                spec.labelText = v
            }
        }
        if let v = obj["labelSubText"] as? String, !v.isEmpty {
            if v.count > V3Look.labelSubMaxChars {
                spec.labelSubText = String(v.prefix(V3Look.labelSubMaxChars))
                spec.labelClamped = true
            } else {
                spec.labelSubText = v
            }
        }

        // endAtSec: null/absent is "no override". A non-finite or non-positive
        // value is a JS bug and is rejected; a value past the fitted landing is
        // CLAMPED (and reported), because "stop no later than the fit" is
        // always the safe reading of "stop at the seen touchdown".
        if let n = obj["endAtSec"] as? NSNumber {
            let v = n.doubleValue
            guard v.isFinite, v > 0 else {
                throw bad("V3 spec: endAtSec \(v) must be a finite positive time")
            }
            spec.endAtSec = min(v, dur)
        }
        if let n = obj["freezeCompleteToSec"] as? NSNumber {
            let v = n.doubleValue
            guard v.isFinite, v >= 0 else {
                throw bad("V3 spec: freezeCompleteToSec \(v) must be a finite non-negative time")
            }
            spec.freezeCompleteToSec = v
        }
        if let v = (obj["landHoldSec"] as? NSNumber)?.doubleValue, v.isFinite, v >= 0 {
            spec.landHoldSec = min(v, 2.0)  // a "hold" longer than 2 s is a stall, not a hold
        }
        return spec
    }
}

// ============================================================================
// MARK: - Resolved geometry (spec -> render pixels, with endAtSec applied)
// ============================================================================

/// The polyline as it will actually be drawn: render pixels, bottom-left
/// origin, already truncated at `endAtSec` if one was given.
private struct ResolvedTrack {
    let pts: [CGPoint]
    let times: [Double]
    let depths: [Double]?
    /// Cumulative arc-length fraction at each point, 0…1. This is what paces
    /// the `strokeEnd` draw-on: `values` = these fractions, `keyTimes` =
    /// tSec / duration. Ported verbatim from `buildTracerV2Overlay`, and it is
    /// what puts the tip on the ball at every frame rather than on a uniform
    /// fraction of the path (render report, "Draw-on timing").
    let cumFraction: [CGFloat]
    let durationSec: Double
    let apexIndex: Int
    let truncated: Bool

    var apexTimeSec: Double { times[apexIndex] }
    var landingPoint: CGPoint { pts[pts.count - 1] }

    static func build(spec: TracerRenderV3Spec, renderSize: CGSize) throws -> ResolvedTrack {
        func px(_ s: TracerRenderV3Spec.Sample) -> CGPoint {
            // Bottom-left normalized -> render pixels: a pure scale, NO y-flip.
            CGPoint(x: s.x * renderSize.width, y: s.y * renderSize.height)
        }

        var pts = spec.samples.map(px)
        var times = spec.samples.map { $0.tSec }
        var depths = spec.depths
        var truncated = false

        // ---- endAtSec: END-TIME TRUNCATION ONLY -----------------------------
        // The lab implemented the alternative (`Track.retargeted`, warp the last
        // 0.3 s onto a measured landing pixel) and then REVERTED it: a touchdown
        // pixel 7 px off pulled the tip 6–9 px above the real ball on the four
        // frames before touchdown (render2 §6). So the seen touchdown only ever
        // shortens the trace in time; it never moves it in space.
        if let endAt = spec.endAtSec, endAt < times[times.count - 1] - 1e-6 {
            var keep = 0
            while keep + 1 < times.count && times[keep + 1] <= endAt { keep += 1 }
            var newPts = Array(pts[0...keep])
            var newTimes = Array(times[0...keep])
            var newDepths = depths.map { Array($0[0...keep]) }
            if keep + 1 < times.count && endAt > times[keep] + 1e-9 {
                let t0 = times[keep], t1 = times[keep + 1]
                let f = CGFloat((endAt - t0) / (t1 - t0))
                let p0 = pts[keep], p1 = pts[keep + 1]
                newPts.append(CGPoint(x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f))
                newTimes.append(endAt)
                if let d = depths {
                    newDepths?.append(d[keep] + (d[keep + 1] - d[keep]) * Double(f))
                }
            }
            // The invariants still have to hold after truncation, or the
            // keyframe animation is malformed. Two points is the floor.
            guard newPts.count >= 2 else {
                throw TracerRenderV3Error(
                    code: "ERR_TRACER_SPEC",
                    message: "V3 spec: endAtSec \(endAt) leaves fewer than 2 samples")
            }
            pts = newPts
            times = newTimes
            depths = newDepths
            truncated = true
        }

        // Arc length has to be non-degenerate AFTER truncation too.
        var cum = [CGFloat](repeating: 0, count: pts.count)
        var total: CGFloat = 0
        for i in 1..<pts.count {
            let dx = pts[i].x - pts[i - 1].x
            let dy = pts[i].y - pts[i - 1].y
            total += (dx * dx + dy * dy).squareRoot()
            cum[i] = total
        }
        guard total > 1e-9 else {
            throw TracerRenderV3Error(
                code: "ERR_TRACER_SPEC",
                message: "V3 spec: degenerate polyline after endAtSec truncation (zero arc length)")
        }
        let fractions = cum.map { $0 / total }

        // Apex = the highest drawn node. Bottom-left origin, so "highest" is
        // max y. This is `Track.t_apex` (render3 §6) and it is when the pill
        // comes up.
        var apexIndex = 0
        for i in 1..<pts.count where pts[i].y > pts[apexIndex].y { apexIndex = i }

        return ResolvedTrack(pts: pts, times: times, depths: depths,
                             cumFraction: fractions,
                             durationSec: times[times.count - 1],
                             apexIndex: apexIndex, truncated: truncated)
    }

    /// Width multiplier at a sample: `clip((d0/d)^gamma, taper_min, 1)` with d
    /// the depth along the optical axis and d0 the LAUNCH depth — a perspective
    /// taper with a floor so the far end stays visible
    /// (`lib/render.py:track_from_flight`). Without depths there is nothing to
    /// taper by, so the width is flat.
    func taperScale(at i: Int, taperMin: Double) -> Double {
        guard let d = depths, d.count == pts.count else { return 1.0 }
        let d0 = d[0]
        guard d0 > 1e-6, d[i] > 1e-6 else { return 1.0 }
        let s = pow(d0 / d[i], V3Look.taperGamma)
        return min(max(s, taperMin), 1.0)
    }

    /// Alpha multiplier at a sample: a log ramp from 1 at the MINIMUM depth on
    /// the track to `depth_fade_min` at `depth_fade_ratio` × that depth, so the
    /// same depth ratio always gives the same fade whatever the shot length
    /// (`lib/render.py:_segment_alpha`). Note the lab's own asymmetry, kept
    /// here on purpose: the taper is referenced to depths[0] and the fade to
    /// min(depths).
    func depthFade(at i: Int, depthFadeMin: Double) -> Double {
        guard let d = depths, d.count == pts.count, depthFadeMin < 1.0 else { return 1.0 }
        let d0 = max(d.min() ?? 1.0, 1e-3)
        let ratio = max(V3Look.depthFadeRatio, 1.01)
        let f = min(max(log(max(d[i], d0) / d0) / log(ratio), 0.0), 1.0)
        return min(max(1.0 - (1.0 - depthFadeMin) * f, 0.0), 1.0)
    }

    /// Indices used as keyframes. The path always uses every point; only the
    /// pacing keys are thinned, and only above `V3Look.maxKeyframes`.
    func keyframeIndices() -> [Int] {
        let n = pts.count
        if n <= V3Look.maxKeyframes { return Array(0..<n) }
        var out: [Int] = []
        out.reserveCapacity(V3Look.maxKeyframes)
        let step = Double(n - 1) / Double(V3Look.maxKeyframes - 1)
        for k in 0..<V3Look.maxKeyframes {
            let i = Int((Double(k) * step).rounded())
            if out.last != i { out.append(min(i, n - 1)) }
        }
        if out.last != n - 1 { out.append(n - 1) }
        return out
    }
}

// ============================================================================
// MARK: - Person occlusion (VNGeneratePersonSegmentationRequest)
// ============================================================================

private struct OccluderFrame {
    /// Clip-timeline seconds of the source frame this mask came from.
    let timeSec: Double
    /// INVERTED alpha mask: alpha 0 where a person is, 1 elsewhere. Used as
    /// `CALayer.mask` on the trace container, so the trace is punched out
    /// wherever a person stands and the trace passes BEHIND the golfer.
    let image: CGImage
}

private struct OccluderResult {
    let frames: [OccluderFrame]
    let maskWidth: Int
    let maskHeight: Int
    /// Person alpha (255 = person) at each requested time, mask resolution,
    /// row 0 = top. Used only by the pill placement, which has to avoid people.
    let personKept: [[UInt8]?]
    let msTotal: Double
    /// Non-nil when occlusion did not happen. The lab's rule is that a missing
    /// segmenter WARNS and the render continues without occlusion — nothing
    /// else fails — so this is reported, never thrown.
    let reason: String?

    static func skipped(_ why: String, keepCount: Int) -> OccluderResult {
        OccluderResult(frames: [], maskWidth: 0, maskHeight: 0,
                       personKept: [[UInt8]?](repeating: nil, count: keepCount),
                       msTotal: 0, reason: why)
    }
}

private enum TracerOccluder {

    /// Hard ceiling on stored mask frames. At ~20 KB of PNG each this is well
    /// under 30 MB; it exists so a pathological spec (a 60 s window) cannot
    /// grow the layer tree without bound.
    private static let maxFrames = 1200

    /// Segment people on EVERY frame in [fromSec, toSec] and return one
    /// inverted mask per frame.
    ///
    /// WHY EVERY FRAME, AND WHY THERE IS NO "PERSON BOX" GATE.
    /// The lab's wave-4 renderer had two separate occlusion bugs and both were
    /// in the gate, not the mask (render3 §7.1): it refreshed its person box
    /// only every 10 frames, so a golfer bending for his tee at 60 fps was
    /// masked from a stale box; and its hit test compared the trace's bounding
    /// box against the person box with a 24 px margin, so on IMG_3622 the trace
    /// (x 441–736) and the person (x 787–1080) never intersected and the
    /// occluder NEVER RAN over the driver head and shaft. Wave 5 fixed both by
    /// refreshing every near frame and widening the hit test by the club reach.
    /// Here there is no box at all: Vision's person segmentation is a
    /// whole-frame request, so the cheapest correct thing is to run it on every
    /// frame the trace can be on screen. That makes both wave-4 bugs
    /// structurally impossible rather than tuned away. The only gate is exact:
    /// frames before the trace starts have nothing to occlude.
    static func run(asset: AVAsset,
                    videoTrack: AVAssetTrack,
                    renderSize: CGSize,
                    fillTransform: CGAffineTransform,
                    frameDuration: CMTime,
                    fromSec: Double,
                    toSec: Double,
                    keepPersonAt: [Double]) -> OccluderResult {

        // The podspec declares `:ios => '14.0'` even though the app ships min
        // 15.1, and VNGeneratePersonSegmentationRequest is iOS 15+. Without
        // this guard the module does not compile at the pod's floor. On a
        // hypothetical iOS 14 device the render still happens, just without
        // occlusion — which is the lab's own rule for a missing segmenter:
        // warn, draw anyway, fail nothing.
        guard #available(iOS 15.0, *) else {
            return .skipped("person segmentation requires iOS 15", keepCount: keepPersonAt.count)
        }

        let t0 = CACurrentMediaTime()
        var personKept = [[UInt8]?](repeating: nil, count: keepPersonAt.count)
        var keptDelta = [Double](repeating: .greatestFiniteMagnitude, count: keepPersonAt.count)

        // Mask raster: long side capped at 640. Vision's `.balanced` mask is
        // itself ~504 px on its long side, so this is not throwing detail away,
        // and it keeps a whole clip's worth of masks small.
        let longSide = max(renderSize.width, renderSize.height)
        guard longSide > 0 else { return .skipped("renderSize is degenerate", keepCount: keepPersonAt.count) }
        let scale = min(1.0, CGFloat(V3Look.maskLongSide) / longSide)
        let maskW = max(2, Int((renderSize.width * scale).rounded()))
        let maskH = max(2, Int((renderSize.height * scale).rounded()))
        // The lab's grow/feather are pixels at a 1080-wide frame. Convert to
        // mask pixels and round UP to at least 1: at 360x640 the 2 px grow is
        // 0.67 mask px, and the lab's own note says over-growing is the safe
        // direction ("hide a little too much rather than paint on the golfer").
        let maskPerRefPx = CGFloat(maskW) / V3Look.refWidth
        let growR = max(1, Int((V3Look.occlusionGrowPx * maskPerRefPx).rounded(.up)))
        let featherR = max(1, Int((V3Look.occlusionFeatherPx * maskPerRefPx).rounded(.up)))

        // A plain video composition with the SAME renderSize, frameDuration and
        // fill transform as the export, so every mask is in exactly the pixel
        // space the trace is drawn in. (Reading the raw track and orienting with
        // CGImagePropertyOrientation would be wrong the moment the source and
        // render aspect ratios differ, because computeFillTransform aspect-FILLS
        // and therefore crops.)
        let readComp = AVMutableVideoComposition()
        readComp.renderSize = renderSize
        readComp.frameDuration = frameDuration
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: asset.duration)
        let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
        layerInstruction.setTransform(fillTransform, at: .zero)
        instruction.layerInstructions = [layerInstruction]
        readComp.instructions = [instruction]

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            return .skipped("AVAssetReader failed: \(error.localizedDescription)", keepCount: keepPersonAt.count)
        }
        let output = AVAssetReaderVideoCompositionOutput(
            videoTracks: [videoTrack],
            videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.videoComposition = readComp
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            return .skipped("reader cannot add the video-composition output", keepCount: keepPersonAt.count)
        }
        reader.add(output)

        let start = CMTime(seconds: max(0, fromSec), preferredTimescale: 600)
        let end = CMTime(seconds: max(fromSec, toSec), preferredTimescale: 600)
        reader.timeRange = CMTimeRange(start: start, end: end)
        guard reader.startReading() else {
            return .skipped("reader.startReading failed: \(reader.error?.localizedDescription ?? "unknown")",
                            keepCount: keepPersonAt.count)
        }

        // ONE request, reused across frames — Apple's own guidance for video,
        // and it keeps the model resident. `.balanced` is the lab's choice: it
        // is on-device, free and Apple's, unlike the lab's own yolov8n-seg.
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8

        var frames: [OccluderFrame] = []
        var failures = 0
        var capped = false

        while reader.status == .reading, let sample = output.copyNextSampleBuffer() {
            let stop: Bool = autoreleasepool { () -> Bool in
                defer { CMSampleBufferInvalidate(sample) }
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return false }
                let tSec = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
                guard tSec.isFinite else { return false }

                let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
                do {
                    try handler.perform([request])
                } catch {
                    failures += 1
                    return false
                }
                guard let observation = request.results?.first as? VNPixelBufferObservation else {
                    // No person in the frame is a perfectly normal result. An
                    // all-visible mask keeps the keyframe timeline dense and
                    // uniform, which matters because CA holds the previous
                    // discrete value until the next key.
                    if let image = makeMaskImage(person: [UInt8](repeating: 0, count: maskW * maskH),
                                                 width: maskW, height: maskH) {
                        frames.append(OccluderFrame(timeSec: tSec, image: image))
                    }
                    return false
                }

                var person = resample(observation.pixelBuffer, toWidth: maskW, height: maskH)
                if person.isEmpty { failures += 1; return false }
                dilateMax(&person, width: maskW, height: maskH, radius: growR)
                boxBlur(&person, width: maskW, height: maskH, radius: featherR)

                for (k, want) in keepPersonAt.enumerated() {
                    let d = abs(want - tSec)
                    if d < keptDelta[k] {
                        keptDelta[k] = d
                        personKept[k] = person
                    }
                }

                if let image = makeMaskImage(person: person, width: maskW, height: maskH) {
                    frames.append(OccluderFrame(timeSec: tSec, image: image))
                } else {
                    failures += 1
                }
                if frames.count >= maxFrames { capped = true; return true }
                return false
            }
            if stop { break }
        }
        reader.cancelReading()

        let ms = (CACurrentMediaTime() - t0) * 1000.0
        if frames.isEmpty {
            return OccluderResult(frames: [], maskWidth: maskW, maskHeight: maskH,
                                  personKept: personKept, msTotal: ms,
                                  reason: "no mask frames produced (\(failures) failures)")
        }
        return OccluderResult(frames: frames, maskWidth: maskW, maskHeight: maskH,
                              personKept: personKept, msTotal: ms,
                              reason: capped ? "mask frames capped at \(maxFrames)" : nil)
    }

    // MARK: mask pixel work

    /// Bilinear-resample Vision's OneComponent8 mask onto the mask raster.
    /// `.balanced` returns a fixed-size mask that maps onto the WHOLE input
    /// rectangle, so this is a plain stretch, not a letterbox.
    private static func resample(_ buffer: CVPixelBuffer, toWidth dstW: Int, height dstH: Int) -> [UInt8] {
        guard CVPixelBufferGetPlaneCount(buffer) <= 1 else { return [] }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let srcW = CVPixelBufferGetWidth(buffer)
        let srcH = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard srcW > 0, srcH > 0, let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
        let src = base.assumingMemoryBound(to: UInt8.self)

        var out = [UInt8](repeating: 0, count: dstW * dstH)
        let sx = Double(srcW) / Double(dstW)
        let sy = Double(srcH) / Double(dstH)
        out.withUnsafeMutableBufferPointer { dst in
            for y in 0..<dstH {
                let fy = min(max((Double(y) + 0.5) * sy - 0.5, 0), Double(srcH - 1))
                let y0 = Int(fy), y1 = min(y0 + 1, srcH - 1)
                let wy = fy - Double(y0)
                let r0 = src + y0 * rowBytes
                let r1 = src + y1 * rowBytes
                for x in 0..<dstW {
                    let fx = min(max((Double(x) + 0.5) * sx - 0.5, 0), Double(srcW - 1))
                    let x0 = Int(fx), x1 = min(x0 + 1, srcW - 1)
                    let wx = fx - Double(x0)
                    let a = Double(r0[x0]) * (1 - wx) + Double(r0[x1]) * wx
                    let b = Double(r1[x0]) * (1 - wx) + Double(r1[x1]) * wx
                    dst[y * dstW + x] = UInt8(min(max(a * (1 - wy) + b * wy, 0), 255).rounded())
                }
            }
        }
        return out
    }

    /// Separable max filter — the lab's `occlusion_grow_px` dilation.
    fileprivate static func dilateMax(_ buf: inout [UInt8], width: Int, height: Int, radius: Int) {
        guard radius > 0 else { return }
        var tmp = [UInt8](repeating: 0, count: buf.count)
        buf.withUnsafeBufferPointer { src in
            tmp.withUnsafeMutableBufferPointer { dst in
                for y in 0..<height {
                    let row = y * width
                    for x in 0..<width {
                        var m: UInt8 = 0
                        for k in max(0, x - radius)...min(width - 1, x + radius) {
                            m = max(m, src[row + k])
                        }
                        dst[row + x] = m
                    }
                }
            }
        }
        tmp.withUnsafeBufferPointer { src in
            buf.withUnsafeMutableBufferPointer { dst in
                for y in 0..<height {
                    for x in 0..<width {
                        var m: UInt8 = 0
                        for k in max(0, y - radius)...min(height - 1, y + radius) {
                            m = max(m, src[k * width + x])
                        }
                        dst[y * width + x] = m
                    }
                }
            }
        }
    }

    /// Two separable box passes ≈ a Gaussian of the same radius — the lab's
    /// `occlusion_feather_px`. A real Gaussian is not worth the code here: the
    /// mask is upscaled ~3× by Core Animation on the way to the frame, which
    /// adds its own bilinear ramp on top.
    private static func boxBlur(_ buf: inout [UInt8], width: Int, height: Int, radius: Int) {
        guard radius > 0 else { return }
        for _ in 0..<2 {
            var tmp = [UInt8](repeating: 0, count: buf.count)
            buf.withUnsafeBufferPointer { src in
                tmp.withUnsafeMutableBufferPointer { dst in
                    for y in 0..<height {
                        let row = y * width
                        for x in 0..<width {
                            var sum = 0, n = 0
                            for k in max(0, x - radius)...min(width - 1, x + radius) {
                                sum += Int(src[row + k]); n += 1
                            }
                            dst[row + x] = UInt8(sum / max(n, 1))
                        }
                    }
                }
            }
            tmp.withUnsafeBufferPointer { src in
                buf.withUnsafeMutableBufferPointer { dst in
                    for y in 0..<height {
                        for x in 0..<width {
                            var sum = 0, n = 0
                            for k in max(0, y - radius)...min(height - 1, y + radius) {
                                sum += Int(src[k * width + x]); n += 1
                            }
                            dst[y * width + x] = UInt8(sum / max(n, 1))
                        }
                    }
                }
            }
        }
    }

    /// A 2x2 fully-opaque mask — "nothing is occluded". It is the mask layer's
    /// model value and the first discrete keyframe, so a frame that falls
    /// outside the mask timeline shows the WHOLE trace rather than none of it.
    /// A nil `contents` on a mask layer means alpha 0 everywhere, i.e. an
    /// invisible tracer, which is the one failure this must never have.
    fileprivate static func opaqueMaskImage() -> CGImage? {
        makeMaskImage(person: [UInt8](repeating: 0, count: 4), width: 2, height: 2)
    }

    /// Build the INVERTED mask image (person -> alpha 0) that Core Animation
    /// will use as a layer mask.
    ///
    /// Two things are deliberate here. (1) The pixel format is 32-bit
    /// premultiplied-last RGBA with RGB = A (white, premultiplied), not an
    /// 8-bit alpha-only bitmap: alpha-only requires a null colour space, which
    /// CoreGraphics' Swift initialisers do not expose, and a grey image with no
    /// alpha channel masks nothing at all. (2) The image is round-tripped
    /// through PNG and re-opened with `kCGImageSourceShouldCache: false` so the
    /// keyframe array holds compressed silhouettes (tens of KB each) that decode
    /// on demand, instead of a full raster per frame — a few hundred frames of
    /// raw mask would be well over 100 MB held for the whole export. If the
    /// round-trip fails for any reason the raw image is returned: correctness
    /// over memory.
    private static func makeMaskImage(person: [UInt8], width: Int, height: Int) -> CGImage? {
        guard person.count == width * height else { return nil }
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        rgba.withUnsafeMutableBufferPointer { dst in
            person.withUnsafeBufferPointer { src in
                for i in 0..<(width * height) {
                    let a = 255 &- src[i]   // invert: person -> transparent
                    let o = i * 4
                    dst[o] = a; dst[o + 1] = a; dst[o + 2] = a; dst[o + 3] = a
                }
            }
        }
        guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
        guard let raw = CGImage(width: width, height: height,
                                bitsPerComponent: 8, bitsPerPixel: 32,
                                bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                provider: provider, decode: nil,
                                shouldInterpolate: true, intent: .defaultIntent) else { return nil }

        let png = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil) else {
            return raw
        }
        CGImageDestinationAddImage(dest, raw, nil)
        guard CGImageDestinationFinalize(dest) else { return raw }
        let opts = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(png as CFData, opts),
              let lazyImage = CGImageSourceCreateImageAtIndex(source, 0, opts) else {
            return raw
        }
        return lazyImage
    }
}

// ============================================================================
// MARK: - Pill geometry and placement
// ============================================================================

private struct TracerPill {
    let layer: CALayer
    let size: CGSize
}

private struct PillPlacement {
    let center: CGPoint
    /// Fraction of the pill rectangle covered by "must stay clear" pixels — the
    /// dilated trace plus the dilated person mask. The lab reports 0.00 on all
    /// 19 renders (render3 §6); this is the same number, computed the same way,
    /// so a device log can be compared against it directly.
    let overlapFrac: Double
}

private enum TracerLabel {

    /// Build the pill: black rounded card, bold white headline, optional
    /// smaller second line. Geometry follows `lib/render.py:_make_pill`
    /// (pad 26/14, gap 6, radius min(H/2, 22), background alpha 0.6, second
    /// line at 92% white).
    ///
    /// The two text layers are stacked with the headline at the HIGHER y. That
    /// follows from the two device-verified facts this repo already has about
    /// the animation tool: the parent layer's +y is up (the v1 pill sits above
    /// the apex with `apexPx.y + pillH * 1.2`), and CATextLayer glyphs render
    /// upright with no transform. A sublayer inherits its parent's geometry, so
    /// +y is up inside the pill too. Inferred, not measured — if a device shows
    /// the lines swapped, swap the two `position` lines below and nothing else.
    static func makePill(text: String, subText: String?, widthScale: CGFloat) -> TracerPill {
        let fontSize = V3Look.labelFontPx * widthScale
        let subSize = V3Look.labelSubPx * widthScale
        let font = UIFont.systemFont(ofSize: fontSize, weight: .bold)
        let subFont = UIFont.systemFont(ofSize: subSize, weight: .regular)

        let textSize = (text as NSString).size(withAttributes: [.font: font])
        let subTextSize: CGSize = subText.map { ($0 as NSString).size(withAttributes: [.font: subFont]) } ?? .zero

        let padH = V3Look.labelPadHPx * widthScale
        let padV = V3Look.labelPadVPx * widthScale
        let gap = V3Look.labelGapPx * widthScale
        let pillW = max(textSize.width, subTextSize.width) + padH * 2
        let pillH = textSize.height + (subText != nil ? subTextSize.height + gap : 0) + padV * 2

        let pill = CALayer()
        pill.bounds = CGRect(x: 0, y: 0, width: pillW, height: pillH)
        pill.backgroundColor = UIColor.black.withAlphaComponent(V3Look.labelAlpha).cgColor
        pill.cornerRadius = min(pillH / 2.0, V3Look.labelRadiusPx * widthScale)
        pill.masksToBounds = true

        // A bare CATextLayer cannot vertically centre its glyphs, so each line
        // gets its own exactly-text-sized layer (the v1 renderer's pattern).
        let headline = CATextLayer()
        headline.string = text
        headline.font = font
        headline.fontSize = fontSize
        headline.alignmentMode = .center
        headline.foregroundColor = UIColor.white.cgColor
        headline.contentsScale = 2.0
        headline.bounds = CGRect(x: 0, y: 0, width: textSize.width + 4, height: textSize.height + 2)
        headline.position = CGPoint(
            x: pillW / 2,
            y: subText != nil ? pillH - padV - textSize.height / 2 : pillH / 2)
        pill.addSublayer(headline)

        if let subText = subText {
            let sub = CATextLayer()
            sub.string = subText
            sub.font = subFont
            sub.fontSize = subSize
            sub.alignmentMode = .center
            sub.foregroundColor = UIColor.white.withAlphaComponent(235.0 / 255.0).cgColor
            sub.contentsScale = 2.0
            sub.bounds = CGRect(x: 0, y: 0, width: subTextSize.width + 4, height: subTextSize.height + 2)
            sub.position = CGPoint(x: pillW / 2, y: padV + subTextSize.height / 2)
            pill.addSublayer(sub)
        }
        return TracerPill(layer: pill, size: CGSize(width: pillW, height: pillH))
    }

    /// Choose where the pill sits. Port of `lib/render.py:_pill_position` +
    /// `_avoid_mask` + `_pill_anchor`, in this file's bottom-left-origin space.
    ///
    /// The pill must overlap NEITHER the trace NOR a person: the lab found that
    /// a pill placed only "above the apex" landed on the arc or on the golfer,
    /// and its cost map got overlap to 0.00 on all 19 renders. People are
    /// sampled at BOTH the frame the pill appears on and the last frame,
    /// because the golfer moves in between (render3 §6).
    static func place(track: ResolvedTrack,
                      pillSize: CGSize,
                      renderSize: CGSize,
                      widthScale: CGFloat,
                      glowWidthPx: CGFloat,
                      personMasks: [[UInt8]?],
                      maskWidth: Int,
                      maskHeight: Int) -> PillPlacement {

        // ---- the cost grid (the lab uses 1/8 resolution) --------------------
        let longSide = max(renderSize.width, renderSize.height)
        let gridScale = min(1.0, 240.0 / longSide)
        let gw = max(8, Int((renderSize.width * gridScale).rounded()))
        let gh = max(8, Int((renderSize.height * gridScale).rounded()))
        // Grid rows count from the BOTTOM, so grid coordinates are just render
        // coordinates divided by 1/gridScale — no flip anywhere in this file.
        let toGrid = { (p: CGPoint) -> CGPoint in
            CGPoint(x: p.x * CGFloat(gw) / renderSize.width,
                    y: p.y * CGFloat(gh) / renderSize.height)
        }
        var avoid = [UInt8](repeating: 0, count: gw * gh)

        func stamp(_ cx: Double, _ cy: Double, _ r: Double) {
            let x0 = max(0, Int(cx - r)), x1 = min(gw - 1, Int(cx + r))
            let y0 = max(0, Int(cy - r)), y1 = min(gh - 1, Int(cy + r))
            guard x0 <= x1, y0 <= y1 else { return }
            let r2 = r * r
            for y in y0...y1 {
                for x in x0...x1 {
                    let dx = Double(x) + 0.5 - cx, dy = Double(y) + 0.5 - cy
                    if dx * dx + dy * dy <= r2 { avoid[y * gw + x] = 255 }
                }
            }
        }

        // The whole arc, dilated by 2 x the glow width, plus the landing burst
        // region at 4 x the comet radius (`_avoid_mask`). Segments are walked at
        // one grid pixel so a fast ball's 40-px sample gap does not leave holes.
        let traceR = Double(V3Look.pillAvoidTraceWidthMul * glowWidthPx * widthScale * gridScale) / 2.0
        var prev = toGrid(track.pts[0])
        stamp(Double(prev.x), Double(prev.y), max(traceR, 1))
        for i in 1..<track.pts.count {
            let cur = toGrid(track.pts[i])
            let dx = Double(cur.x - prev.x), dy = Double(cur.y - prev.y)
            let steps = max(1, Int((dx * dx + dy * dy).squareRoot().rounded(.up)))
            for k in 1...steps {
                let f = Double(k) / Double(steps)
                stamp(Double(prev.x) + dx * f, Double(prev.y) + dy * f, max(traceR, 1))
            }
            prev = cur
        }
        let landing = toGrid(track.landingPoint)
        stamp(Double(landing.x), Double(landing.y),
              Double(V3Look.pillAvoidCometRadiusMul * V3Look.cometRadiusPx * widthScale * gridScale))

        // People, from the masks kept at the apex frame and the end frame. The
        // mask rasters have row 0 at the TOP; the grid has row 0 at the bottom.
        if maskWidth > 0 && maskHeight > 0 {
            var people = [UInt8](repeating: 0, count: gw * gh)
            for buf in personMasks.compactMap({ $0 }) where buf.count == maskWidth * maskHeight {
                for gy in 0..<gh {
                    let topFrac = 1.0 - (Double(gy) + 0.5) / Double(gh)
                    let my = min(maskHeight - 1, max(0, Int(topFrac * Double(maskHeight))))
                    for gx in 0..<gw {
                        let mx = min(maskWidth - 1, max(0, Int((Double(gx) + 0.5) / Double(gw) * Double(maskWidth))))
                        if buf[my * maskWidth + mx] > 127 { people[gy * gw + gx] = 255 }
                    }
                }
            }
            let dilate = max(1, Int((V3Look.pillAvoidPersonDilatePx * widthScale * gridScale).rounded()))
            TracerOccluder.dilateMax(&people, width: gw, height: gh, radius: dilate)
            for i in 0..<avoid.count where people[i] > 0 { avoid[i] = 255 }
        }

        // ---- the anchor the cost map is pulled towards (`_pill_anchor`) -----
        // The anchor is the highest node that is actually ON SCREEN, not the
        // arc's global apex: `Track.apex_pixel` does the same, and it matters on
        // the clips whose apex is above the frame (IMG_5391 in the lab set).
        // Whole arc off-frame -> near the top centre (the lab's 0.15 x height in
        // top-left space).
        var anchorIdx: Int? = nil
        for i in track.pts.indices {
            let p = track.pts[i]
            guard p.x >= 0, p.x <= renderSize.width, p.y >= 0, p.y <= renderSize.height else { continue }
            if let best = anchorIdx {
                if p.y > track.pts[best].y { anchorIdx = i }
            } else {
                anchorIdx = i
            }
        }
        let anchor = anchorIdx.map { track.pts[$0] }
            ?? CGPoint(x: renderSize.width / 2, y: 0.85 * renderSize.height)
        let side: CGFloat = anchor.x < renderSize.width / 2 ? 1.0 : -1.0
        let anchorCx = anchor.x + side * (pillSize.width / 2 + V3Look.labelAnchorOffsetPx * widthScale)
        let anchorCy = min(anchor.y + pillSize.height * 0.6,
                           0.92 * renderSize.height - pillSize.height / 2)

        // ---- summed-area table, then the lab's cost ------------------------
        var integral = [Int32](repeating: 0, count: (gw + 1) * (gh + 1))
        for y in 0..<gh {
            var rowSum: Int32 = 0
            for x in 0..<gw {
                rowSum += avoid[y * gw + x] > 5 ? 1 : 0
                integral[(y + 1) * (gw + 1) + (x + 1)] = integral[y * (gw + 1) + (x + 1)] + rowSum
            }
        }
        let pwG = max(1, Int((pillSize.width * gridScale).rounded(.up)))
        let phG = max(1, Int((pillSize.height * gridScale).rounded(.up)))
        let marginG = Int((V3Look.labelMarginPx * widthScale * gridScale).rounded(.up))
        let area = Double(pwG * phG)
        let diag = Double(hypot(renderSize.width, renderSize.height))

        var bestCost = Double.greatestFiniteMagnitude
        var bestCenter = CGPoint(
            x: min(max(anchorCx, pillSize.width / 2 + V3Look.labelMarginPx * widthScale),
                   renderSize.width - pillSize.width / 2 - V3Look.labelMarginPx * widthScale),
            y: min(max(anchorCy, pillSize.height / 2 + V3Look.labelMarginPx * widthScale),
                   renderSize.height - pillSize.height / 2 - V3Look.labelMarginPx * widthScale))
        var bestOverlap = 1.0

        let xHi = gw - pwG - marginG
        let yHi = gh - phG - marginG
        if xHi >= marginG && yHi >= marginG {
            for gy in stride(from: marginG, through: yHi, by: 1) {
                for gx in stride(from: marginG, through: xHi, by: 1) {
                    let a = integral[(gy + phG) * (gw + 1) + (gx + pwG)]
                    let b = integral[gy * (gw + 1) + (gx + pwG)]
                    let c = integral[(gy + phG) * (gw + 1) + gx]
                    let d = integral[gy * (gw + 1) + gx]
                    let overlap = Double(a - b - c + d) / area
                    let ccx = (Double(gx) + Double(pwG) / 2) / gridScale
                    let ccy = (Double(gy) + Double(phG) / 2) / gridScale
                    let dist = hypot(ccx - Double(anchorCx), ccy - Double(anchorCy)) / diag
                    // 10 x overlap + 1 x distance-to-anchor + 0.3 x "prefer the
                    // upper part of the frame". The lab's third term is
                    // 0.3 * (y / height) in TOP-LEFT space; here y counts up,
                    // so it is inverted.
                    let cost = 10.0 * overlap + dist + 0.3 * (1.0 - ccy / Double(renderSize.height))
                    if cost < bestCost {
                        bestCost = cost
                        bestOverlap = overlap
                        bestCenter = CGPoint(x: ccx, y: ccy)
                    }
                }
            }
        }
        return PillPlacement(center: bestCenter, overlapFrac: bestOverlap)
    }
}

// ============================================================================
// MARK: - Overlay construction (the V3 render delta)
// ============================================================================

private struct OverlayResult {
    let bandCount: Int
    let keyframeCount: Int
    let maskFrames: Int
    let pill: PillPlacement?
    let pillShowSec: Double
}

private enum TracerOverlay {

    /// Builds the whole tracer overlay into `parentLayer`.
    ///
    /// Layer tree, and the order matters:
    ///
    ///     parentLayer
    ///      +- videoLayer                (filled by the animation tool)
    ///      +- traceContainer            [mask = per-frame person mask]
    ///      |    +- glow band 0..N-1     far -> near
    ///      |    +- mid  band 0..N-1     far -> near
    ///      |    +- core band 0..N-1     far -> near
    ///      |    +- comet head
    ///      +- pill                      NEVER masked
    ///
    /// The mask sits on the container, so it multiplies into every trace layer
    /// — strokes, comet and its halo — and the pill, which is outside the
    /// container, is never occluded. That is exactly the lab's rule (render2
    /// §1: "the mask ... multiplies every trace layer; the pill is never
    /// occluded").
    static func build(track: ResolvedTrack,
                      spec: TracerRenderV3Spec,
                      renderSize: CGSize,
                      beginTime: CFTimeInterval,
                      composedDurationSec: Double,
                      occluder: OccluderResult?,
                      into parentLayer: CALayer) -> OverlayResult {

        let widthScale = renderSize.width / V3Look.refWidth
        let baseColor = tracerV3Color(spec.color, alpha: 1.0)

        let traceContainer = CALayer()
        traceContainer.frame = CGRect(origin: .zero, size: renderSize)
        parentLayer.addSublayer(traceContainer)

        // ---- ONE polyline path through every sample ------------------------
        // Geometry is never decimated; only the pacing keyframes are (above
        // V3Look.maxKeyframes), so the drawn curve is the fit's curve.
        let path = UIBezierPath()
        path.move(to: track.pts[0])
        for i in 1..<track.pts.count { path.addLine(to: track.pts[i]) }
        let cgPath = path.cgPath

        // ---- draw-on pacing -------------------------------------------------
        // values = cumulative ARC-LENGTH fractions, keyTimes = tSec / duration,
        // calculationMode .linear. This is what puts the tip on the ball at
        // every frame instead of on a uniform fraction of the path — ported
        // from `buildTracerV2Overlay` on origin/tracer-v2, which is in turn the
        // render report's "Draw-on timing" recipe.
        let keyIdx = track.keyframeIndices()
        let fractions: [CGFloat] = keyIdx.map { track.cumFraction[$0] }
        var keyTimes: [NSNumber] = keyIdx.map { NSNumber(value: track.times[$0] / track.durationSec) }
        // CA requires keyTimes[0] == 0 and keyTimes.last == 1 or the animation
        // glitches; the spec validation already put them within 1e-6, so this
        // only pins away float noise.
        keyTimes[0] = 0.0
        keyTimes[keyTimes.count - 1] = 1.0

        // ---- depth bands ----------------------------------------------------
        // Without depths there is nothing to taper or fade by, so the trace is
        // one flat band — the honest fallback, and the same one
        // `track_from_pixels` takes when it has no radii.
        let hasDepth = (track.depths?.count == track.pts.count)
        let bandCount = hasDepth ? V3Look.depthBands : 1

        func sampleIndex(atFraction f: CGFloat) -> Int {
            var lo = 0, hi = track.cumFraction.count - 1
            while lo < hi {
                let mid = (lo + hi) / 2
                if track.cumFraction[mid] < f { lo = mid + 1 } else { hi = mid }
            }
            return lo
        }

        struct Band {
            let lo: CGFloat
            let hi: CGFloat
            let taper: Double
            let fade: Double
            let depth: Double
        }
        var bands: [Band] = []
        for b in 0..<bandCount {
            let lo = CGFloat(b) / CGFloat(bandCount)
            let hi = CGFloat(b + 1) / CGFloat(bandCount)
            let mid = sampleIndex(atFraction: (lo + hi) / 2)
            bands.append(Band(lo: lo, hi: hi,
                              taper: track.taperScale(at: mid, taperMin: spec.taperMin),
                              fade: track.depthFade(at: mid, depthFadeMin: spec.depthFadeMin),
                              depth: track.depths?[mid] ?? 0))
        }
        // Far segments are drawn UNDER near ones, so where the descending leg
        // crosses the ascending one the near leg sits on top (render2 §2 proved
        // this by pixel-identity against a near-leg-only render). Depth order,
        // not time order — a shot coming back toward the camera still works.
        let order = bands.indices.sorted { bands[$0].depth > bands[$1].depth }

        func bandLayer(_ band: Band, width: CGFloat, color: UIColor) -> CAShapeLayer {
            let layer = CAShapeLayer()
            layer.path = cgPath
            layer.strokeColor = color.cgColor
            layer.fillColor = nil
            // Width taper: clip((d0/d)^0.7, taper_min, 1) at the band's own
            // depth. A CAShapeLayer has exactly one lineWidth, which is why the
            // taper is stepped rather than continuous.
            layer.lineWidth = max(0.5, width * widthScale * CGFloat(band.taper))
            layer.lineCap = .round
            layer.lineJoin = .round
            // Depth fade: a log ramp to depth_fade_min at 20x the launch depth.
            layer.opacity = Float(band.fade)
            layer.strokeStart = band.lo   // static: this band's slice of the path
            layer.strokeEnd = band.lo     // hidden until the draw reaches it
            let draw = CAKeyframeAnimation(keyPath: "strokeEnd")
            // The shared global fractions CLAMPED into this band, so the taper
            // still draws on continuously and in lockstep with real timing.
            draw.values = fractions.map { NSNumber(value: Double(min(max($0, band.lo), band.hi))) }
            draw.keyTimes = keyTimes
            draw.calculationMode = .linear
            draw.beginTime = beginTime
            draw.duration = track.durationSec
            draw.fillMode = .forwards
            draw.isRemovedOnCompletion = false
            layer.add(draw, forKey: "tracerDrawV3")
            return layer
        }

        // Global stroke order is glow -> mid -> core (the lab composites the
        // three stroke masks in that order); within each stroke, bands run far
        // -> near.
        for i in order {
            traceContainer.addSublayer(bandLayer(bands[i], width: spec.glowWidthPx,
                                                 color: tracerV3Color(spec.color, alpha: V3Look.glowAlpha)))
        }
        for i in order {
            traceContainer.addSublayer(bandLayer(bands[i], width: spec.midWidthPx,
                                                 color: tracerV3Color(spec.color, alpha: V3Look.midAlpha)))
        }
        for i in order {
            let core = bandLayer(bands[i], width: spec.lineWidthPx,
                                 color: tracerV3Color(spec.coreColor, alpha: V3Look.coreAlpha))
            // Layer shadows DO rasterize through the animation tool; CIFilter
            // blur does NOT (in-repo landmine). This is the stand-in for the
            // lab's Gaussian glow.
            core.shadowColor = baseColor.cgColor
            core.shadowRadius = V3Look.coreShadowRadiusPx * widthScale
            core.shadowOpacity = V3Look.coreShadowOpacity
            core.shadowOffset = .zero
            traceContainer.addSublayer(core)
        }

        // ---- comet head ------------------------------------------------------
        // Position keyframes with EXPLICIT values over the same samples and
        // keyTimes — never `.paced`, which moves at constant arc speed and
        // drifts off the ball (render report, "Comet").
        if spec.cometHead {
            let diameter = 2 * V3Look.cometRadiusPx * widthScale
            let dot = CALayer()
            dot.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
            dot.cornerRadius = diameter / 2.0
            dot.backgroundColor = tracerV3Color(spec.coreColor, alpha: 1.0).cgColor
            dot.shadowColor = baseColor.cgColor
            dot.shadowRadius = V3Look.cometGlowSigmaPx * widthScale
            dot.shadowOpacity = V3Look.cometGlowAlpha
            dot.shadowOffset = .zero
            dot.position = track.pts[0]
            dot.opacity = 0   // hidden before launch; the opacity keyframes below own it

            // The comet's timeline runs past the draw: it holds and FLARES on
            // the landing for land_hold_s, then fades over comet_fade_s
            // (`lib/render.py:_comet_state`). That hold is what makes a landing
            // read as a landing rather than as the trace simply stopping.
            let hold = max(0.0, spec.landHoldSec)
            let total = track.durationSec + hold + V3Look.cometFadeSec

            var moveValues: [NSValue] = keyIdx.map { NSValue(cgPoint: track.pts[$0]) }
            var scaleValues: [NSNumber] = keyIdx.map {
                NSNumber(value: max(track.taperScale(at: $0, taperMin: spec.taperMin), V3Look.cometMinScale))
            }
            var cometKeyTimes: [NSNumber] = keyIdx.map { NSNumber(value: track.times[$0] / total) }
            cometKeyTimes[0] = 0.0

            let tip = track.pts[track.pts.count - 1]
            let tipScale = max(track.taperScale(at: track.pts.count - 1, taperMin: spec.taperMin),
                               V3Look.cometMinScale)
            if hold > 0 {
                // gain = 1 + (land_burst_gain - 1) * sin(pi * f) over the hold,
                // sampled at five points — a smooth flare that returns to 1.
                for k in 1...5 {
                    let f = Double(k) / 5.0
                    let gain = 1.0 + (V3Look.landBurstGain - 1.0) * sin(Double.pi * f)
                    moveValues.append(NSValue(cgPoint: tip))
                    scaleValues.append(NSNumber(value: tipScale * gain))
                    cometKeyTimes.append(NSNumber(value: (track.durationSec + hold * f) / total))
                }
            }
            moveValues.append(NSValue(cgPoint: tip))
            scaleValues.append(NSNumber(value: tipScale))
            cometKeyTimes.append(1.0)

            let move = CAKeyframeAnimation(keyPath: "position")
            move.values = moveValues
            move.keyTimes = cometKeyTimes
            move.calculationMode = .linear
            move.beginTime = beginTime
            move.duration = total
            move.fillMode = .forwards
            move.isRemovedOnCompletion = false
            dot.add(move, forKey: "cometMoveV3")

            let scale = CAKeyframeAnimation(keyPath: "transform.scale")
            scale.values = scaleValues
            scale.keyTimes = cometKeyTimes
            scale.calculationMode = .linear
            scale.beginTime = beginTime
            scale.duration = total
            scale.fillMode = .forwards
            scale.isRemovedOnCompletion = false
            dot.add(scale, forKey: "cometScaleV3")

            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [1.0, 1.0, 0.0]
            fade.keyTimes = [0.0, NSNumber(value: (track.durationSec + hold) / total), 1.0]
            fade.beginTime = beginTime
            fade.duration = total
            fade.fillMode = .forwards
            fade.isRemovedOnCompletion = false
            dot.add(fade, forKey: "cometFadeV3")

            traceContainer.addSublayer(dot)
        }

        // ---- person occlusion -----------------------------------------------
        // One inverted alpha mask per source frame, stepped with a DISCRETE
        // keyframe animation on the mask layer's contents. A mask cannot be
        // expressed any other way in a static layer tree, which is what
        // AVVideoCompositionCoreAnimationTool composites.
        var maskFrames = 0
        if let occ = occluder, !occ.frames.isEmpty, composedDurationSec > 0 {
            let maskLayer = CALayer()
            maskLayer.frame = CGRect(origin: .zero, size: renderSize)
            maskLayer.contentsGravity = .resize
            // The model value is "everything visible": if anything ever leaves
            // the animation without a value, the trace must still be drawn, not
            // silently blanked.
            let opaque = TracerOccluder.opaqueMaskImage()
            if let opaque = opaque { maskLayer.contents = opaque }

            var values: [Any] = []
            var times: [NSNumber] = []
            if occ.frames[0].timeSec > 1e-6, let opaque = opaque {
                values.append(opaque)
                times.append(0.0)
            }
            var lastKey = -1.0
            for frame in occ.frames {
                let k = min(max(frame.timeSec / composedDurationSec, 0.0), 1.0)
                if k <= lastKey { continue }   // strictly increasing or CA glitches
                lastKey = k
                values.append(frame.image)
                times.append(NSNumber(value: k))
            }
            // Hold the LAST real frame's mask to the end. During a freeze tail
            // the held video frame is that same frame, so its mask is still the
            // right one — the lab pins the occluder to the last real frame index
            // for exactly this reason (render3 §4).
            if let last = occ.frames.last, lastKey < 1.0 - 1e-9 {
                values.append(last.image)
                times.append(1.0)
            }
            if values.count >= 2 {
                let anim = CAKeyframeAnimation(keyPath: "contents")
                anim.values = values
                anim.keyTimes = times
                anim.calculationMode = .discrete
                // The mask timeline is the CLIP's, not the trace's: it starts at
                // the first exported frame, never at a literal 0 (CoreAnimation
                // remaps a literal 0 to "now" and the animation silently never
                // renders in an export).
                anim.beginTime = AVCoreAnimationBeginTimeAtZero
                anim.duration = composedDurationSec
                anim.fillMode = .forwards
                anim.isRemovedOnCompletion = false
                maskLayer.add(anim, forKey: "occluderMaskV3")
                traceContainer.mask = maskLayer
                maskFrames = values.count
            }
        }

        // ---- label pill ------------------------------------------------------
        var placement: PillPlacement? = nil
        // `t_show = min(t_apex, t_end)` when pill_at_apex, else t_end
        // (render3 §6). Showing it at the apex is what lets a clip that ends
        // mid-flight still carry its distance.
        let showSec = spec.labelAtApex ? min(track.apexTimeSec, track.durationSec) : track.durationSec
        if let text = spec.labelText {
            let pill = TracerLabel.makePill(text: text, subText: spec.labelSubText, widthScale: widthScale)
            let place = TracerLabel.place(track: track,
                                          pillSize: pill.size,
                                          renderSize: renderSize,
                                          widthScale: widthScale,
                                          glowWidthPx: spec.glowWidthPx,
                                          personMasks: occluder?.personKept ?? [],
                                          maskWidth: occluder?.maskWidth ?? 0,
                                          maskHeight: occluder?.maskHeight ?? 0)
            pill.layer.position = place.center
            pill.layer.opacity = 0

            let labelIn = CABasicAnimation(keyPath: "opacity")
            labelIn.fromValue = 0.0
            labelIn.toValue = 1.0
            labelIn.beginTime = beginTime + showSec
            labelIn.duration = V3Look.labelFadeSec
            labelIn.fillMode = .forwards
            labelIn.isRemovedOnCompletion = false
            pill.layer.add(labelIn, forKey: "labelFadeInV3")

            // Added to the PARENT, not the trace container: the pill is never
            // occluded.
            parentLayer.addSublayer(pill.layer)
            placement = place
        }

        return OverlayResult(bandCount: bandCount,
                             keyframeCount: keyIdx.count,
                             maskFrames: maskFrames,
                             pill: placement,
                             pillShowSec: showSec)
    }
}

// ============================================================================
// MARK: - Export
// ============================================================================

/// Serial gate around the export session. Two AVAssetExportSessions with a
/// custom AVVideoComposition + Core-Animation tool in flight at once race the
/// shared encoder and intermittently fail (-11838 / partial writes); the
/// batch flags in `processAllTracers` reduce the odds but cannot structurally
/// prevent overlap.
///
/// This gate is FILE-PRIVATE on purpose: it makes concurrent *V3* renders
/// impossible, and it cannot collide with a name in ShotTracer.swift, which
/// this agent must not edit. It does NOT serialise against
/// `composeReelOnDevice`'s export — origin/tracer-v2 solved that with a
/// module-level `tracerExportSerialGate` shared by both files. If that symbol
/// ever lands, replace this one with it; the shape here is identical so the
/// change is two lines.
private let tracerV3ExportGate = DispatchSemaphore(value: 1)

enum TracerRenderV3 {

    /// Burn the V3 tracer into `videoURL` and write an MP4 to `outputURL`.
    ///
    /// - Parameters:
    ///   - videoURL: an already-resolved file URL (the caller does
    ///     `resolveFileURL`; this file has no Expo dependency).
    ///   - specJson: the V3 render spec, SHARED CONVENTION 3.
    ///   - outputURL: where to write. Any existing file there is replaced.
    /// - Returns: `["tracerUri": String, "durationMs": Double, "stats": [String: Any]]`
    /// - Throws: `TracerRenderV3Error`. Map it to Expo with
    ///   `Exception(name: err.code, description: err.message)`.
    ///
    /// Synchronous and blocking — call it off the main thread, exactly as
    /// `renderTracerOnClipImpl` does (`DispatchQueue.global(qos: .userInitiated)`).
    static func render(videoURL: URL, specJson: String, outputURL: URL) throws -> [String: Any] {
        try autoreleasepool {
            try renderImpl(videoURL: videoURL, specJson: specJson, outputURL: outputURL)
        }
    }

    // MARK: -

    /// Aspect-fill + centre, identical to `ShotDetectorModule.computeFillTransform`.
    /// Duplicated rather than called because that method lives on an
    /// ExpoModulesCore module type and this file deliberately does not import
    /// it. If one of the two ever changes, they must change together.
    private static func fillTransform(naturalSize: CGSize,
                                      preferredTransform: CGAffineTransform,
                                      renderSize: CGSize) -> CGAffineTransform {
        let transformedRect = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
        let displaySize = CGSize(width: abs(transformedRect.width), height: abs(transformedRect.height))
        guard displaySize.width > 0, displaySize.height > 0 else { return preferredTransform }
        let scale = max(renderSize.width / displaySize.width, renderSize.height / displaySize.height)
        let tx = (renderSize.width - displaySize.width * scale) / 2
        let ty = (renderSize.height - displaySize.height * scale) / 2
        return preferredTransform
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: tx, y: ty))
    }

    private static func renderImpl(videoURL: URL, specJson: String, outputURL: URL) throws -> [String: Any] {
        let startTime = CACurrentMediaTime()

        let spec = try TracerRenderV3Spec.parse(json: specJson)

        guard FileManager.default.fileExists(atPath: videoURL.path) else {
            throw TracerRenderV3Error(code: "ERR_FILE_NOT_FOUND",
                                      message: "Video file not found: \(videoURL.path)")
        }
        let asset = AVURLAsset(url: videoURL)
        guard let srcVideoTrack = asset.tracks(withMediaType: .video).first else {
            throw TracerRenderV3Error(code: "ERR_NO_VIDEO_TRACK", message: "Clip has no video track")
        }
        let srcDurationSec = CMTimeGetSeconds(asset.duration)

        // ---- Single-clip composition, full range ----------------------------
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video,
                                                           preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw TracerRenderV3Error(code: "ERR_COMPOSITION",
                                      message: "Could not create composition video track")
        }
        let fullRange = CMTimeRange(start: .zero, duration: asset.duration)
        do {
            try videoTrack.insertTimeRange(fullRange, of: srcVideoTrack, at: .zero)
        } catch {
            throw TracerRenderV3Error(code: "ERR_INSERT_VIDEO",
                                      message: "Failed inserting video: \(error.localizedDescription)")
        }
        // LANDMINE: audio track ONLY if the source has one — an empty audio
        // track plus a custom videoComposition fails export with -11838.
        // CameraView records mute by default, so most clips have no audio.
        if let srcAudioTrack = asset.tracks(withMediaType: .audio).first {
            if let audioTrack = composition.addMutableTrack(withMediaType: .audio,
                                                            preferredTrackID: kCMPersistentTrackID_Invalid) {
                try? audioTrack.insertTimeRange(fullRange, of: srcAudioTrack, at: .zero)
            }
        }

        // Portrait renderSize via preferredTransform (composeReel pattern).
        let naturalSize = srcVideoTrack.naturalSize
        let preferredTransform = srcVideoTrack.preferredTransform
        let isPortrait = abs(preferredTransform.b) == 1.0 && abs(preferredTransform.c) == 1.0
        let renderSize = isPortrait
            ? CGSize(width: naturalSize.height, height: naturalSize.width)
            : naturalSize
        guard renderSize.width > 0, renderSize.height > 0 else {
            throw TracerRenderV3Error(code: "ERR_COMPOSITION",
                                      message: "Degenerate render size \(renderSize)")
        }

        // LANDMINE: respect the SOURCE fps — a hardcoded 1/30 silently halves a
        // 60 fps source.
        let fps = srcVideoTrack.nominalFrameRate
        let timescale: Int32 = fps > 1 ? Int32(min(60.0, Double(fps).rounded())) : 30
        let frameDuration = CMTime(value: 1, timescale: timescale)

        // ---- Freeze-frame completion ----------------------------------------
        // When the fitted flight outlasts the clip, hold the LAST source frame
        // and keep drawing to the landing (render3 §4: five of nineteen lab
        // renders needed it; three of them showed no landing and no distance at
        // all without it). In AVFoundation that is "insert the last frame again
        // and stretch it": a scaled one-frame segment is a genuine freeze, and
        // it keeps the whole thing inside the composition, so the export path
        // below is unchanged. The audio simply runs out, as it does in the lab.
        var freezeHoldSec = 0.0
        var freezeApplied = false
        var freezeCapped = false
        if let need = spec.freezeCompleteToSec, need > srcDurationSec + 1e-3, srcDurationSec > 0 {
            let wanted = need - srcDurationSec
            freezeHoldSec = min(wanted, V3Look.freezeMaxSec)
            freezeCapped = wanted > V3Look.freezeMaxSec + 1e-9
            let lastStart = CMTimeMaximum(.zero, CMTimeSubtract(asset.duration, frameDuration))
            let lastDuration = CMTimeSubtract(asset.duration, lastStart)
            if CMTimeGetSeconds(lastDuration) > 0 {
                do {
                    try videoTrack.insertTimeRange(CMTimeRange(start: lastStart, duration: lastDuration),
                                                   of: srcVideoTrack, at: asset.duration)
                    videoTrack.scaleTimeRange(CMTimeRange(start: asset.duration, duration: lastDuration),
                                              toDuration: CMTime(seconds: freezeHoldSec, preferredTimescale: 600))
                    freezeApplied = true
                } catch {
                    // A freeze that cannot be built is not a reason to lose the
                    // render — the trace just ends where the clip does, which is
                    // the wave-4 behaviour.
                    print("[Clippar.TracerV3] freeze completion failed, continuing without it: \(error.localizedDescription)")
                    freezeHoldSec = 0
                    freezeCapped = false
                }
            }
        }
        let composedDurationSec = CMTimeGetSeconds(composition.duration)

        // Defense-in-depth: JS pre-checks minAnimSec; a draw starting at the
        // very end would export a clip with an invisible tracer.
        guard spec.animStartSec < composedDurationSec - 0.4 else {
            throw TracerRenderV3Error(
                code: "ERR_TRACER_ANIM_WINDOW",
                message: "animStartSec \(spec.animStartSec) too close to clip end (\(String(format: "%.2f", composedDurationSec))s)")
        }

        // ---- Geometry --------------------------------------------------------
        let track = try ResolvedTrack.build(spec: spec, renderSize: renderSize)
        let transform = fillTransform(naturalSize: naturalSize,
                                      preferredTransform: preferredTransform,
                                      renderSize: renderSize)

        // ---- Person occlusion ------------------------------------------------
        // The window runs from just before the draw begins to the END of the
        // source, not to the end of the draw: the arc persists after it is drawn
        // and the golfer keeps moving through it (render2 measured 1 496–2 371
        // trace pixels on the torso at k435+, well after the draw finished).
        var occluder: OccluderResult? = nil
        if spec.occlusion {
            occluder = TracerOccluder.run(asset: asset,
                                          videoTrack: srcVideoTrack,
                                          renderSize: renderSize,
                                          fillTransform: transform,
                                          frameDuration: frameDuration,
                                          fromSec: max(0, spec.animStartSec - 0.1),
                                          toSec: srcDurationSec,
                                          keepPersonAt: [
                                            spec.animStartSec + min(track.apexTimeSec, track.durationSec),
                                            spec.animStartSec + track.durationSec
                                          ])
            if let reason = occluder?.reason {
                print("[Clippar.TracerV3] occlusion degraded: \(reason)")
            }
        }

        // ---- Layers (fresh, NEVER attached to any view) ----------------------
        let parentLayer = CALayer()
        let videoLayer = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: renderSize)
        videoLayer.frame = CGRect(origin: .zero, size: renderSize)
        parentLayer.addSublayer(videoLayer)

        // LANDMINE: NEVER a literal beginTime 0 — CoreAnimation remaps it to
        // "now" and the animation silently never renders in an export.
        let beginTime = AVCoreAnimationBeginTimeAtZero + spec.animStartSec
        let overlay = TracerOverlay.build(track: track,
                                          spec: spec,
                                          renderSize: renderSize,
                                          beginTime: beginTime,
                                          composedDurationSec: composedDurationSec,
                                          occluder: occluder,
                                          into: parentLayer)

        // ---- Video composition ------------------------------------------------
        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = frameDuration
        videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
            postProcessingAsVideoLayer: videoLayer,
            in: parentLayer
        )
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: composition.duration)
        let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
        layerInstruction.setTransform(transform, at: .zero)
        instruction.layerInstructions = [layerInstruction]
        videoComposition.instructions = [instruction]

        // ---- Export (composeReelOnDevice pattern) -----------------------------
        guard tracerV3ExportGate.wait(timeout: .now() + 300) != .timedOut else {
            throw TracerRenderV3Error(code: "ERR_EXPORT_GATE_TIMEOUT",
                                      message: "Export gate not acquired within 300s — another export appears wedged")
        }
        defer { tracerV3ExportGate.signal() }

        try? FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: outputURL)

        // LANDMINE: size-specific preset. HighestQuality + a custom
        // AVVideoComposition on an HEVC/HDR source fails with -11838;
        // 1920x1080 forces a known-good H.264 SDR combination.
        guard let exportSession = AVAssetExportSession(asset: composition,
                                                       presetName: AVAssetExportPreset1920x1080) else {
            throw TracerRenderV3Error(code: "ERR_EXPORT_SESSION",
                                      message: "Could not create export session for tracer")
        }
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mp4
        exportSession.videoComposition = videoComposition
        exportSession.shouldOptimizeForNetworkUse = true

        // LANDMINE: UIBackgroundTask so backgrounding mid-render doesn't kill
        // the export with -11847; cancelExport in the expiration handler so a
        // partial file surfaces as an error, not a silent success.
        // beginBackgroundTask must run on the main thread — and this function is
        // synchronous, so `.main.sync` from the main thread would deadlock.
        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
        let beginBackground = {
            bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ClipparTracerRenderV3") {
                print("[Clippar.TracerV3] background task expiring — cancelling export")
                exportSession.cancelExport()
            }
        }
        if Thread.isMainThread { beginBackground() } else { DispatchQueue.main.sync(execute: beginBackground) }
        defer {
            if bgTaskId != .invalid {
                let id = bgTaskId
                DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(id) }
            }
        }

        let semaphore = DispatchSemaphore(value: 0)
        var exportError: Error?
        exportSession.exportAsynchronously {
            // .cancelled (background-task expiry) is an error too — JS must not
            // record a half-written tracer file as 'done'.
            if exportSession.status == .failed || exportSession.status == .cancelled {
                exportError = exportSession.error ?? NSError(
                    domain: "ClipparExport", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Tracer export was cancelled (likely backgrounded too long)"])
            }
            semaphore.signal()
        }
        semaphore.wait()

        if let error = exportError {
            let nsErr = error as NSError
            print("[Clippar.TracerV3] FAIL render status=\(exportSession.status.rawValue) error=\(error.localizedDescription) code=\(nsErr.code) domain=\(nsErr.domain)")
            try? FileManager.default.removeItem(at: outputURL)
            throw TracerRenderV3Error(
                code: "ERR_TRACER_RENDER_FAILED",
                message: "Tracer render failed: \(error.localizedDescription) (code \(nsErr.code))")
        }

        let elapsed = CACurrentMediaTime() - startTime
        print("[Clippar.TracerV3] OK render samples=\(track.pts.count) bands=\(overlay.bandCount)" +
              " animStart=\(String(format: "%.2f", spec.animStartSec))" +
              " animDur=\(String(format: "%.2f", track.durationSec))" +
              " freeze=\(String(format: "%.2f", freezeHoldSec))" +
              " maskFrames=\(overlay.maskFrames)" +
              " durationSec=\(String(format: "%.1f", composedDurationSec))" +
              " elapsedSec=\(String(format: "%.1f", elapsed)) out=\(outputURL.lastPathComponent)")

        var occlusionStats: [String: Any] = [
            "requested": spec.occlusion,
            "applied": overlay.maskFrames > 0,
            "keyframes": overlay.maskFrames,
            "sourceFrames": occluder?.frames.count ?? 0,
            "maskWidth": occluder?.maskWidth ?? 0,
            "maskHeight": occluder?.maskHeight ?? 0,
            "msTotal": occluder?.msTotal ?? 0,
        ]
        if let reason = occluder?.reason { occlusionStats["reason"] = reason }

        var labelStats: [String: Any] = [
            "shown": spec.labelText != nil,
            "atApex": spec.labelAtApex,
            "showSec": overlay.pillShowSec,
            "clamped": spec.labelClamped,
        ]
        if let p = overlay.pill {
            labelStats["xPx"] = Double(p.center.x)
            labelStats["yPx"] = Double(p.center.y)
            labelStats["overlapFrac"] = p.overlapFrac
        }

        let stats: [String: Any] = [
            "engine": "v3",
            "renderWidth": Int(renderSize.width),
            "renderHeight": Int(renderSize.height),
            "fps": Double(timescale),
            "sampleCount": track.pts.count,
            "keyframeCount": overlay.keyframeCount,
            "bands": overlay.bandCount,
            "depthsGiven": track.depths != nil,
            "taperMin": spec.taperMin,
            "depthFadeMin": spec.depthFadeMin,
            "animStartSec": spec.animStartSec,
            // The fitted flight length vs the length actually drawn: they
            // differ exactly when endAtSec truncated the trace at a seen
            // touchdown, which is the one case worth seeing in a log.
            "fittedDurationSec": spec.animDurationSec,
            "drawDurationSec": track.durationSec,
            "endAt": [
                "applied": track.truncated,
                "sec": spec.endAtSec ?? -1,
            ] as [String: Any],
            "freeze": [
                "applied": freezeApplied,
                "holdSec": freezeHoldSec,
                "capped": freezeCapped,
            ] as [String: Any],
            "occlusion": occlusionStats,
            "label": labelStats,
            "elapsedMs": elapsed * 1000.0,
            // The one assumption a device has to settle: CALayer `contents`
            // images are assumed to composite through the animation tool with
            // row 0 at the TOP of the frame, i.e. upright, the same way
            // CATextLayer glyphs are device-verified to. If the occlusion cut
            // appears vertically mirrored, that assumption is wrong and the fix
            // is one line on the mask layer.
            "maskOrientationAssumption": "cgimage-row0-is-top",
        ]

        return [
            "tracerUri": outputURL.absoluteString,
            "durationMs": composedDurationSec * 1000.0,
            "stats": stats,
        ]
    }
}
