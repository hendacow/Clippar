import ExpoModulesCore
import Vision
import AVFoundation
import CoreMotion
import UIKit
import QuartzCore

// ============================================================================
// MARK: - GPS Shot Tracer (additive — gated end-to-end by config.tracer.enabled)
// ============================================================================
//
// Implementation for the four tracer AsyncFunctions declared at the end of
// ShotDetectorModule.definition(). Lives in its own file (the podspec globs
// **/*.swift) so the diff stays out of the detection-variants regions.
//
// Helpers reused from ShotDetectorModule.swift (flipped private -> internal,
// the ONLY edits made there besides the four one-line declarations):
//   resolveFileURL, computeFillTransform, extractPoseFramesOriented,
//   cgOrientation(for:), and the PoseFrame struct (required by the
//   extractPoseFramesOriented signature).
//
// Coordinate convention for EVERYTHING this file emits or consumes:
// normalized, display-oriented, BOTTOM-LEFT origin (Vision convention, which
// is also AVVideoCompositionCoreAnimationTool's convention — so the render
// mapping is a pure scale with NO y-flip).
//
// Critique fixes implemented here (see design JSON critiques):
//   F1  — cgOrientation(for:) is the single orientation source for BOTH the
//         trajectory request handler and the pose-seed frames.
//   F7  — ONE fresh VNDetectTrajectoriesRequest per clip, trajectoryLength
//         default 5, objectMinimumNormalizedRadius 0.001; objectMaximum-
//         NormalizedRadius 0.05 is set but NOT relied on (known iOS bug: the
//         max is not enforced) — the app-side movingAverageRadius band in
//         [0.001, 0.02] is the real filter. Full-resolution 32BGRA reader
//         (a 480x640 shrink would make the ball ~3px), PTS-stamped
//         CMSampleBuffers fed sequentially on one queue, copyNextSampleBuffer
//         inside autoreleasepool, monotonic-PTS drop guard. No VNVideoProcessor.
//   F8a — groundedEvidence: a moving object WAS observed in the launch zone
//         but never climbed (grounded/topped roll) — JS must SKIP, never
//         synthesize a flying arc over a rolling ball.
//   F9  — clubhead-decoy rejection: trajectory timeRange.start >= impact-150ms,
//         first point inside the launch ROI, net upward displacement > 0.05,
//         and a monotonic-horizontal-drift-away test over the FULL accumulated
//         point list (the clubhead swings through and back; the ball doesn't).
//   F10 — launch ROI seeded from a LOW-MOTION frame ~1.2-1.5s pre-impact
//         (address stance), ankle-midpoint based — NOT impact-800ms, which is
//         mid-backswing. poseAnchor fallback = ankles at the impact frame.
//   F18 — render: AVCoreAnimationBeginTimeAtZero + offset (never literal 0),
//         audio track only when the source has one (-11838 landmine),
//         AVAssetExportPreset1920x1080 (HighestQuality + HEVC/HDR + custom
//         composition = -11838), source-fps frameDuration, fresh layers never
//         attached to views, UIBackgroundTask around the export.

// MARK: - Options parsing (DetectionOptions typed-closure pattern)

private struct BallLaunchOptions {
    // F7: Vision's minimum trajectoryLength is 5; config may raise it.
    var trajectoryLength: Int = 5
    var minTrajectoryConfidence: Double = 0.7
    var detectWindowPreMs: Double = 300.0
    var detectWindowPostMs: Double = 1700.0
    // 'frameDiff' is RESERVED — the fallback path is a stub today (see
    // tracerFrameDiffFallbackStub). 'none' disables it explicitly.
    var fallback: String = "frameDiff"

    init(json: String) {
        guard !json.isEmpty,
              let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return
        }
        func d(_ k: String) -> Double? { (obj[k] as? NSNumber)?.doubleValue }
        func i(_ k: String) -> Int? { (obj[k] as? NSNumber)?.intValue }
        func s(_ k: String) -> String? { obj[k] as? String }

        if let v = i("trajectoryLength") { trajectoryLength = max(5, v) }
        if let v = d("minTrajectoryConfidence") { minTrajectoryConfidence = v }
        if let v = d("detectWindowPreMs") { detectWindowPreMs = v }
        if let v = d("detectWindowPostMs") { detectWindowPostMs = v }
        if let v = s("fallback") { fallback = v }
    }
}

private struct TracerRenderSpec {
    let p0: CGPoint
    let c1: CGPoint
    let a: CGPoint
    let c2: CGPoint
    let p3: CGPoint
    let animStartSec: Double
    let animDurationSec: Double
    var color: String = "#FF3B1F"
    var coreColor: String = "#FFD9A0"
    var lineWidthPx: CGFloat = 4
    var midWidthPx: CGFloat = 8
    var glowWidthPx: CGFloat = 16
    var cometHead: Bool = true

    init?(json: String) {
        guard !json.isEmpty,
              let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        func point(_ k: String) -> CGPoint? {
            guard let d = obj[k] as? [String: Any],
                  let x = (d["x"] as? NSNumber)?.doubleValue,
                  let y = (d["y"] as? NSNumber)?.doubleValue,
                  x.isFinite, y.isFinite else { return nil }
            return CGPoint(x: x, y: y)
        }
        guard let p0 = point("p0"), let c1 = point("c1"), let a = point("a"),
              let c2 = point("c2"), let p3 = point("p3"),
              let start = (obj["animStartSec"] as? NSNumber)?.doubleValue,
              let dur = (obj["animDurationSec"] as? NSNumber)?.doubleValue,
              start.isFinite, start >= 0, dur.isFinite, dur > 0 else {
            return nil
        }
        self.p0 = p0
        self.c1 = c1
        self.a = a
        self.c2 = c2
        self.p3 = p3
        self.animStartSec = start
        self.animDurationSec = dur
        if let v = obj["color"] as? String { color = v }
        if let v = obj["coreColor"] as? String { coreColor = v }
        if let v = (obj["lineWidthPx"] as? NSNumber)?.doubleValue, v > 0 { lineWidthPx = CGFloat(v) }
        if let v = (obj["midWidthPx"] as? NSNumber)?.doubleValue, v > 0 { midWidthPx = CGFloat(v) }
        if let v = (obj["glowWidthPx"] as? NSNumber)?.doubleValue, v > 0 { glowWidthPx = CGFloat(v) }
        if let v = obj["cometHead"] as? Bool { cometHead = v }
    }
}

/// Parse "#RRGGBB" into UIColor at the given alpha; falls back to the design's
/// tracer orange (#FF3B1F) on malformed input so a bad config can't crash a render.
private func tracerColor(_ hex: String, alpha: CGFloat) -> UIColor {
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

// MARK: - Pose-seed + trajectory accumulation types

/// One sampled frame from the windowed ankle scan. PoseFrame (the shared
/// detection struct) carries no ankle joints, so the tracer runs its own
/// narrow-window pose pass rather than touching the detection pipeline.
private struct TracerAnkleSample {
    let timeMs: Double
    let ankleMeanX: CGFloat?
    let ankleMinY: CGFloat?
    let wrist: CGPoint?   // avg of available wrists — stillness measure only
}

private struct TracerLaunchSeed {
    let roi: CGRect          // launch ROI, normalized bottom-left display space
    let poseAnchor: CGPoint? // (mean ankle x, min ankle y + 0.01) at impact
    let golferX: CGFloat?    // mean ankle x — drift-away reference (F9)
    let fromPose: Bool       // false = terminal frame-center fallback ROI
}

/// Per-uuid accumulator for VNTrajectoryObservation updates. The request
/// reports a SLIDING window of detectedPoints per frame for the same uuid;
/// Apple's Action & Vision sample accumulates them — duplicating instead of
/// accumulating would corrupt the F9 full-trajectory drift test.
private struct TrajectoryCandidate {
    var points: [CGPoint]
    var timesMs: [Double]
    var maxConfidence: Float
    var lastRadius: CGFloat
    var startMs: Double   // observation timeRange.start at first sighting
    var lastMs: Double
}

// MARK: - Extension

extension ShotDetectorModule {

    // ========================================================================
    // MARK: detectBallLaunch — VNDetectTrajectoriesRequest launch evidence
    // ========================================================================

    internal func detectBallLaunchImpl(videoUri: String, impactTimeMs: Double, optionsJson: String, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
            let opts = BallLaunchOptions(json: optionsJson)
            let startTime = CACurrentMediaTime()

            let fileURL = self.resolveFileURL(videoUri)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Video file not found: \(fileURL.path)"))
                return
            }
            let asset = AVURLAsset(url: fileURL)
            guard let videoTrack = asset.tracks(withMediaType: .video).first else {
                // No video track — nothing to detect. Resolve (not reject) so
                // the JS batch falls through its GPS-only ladder per clip.
                self.resolveBallLaunch(promise, found: false, method: "none",
                                       launchPoint: nil, direction: nil, points: [],
                                       groundedEvidence: false, poseAnchor: nil,
                                       confidence: 0, width: 0, height: 0)
                return
            }

            // F1: ONE orientation source of truth for the trajectory request
            // handler AND the pose-seed frames below.
            let preferredTransform = videoTrack.preferredTransform
            let orientation = self.cgOrientation(for: preferredTransform)
            let displayRect = CGRect(origin: .zero, size: videoTrack.naturalSize).applying(preferredTransform)
            let width = Double(abs(displayRect.width))
            let height = Double(abs(displayRect.height))

            // objectMin/MaxNormalizedRadius + movingAverageRadius are iOS 15+.
            // Below that there is no usable size filtering, so report "no
            // vision evidence" — JS treats it exactly like ball-not-found.
            guard #available(iOS 15.0, *) else {
                self.resolveBallLaunch(promise, found: false, method: "none",
                                       launchPoint: nil, direction: nil, points: [],
                                       groundedEvidence: false, poseAnchor: nil,
                                       confidence: 0, width: width, height: height)
                return
            }

            // ---- F10 pose seed: windowed ankle scan over [impact-1.6s, impact] ----
            let seedSamples = self.tracerAnkleSamples(
                asset: asset, videoTrack: videoTrack, orientation: orientation,
                fromMs: max(0.0, impactTimeMs - 1600.0), toMs: impactTimeMs + 120.0)
            let seed = self.tracerLaunchSeed(samples: seedSamples, impactTimeMs: impactTimeMs)

            // ---- Trajectory pass over [impact - preMs, impact + postMs] ----
            let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0
            let windowStartMs = max(0.0, impactTimeMs - opts.detectWindowPreMs)
            let windowEndMs = min(durationMs, impactTimeMs + opts.detectWindowPostMs)
            guard windowEndMs > windowStartMs + 100.0 else {
                self.resolveBallLaunch(promise, found: false, method: "none",
                                       launchPoint: nil, direction: nil, points: [],
                                       groundedEvidence: false, poseAnchor: seed.poseAnchor,
                                       confidence: 0, width: width, height: height)
                return
            }

            // F7: ONE fresh stateful request per clip, reused only across THIS
            // clip's frames (the opposite of the per-frame pose-request pattern).
            let request = VNDetectTrajectoriesRequest(
                frameAnalysisSpacing: .zero,
                trajectoryLength: max(5, opts.trajectoryLength))
            request.objectMinimumNormalizedRadius = 0.001
            // Set but NOT relied on — known iOS bug: the maximum radius is not
            // enforced. The movingAverageRadius band below is the real filter.
            request.objectMaximumNormalizedRadius = 0.05

            guard let reader = try? AVAssetReader(asset: asset) else {
                self.resolveBallLaunch(promise, found: false, method: "none",
                                       launchPoint: nil, direction: nil, points: [],
                                       groundedEvidence: false, poseAnchor: seed.poseAnchor,
                                       confidence: 0, width: width, height: height)
                return
            }
            // FULL resolution — no width/height shrink (F7). 32BGRA for Vision.
            let outputSettings: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            ]
            let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
            trackOutput.alwaysCopiesSampleData = false
            reader.add(trackOutput)
            reader.timeRange = CMTimeRange(
                start: CMTime(seconds: windowStartMs / 1000.0, preferredTimescale: 600),
                duration: CMTime(seconds: (windowEndMs - windowStartMs) / 1000.0, preferredTimescale: 600))
            guard reader.startReading() else {
                self.resolveBallLaunch(promise, found: false, method: "none",
                                       launchPoint: nil, direction: nil, points: [],
                                       groundedEvidence: false, poseAnchor: seed.poseAnchor,
                                       confidence: 0, width: width, height: height)
                return
            }

            var candidates: [UUID: TrajectoryCandidate] = [:]
            var lastPTS = CMTime.invalid
            var fedFrames = 0
            var readerDone = false
            while !readerDone {
                autoreleasepool {
                    guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else {
                        readerDone = true
                        return
                    }
                    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                    guard pts.isNumeric else { return }
                    // Monotonic-PTS drop guard (F7): the stateful request
                    // asserts on out-of-order timestamps — drop, never feed.
                    if lastPTS.isNumeric && CMTimeCompare(pts, lastPTS) <= 0 { return }
                    lastPTS = pts
                    let tMs = CMTimeGetSeconds(pts) * 1000.0
                    if tMs > windowEndMs + 50.0 {
                        readerDone = true
                        return
                    }
                    // PTS-stamped CMSampleBuffer handler is mandatory — a bare
                    // CVPixelBuffer handler silently breaks trajectory timeRanges.
                    let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: orientation, options: [:])
                    do {
                        try handler.perform([request])
                    } catch {
                        return // skip the frame; the request stays usable
                    }
                    fedFrames += 1
                    let observations: [VNTrajectoryObservation] = request.results ?? []
                    for obs in observations {
                        self.tracerAccumulate(obs, atMs: tMs, into: &candidates)
                    }
                } // autoreleasepool — sampleBuffer + handler freed per frame
            }
            reader.cancelReading()

            // ---- Candidate filter (design step 5 + F8a/F9) ----
            var groundedEvidence = false
            var winner: TrajectoryCandidate?
            var winnerScore = -1.0
            for c in candidates.values {
                guard c.points.count >= 3, c.points.count == c.timesMs.count else { continue }
                // F7 app-side radius band — the request's max radius is a no-op.
                guard c.lastRadius >= 0.001 && c.lastRadius <= 0.02 else { continue }
                guard Double(c.maxConfidence) >= opts.minTrajectoryConfidence else { continue }
                // F9: trajectory must START in [impact-150ms, impact+500ms] —
                // a pre-impact start is the clubhead/backswing, a late start is
                // a bird/cart/another group's ball.
                guard c.startMs >= impactTimeMs - 150.0 && c.startMs <= impactTimeMs + 500.0 else { continue }
                guard let first = c.points.first, let last = c.points.last else { continue }
                // F9/F10: first point must sit inside the pose-seeded launch ROI.
                guard seed.roi.contains(first) else { continue }
                let upward = last.y - first.y
                if upward <= 0.05 {
                    // F8a: a real moving object in the launch zone that never
                    // climbed — grounded/topped roll. Record the veto evidence.
                    groundedEvidence = true
                    continue
                }
                // F9: monotonic horizontal drift AWAY over the FULL point list.
                guard self.tracerDriftsAway(points: c.points, golferX: seed.golferX) else { continue }
                let score = Double(c.maxConfidence) * Double(c.points.count)
                if score > winnerScore {
                    winnerScore = score
                    winner = c
                }
            }

            let elapsed = CACurrentMediaTime() - startTime

            if let w = winner, let first = w.points.first {
                // Launch direction: unit vector across the first 3-6 points.
                let endIdx = min(5, w.points.count - 1)
                let dx = w.points[endIdx].x - first.x
                let dy = w.points[endIdx].y - first.y
                let len = (dx * dx + dy * dy).squareRoot()
                let direction: CGPoint? = len > 1e-4 ? CGPoint(x: dx / len, y: dy / len) : nil

                var pointPayload: [[String: Any]] = []
                pointPayload.reserveCapacity(min(60, w.points.count))
                for (i, p) in w.points.enumerated() {
                    if i >= 60 { break }
                    pointPayload.append(["x": Double(p.x), "y": Double(p.y), "tMs": w.timesMs[i]])
                }

                print("[Clippar.Tracer] detectBallLaunch OK method=vision points=\(w.points.count) conf=\(String(format: "%.2f", w.maxConfidence)) radius=\(String(format: "%.4f", w.lastRadius)) fedFrames=\(fedFrames) elapsedSec=\(String(format: "%.1f", elapsed))")
                self.resolveBallLaunch(promise, found: true, method: "vision",
                                       launchPoint: first, direction: direction, points: pointPayload,
                                       groundedEvidence: groundedEvidence, poseAnchor: seed.poseAnchor,
                                       confidence: Double(w.maxConfidence), width: width, height: height)
                return
            }

            // frameDiff fallback is RESERVED (config.tracer.fallback) — stub
            // today; the JS ladder handles found:false (pose anchor + GPS arc
            // or skip).
            if opts.fallback == "frameDiff" {
                _ = self.tracerFrameDiffFallbackStub()
            }

            print("[Clippar.Tracer] detectBallLaunch none — candidates=\(candidates.count) grounded=\(groundedEvidence) fedFrames=\(fedFrames) roiFromPose=\(seed.fromPose) elapsedSec=\(String(format: "%.1f", elapsed))")
            self.resolveBallLaunch(promise, found: false, method: "none",
                                   launchPoint: nil, direction: nil, points: [],
                                   groundedEvidence: groundedEvidence, poseAnchor: seed.poseAnchor,
                                   confidence: 0, width: width, height: height)
            } // autoreleasepool
        }
    }

    /// Shared resolve shape for detectBallLaunch. All coordinates normalized,
    /// display-oriented, bottom-left origin.
    private func resolveBallLaunch(
        _ promise: Promise, found: Bool, method: String,
        launchPoint: CGPoint?, direction: CGPoint?, points: [[String: Any]],
        groundedEvidence: Bool, poseAnchor: CGPoint?, confidence: Double,
        width: Double, height: Double
    ) {
        var payload: [String: Any] = [
            "found": found,
            "method": method,
            "points": points,
            "groundedEvidence": groundedEvidence,
            "confidence": confidence,
            "width": width,
            "height": height,
        ]
        if let lp = launchPoint {
            payload["launchPoint"] = ["x": Double(lp.x), "y": Double(lp.y)]
        } else {
            payload["launchPoint"] = NSNull()
        }
        if let d = direction {
            payload["direction"] = ["dx": Double(d.x), "dy": Double(d.y)]
        } else {
            payload["direction"] = NSNull()
        }
        if let pa = poseAnchor {
            payload["poseAnchor"] = ["x": Double(pa.x), "y": Double(pa.y)]
        } else {
            payload["poseAnchor"] = NSNull()
        }
        promise.resolve(payload)
    }

    /// Accumulate a sliding-window trajectory observation (Action & Vision
    /// pattern): first sighting seeds all window points with times interpolated
    /// across the observation's timeRange; later sightings append only the
    /// newest point so the F9 drift test sees the FULL trajectory.
    @available(iOS 15.0, *)
    private func tracerAccumulate(_ obs: VNTrajectoryObservation, atMs tMs: Double, into candidates: inout [UUID: TrajectoryCandidate]) {
        let detected = obs.detectedPoints.map { CGPoint(x: CGFloat($0.x), y: CGFloat($0.y)) }
        guard !detected.isEmpty else { return }
        let radius = CGFloat(obs.movingAverageRadius)

        if var c = candidates[obs.uuid] {
            if let newest = detected.last {
                let advanced: Bool
                if let prev = c.points.last {
                    advanced = abs(prev.x - newest.x) > 1e-5 || abs(prev.y - newest.y) > 1e-5
                } else {
                    advanced = true
                }
                if advanced {
                    c.points.append(newest)
                    c.timesMs.append(tMs)
                }
            }
            c.maxConfidence = max(c.maxConfidence, obs.confidence)
            c.lastRadius = radius
            c.lastMs = tMs
            candidates[obs.uuid] = c
        } else {
            var startMs = tMs
            if obs.timeRange.start.isNumeric {
                startMs = CMTimeGetSeconds(obs.timeRange.start) * 1000.0
            }
            let n = detected.count
            var times: [Double] = []
            times.reserveCapacity(n)
            for k in 0..<n {
                let f = n > 1 ? Double(k) / Double(n - 1) : 1.0
                times.append(startMs + f * (tMs - startMs))
            }
            candidates[obs.uuid] = TrajectoryCandidate(
                points: detected, timesMs: times,
                maxConfidence: obs.confidence, lastRadius: radius,
                startMs: startMs, lastMs: tMs)
        }
    }

    /// F9 clubhead-decoy test on the FULL accumulated point list. A struck ball
    /// drifts in ONE horizontal direction away from the golfer; the clubhead
    /// sweeps through the launch zone and reverses.
    private func tracerDriftsAway(points: [CGPoint], golferX: CGFloat?) -> Bool {
        guard points.count >= 3, let first = points.first, let last = points.last else { return false }
        let total = last.x - first.x
        // Near-zero lateral drift = straight down-the-line shot. Accept only
        // when x stays tight — the clubhead decoy sweeps a wide x range.
        if abs(total) < 0.02 {
            let xs = points.map { $0.x }
            guard let lo = xs.min(), let hi = xs.max() else { return false }
            return (hi - lo) < 0.04
        }
        let sign: CGFloat = total > 0 ? 1 : -1
        var significant = 0
        var agreeing = 0
        for k in 1..<points.count {
            let dx = points[k].x - points[k - 1].x
            if abs(dx) < 0.002 { continue }
            significant += 1
            if dx * sign > 0 { agreeing += 1 }
        }
        if significant > 0 && Double(agreeing) / Double(significant) < 0.8 { return false }
        // Net motion must be AWAY from the golfer, never back toward them.
        if let gx = golferX {
            let dFirst = abs(first.x - gx)
            let dLast = abs(last.x - gx)
            if dLast + 0.01 < dFirst { return false }
        }
        return true
    }

    /// RESERVED (config.tracer.fallback = 'frameDiff'): luma frame-differencing
    /// inside the launch ROI over [impact, impact + 12 frames]. Deliberately a
    /// STUB returning nil — the design allows found:false here without breaking
    /// the JS fallback ladder (pose anchor + GPS-only arc, or skip). Any future
    /// implementation MUST reuse cgOrientation(for:) as its orientation source.
    private func tracerFrameDiffFallbackStub() -> [String: Any]? {
        return nil
    }

    // ========================================================================
    // MARK: Pose seed (F10) — windowed ankle scan
    // ========================================================================

    /// Low-res pose pass restricted to [fromMs, toMs]. The shared PoseFrame
    /// struct carries no ankle joints (and extractPoseFramesOriented walks the
    /// WHOLE clip), so the tracer runs its own narrow window — same buffer-
    /// sizing math, same autoreleasepool discipline, same cgOrientation source.
    private func tracerAnkleSamples(
        asset: AVURLAsset, videoTrack: AVAssetTrack,
        orientation: CGImagePropertyOrientation,
        fromMs: Double, toMs: Double
    ) -> [TracerAnkleSample] {
        let transform = videoTrack.preferredTransform
        let natural = videoTrack.naturalSize
        let displayRect = CGRect(origin: .zero, size: natural).applying(transform)
        let displayW = abs(displayRect.width)
        let displayH = abs(displayRect.height)
        let targetLong: CGFloat = 640
        let aspect = (displayW > 0 && displayH > 0) ? (displayW / displayH) : (480.0 / 640.0)
        var bufW: Int
        var bufH: Int
        if aspect >= 1.0 {
            bufW = Int(targetLong)
            bufH = max(16, Int((targetLong / aspect).rounded()))
        } else {
            bufH = Int(targetLong)
            bufW = max(16, Int((targetLong * aspect).rounded()))
        }

        guard let reader = try? AVAssetReader(asset: asset) else { return [] }
        let outputSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: bufW,
            kCVPixelBufferHeightKey as String: bufH,
        ]
        let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
        trackOutput.alwaysCopiesSampleData = false
        reader.add(trackOutput)
        // Pad the request backward — the reader snaps to the preceding sync
        // sample; trim to [fromMs, toMs] by PTS (denseRefineImpact pattern).
        let padMs = 300.0
        let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0
        let reqStart = max(0.0, fromMs - padMs)
        let reqEnd = min(durationMs, toMs + padMs)
        guard reqEnd > reqStart else { return [] }
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: reqStart / 1000.0, preferredTimescale: 600),
            duration: CMTime(seconds: (reqEnd - reqStart) / 1000.0, preferredTimescale: 600))
        guard reader.startReading() else { return [] }

        var samples: [TracerAnkleSample] = []
        var frameIndex = 0
        var done = false
        while !done {
            autoreleasepool {
                guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else {
                    done = true
                    return
                }
                defer { frameIndex += 1 }
                // ~10fps is plenty for an address-stillness scan.
                guard frameIndex % 3 == 0 else { return }
                let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                guard pts.isNumeric else { return }
                let tMs = CMTimeGetSeconds(pts) * 1000.0
                guard tMs >= fromMs && tMs <= toMs else { return }
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

                let poseRequest = VNDetectHumanBodyPoseRequest()
                // F1: same cgOrientation(for:) source as the trajectory pass.
                let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
                try? handler.perform([poseRequest])
                guard let obs = poseRequest.results?.first else { return }

                func joint(_ name: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
                    guard let p = try? obs.recognizedPoint(name), p.confidence > 0.3 else { return nil }
                    return p.location
                }
                let ankles = [joint(.leftAnkle), joint(.rightAnkle)].compactMap { $0 }
                let wrists = [joint(.leftWrist), joint(.rightWrist)].compactMap { $0 }
                let wrist: CGPoint? = wrists.isEmpty ? nil : CGPoint(
                    x: wrists.map { $0.x }.reduce(0, +) / CGFloat(wrists.count),
                    y: wrists.map { $0.y }.reduce(0, +) / CGFloat(wrists.count))
                samples.append(TracerAnkleSample(
                    timeMs: tMs,
                    ankleMeanX: ankles.isEmpty ? nil : ankles.map { $0.x }.reduce(0, +) / CGFloat(ankles.count),
                    ankleMinY: ankles.isEmpty ? nil : ankles.map { $0.y }.min(),
                    wrist: wrist))
            }
        }
        reader.cancelReading()
        return samples
    }

    /// F10: seed the launch ROI from a LOW-MOTION sample ~1.2-1.5s pre-impact
    /// (address stance — wrists still, ball at the feet). NOT impact-800ms,
    /// which is mid-backswing. ballAddress ~ (mean ankle x, min ankle y + 0.04);
    /// ROI = ballAddress ± 0.15 wide x 0.35 tall extending UPWARD (bottom-left
    /// origin: up = +y). poseAnchor = (mean ankle x, min ankle y + 0.01) at the
    /// sample nearest impact.
    private func tracerLaunchSeed(samples: [TracerAnkleSample], impactTimeMs: Double) -> TracerLaunchSeed {
        func motion(at i: Int) -> CGFloat {
            // Missing wrists rank as high motion so they lose to clean samples.
            guard i > 0, let w = samples[i].wrist, let p = samples[i - 1].wrist else { return 10.0 }
            let dx = w.x - p.x
            let dy = w.y - p.y
            return (dx * dx + dy * dy).squareRoot()
        }
        func pickAddress(loMs: Double, hiMs: Double) -> Int? {
            var best: Int?
            var bestMotion = CGFloat.greatestFiniteMagnitude
            for i in samples.indices {
                let s = samples[i]
                guard s.ankleMeanX != nil, s.ankleMinY != nil else { continue }
                guard s.timeMs >= loMs && s.timeMs <= hiMs else { continue }
                let m = motion(at: i)
                if m < bestMotion {
                    bestMotion = m
                    best = i
                }
            }
            return best
        }
        // Preferred address band, then progressively widened.
        let addressIdx = pickAddress(loMs: impactTimeMs - 1500.0, hiMs: impactTimeMs - 1200.0)
            ?? pickAddress(loMs: impactTimeMs - 1600.0, hiMs: impactTimeMs - 900.0)
            ?? pickAddress(loMs: impactTimeMs - 1600.0, hiMs: impactTimeMs + 120.0)

        // poseAnchor: ankle sample nearest the impact frame.
        var anchorIdx: Int?
        var anchorDt = Double.greatestFiniteMagnitude
        for i in samples.indices {
            guard samples[i].ankleMeanX != nil, samples[i].ankleMinY != nil else { continue }
            let dt = abs(samples[i].timeMs - impactTimeMs)
            if dt < anchorDt {
                anchorDt = dt
                anchorIdx = i
            }
        }
        var poseAnchor: CGPoint?
        if let i = anchorIdx, let x = samples[i].ankleMeanX, let y = samples[i].ankleMinY {
            poseAnchor = CGPoint(x: x, y: y + 0.01)
        }

        if let i = addressIdx, let ax = samples[i].ankleMeanX, let ay = samples[i].ankleMinY {
            let ball = CGPoint(x: ax, y: ay + 0.04)
            // Clamp so the ROI stays inside the unit square.
            let roi = CGRect(
                x: max(0.0, min(0.70, ball.x - 0.15)),
                y: max(0.0, min(0.65, ball.y)),
                width: 0.30, height: 0.35)
            return TracerLaunchSeed(roi: roi, poseAnchor: poseAnchor, golferX: ax, fromPose: true)
        }

        // Terminal fallback: frame-center launch zone matching the arcSpec
        // default anchor (0.5, 0.18). poseAnchor may still exist independently.
        let roi = CGRect(x: 0.30, y: 0.06, width: 0.40, height: 0.42)
        return TracerLaunchSeed(roi: roi, poseAnchor: poseAnchor, golferX: poseAnchor?.x, fromPose: false)
    }

    // ========================================================================
    // MARK: renderTracerOnClip — CALayer arc burn-in (composeReel clone)
    // ========================================================================

    internal func renderTracerOnClipImpl(videoUri: String, specJson: String, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
            let startTime = CACurrentMediaTime()

            guard let spec = TracerRenderSpec(json: specJson) else {
                promise.reject(Exception(name: "ERR_TRACER_SPEC", description: "Invalid TracerRenderSpec JSON"))
                return
            }
            let fileURL = self.resolveFileURL(videoUri)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Video file not found: \(fileURL.path)"))
                return
            }
            let asset = AVURLAsset(url: fileURL)
            guard let srcVideoTrack = asset.tracks(withMediaType: .video).first else {
                promise.reject(Exception(name: "ERR_NO_VIDEO_TRACK", description: "Clip has no video track"))
                return
            }
            let durationSec = CMTimeGetSeconds(asset.duration)
            // Defense-in-depth: JS pre-checks minAnimSec; a draw starting at
            // the very end would export a clip with an invisible tracer.
            guard spec.animStartSec < durationSec - 0.4 else {
                promise.reject(Exception(name: "ERR_TRACER_ANIM_WINDOW", description: "animStartSec \(spec.animStartSec) too close to clip end (\(String(format: "%.2f", durationSec))s)"))
                return
            }

            // ---- Single-clip composition, full range ----
            let composition = AVMutableComposition()
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                promise.reject(Exception(name: "ERR_COMPOSITION", description: "Could not create composition video track"))
                return
            }
            let fullRange = CMTimeRange(start: .zero, duration: asset.duration)
            do {
                try videoTrack.insertTimeRange(fullRange, of: srcVideoTrack, at: .zero)
            } catch {
                promise.reject(Exception(name: "ERR_INSERT_VIDEO", description: "Failed inserting video: \(error.localizedDescription)"))
                return
            }
            // Audio track ONLY if the source has one — an empty audio track +
            // custom videoComposition fails export with -11838 (in-repo
            // landmine, see composeReelOnDevice). CameraView records mute by
            // default, so most clips have no audio at all.
            if let srcAudioTrack = asset.tracks(withMediaType: .audio).first {
                if let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
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

            // ---- Layers (fresh, NEVER attached to any view) ----
            let parentLayer = CALayer()
            let videoLayer = CALayer()
            parentLayer.frame = CGRect(origin: .zero, size: renderSize)
            videoLayer.frame = CGRect(origin: .zero, size: renderSize)
            parentLayer.addSublayer(videoLayer)

            // Spec coords are normalized, display-oriented, BOTTOM-LEFT origin —
            // the SAME convention as AVVideoCompositionCoreAnimationTool, so
            // mapping to render pixels is a pure scale with NO y-flip.
            func px(_ p: CGPoint) -> CGPoint {
                CGPoint(x: p.x * renderSize.width, y: p.y * renderSize.height)
            }
            // Two quadratic Beziers joined at the apex (horizontal tangents are
            // guaranteed by the TS control-point construction, not here).
            let path = UIBezierPath()
            path.move(to: px(spec.p0))
            path.addQuadCurve(to: px(spec.a), controlPoint: px(spec.c1))
            path.addQuadCurve(to: px(spec.p3), controlPoint: px(spec.c2))

            // Spec widths are at-1080-wide-render pixels.
            let widthScale = renderSize.width / 1080.0
            let baseColor = tracerColor(spec.color, alpha: 1.0)

            func strokeLayer(width: CGFloat, color: UIColor) -> CAShapeLayer {
                let layer = CAShapeLayer()
                layer.path = path.cgPath
                layer.strokeColor = color.cgColor
                layer.fillColor = nil
                layer.lineWidth = width
                layer.lineCap = .round
                layer.lineJoin = .round
                layer.strokeEnd = 0 // hidden until the draw-on begins
                return layer
            }
            // 3-layer glow: 16px orange @0.45 / 8px @0.6 / 4px core @0.75.
            let glowLayer = strokeLayer(width: spec.glowWidthPx * widthScale, color: tracerColor(spec.color, alpha: 0.45))
            let midLayer = strokeLayer(width: spec.midWidthPx * widthScale, color: tracerColor(spec.color, alpha: 0.6))
            let coreLayer = strokeLayer(width: spec.lineWidthPx * widthScale, color: tracerColor(spec.coreColor, alpha: 0.75))
            // Layer shadows DO rasterize through the animation tool (CIFilter
            // blur does NOT — never attempt it).
            coreLayer.shadowColor = baseColor.cgColor
            coreLayer.shadowRadius = 8.0 * widthScale
            coreLayer.shadowOpacity = 0.9
            coreLayer.shadowOffset = .zero

            // Hard image-space deceleration toward the vanishing point.
            let ease = CAMediaTimingFunction(controlPoints: 0.17, 0.67, 0.45, 1.0)
            // NEVER literal beginTime 0 — CoreAnimation remaps it to "now" and
            // the animation silently never renders in an export (in-repo
            // pattern: composeReelOnDevice scorecard fades).
            let beginTime = AVCoreAnimationBeginTimeAtZero + spec.animStartSec

            for layer in [glowLayer, midLayer, coreLayer] {
                let draw = CABasicAnimation(keyPath: "strokeEnd")
                draw.fromValue = 0.0
                draw.toValue = 1.0
                draw.beginTime = beginTime
                draw.duration = spec.animDurationSec
                draw.timingFunction = ease
                draw.fillMode = .forwards
                draw.isRemovedOnCompletion = false
                layer.add(draw, forKey: "tracerDraw")
                parentLayer.addSublayer(layer)
            }

            // Optional comet head: a small dot paced along the same path, then
            // faded out over 0.25s once the draw completes.
            if spec.cometHead {
                let diameter = 10.0 * widthScale
                let dot = CALayer()
                dot.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
                dot.cornerRadius = diameter / 2.0
                dot.backgroundColor = tracerColor(spec.coreColor, alpha: 1.0).cgColor
                dot.shadowColor = baseColor.cgColor
                dot.shadowRadius = 8.0 * widthScale
                dot.shadowOpacity = 0.9
                dot.shadowOffset = .zero
                dot.position = px(spec.p0)
                dot.opacity = 0 // hidden before launch; opacity keyframes below

                let move = CAKeyframeAnimation(keyPath: "position")
                move.path = path.cgPath
                move.calculationMode = .paced
                move.beginTime = beginTime
                move.duration = spec.animDurationSec
                move.timingFunction = ease
                move.fillMode = .forwards
                move.isRemovedOnCompletion = false
                dot.add(move, forKey: "cometMove")

                let totalFade = spec.animDurationSec + 0.25
                let fade = CAKeyframeAnimation(keyPath: "opacity")
                fade.values = [1.0, 1.0, 0.0]
                fade.keyTimes = [0.0, NSNumber(value: spec.animDurationSec / totalFade), 1.0]
                fade.beginTime = beginTime
                fade.duration = totalFade
                fade.fillMode = .forwards
                fade.isRemovedOnCompletion = false
                dot.add(fade, forKey: "cometFade")

                parentLayer.addSublayer(dot)
            }

            // ---- Video composition ----
            let videoComposition = AVMutableVideoComposition()
            videoComposition.renderSize = renderSize
            // Respect the SOURCE fps — a hardcoded 1/30 silently halves 60fps
            // sources (F18).
            let fps = srcVideoTrack.nominalFrameRate
            let timescale: Int32 = fps > 1 ? Int32(min(60.0, Double(fps).rounded())) : 30
            videoComposition.frameDuration = CMTime(value: 1, timescale: timescale)
            videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
                postProcessingAsVideoLayer: videoLayer,
                in: parentLayer
            )

            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: .zero, duration: composition.duration)
            let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
            layerInstruction.setTransform(self.computeFillTransform(
                naturalSize: naturalSize,
                preferredTransform: preferredTransform,
                renderSize: renderSize
            ), at: .zero)
            instruction.layerInstructions = [layerInstruction]
            videoComposition.instructions = [instruction]

            // ---- Export (composeReelOnDevice pattern) ----
            let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                .appendingPathComponent("tracer_\(UUID().uuidString).mp4")
            try? FileManager.default.removeItem(at: outputURL)

            // Size-specific preset: HighestQuality + custom AVVideoComposition
            // on HEVC/HDR source fails with -11838; 1920x1080 forces a known
            // good H.264 SDR combo (in-repo landmine, see composeReelOnDevice).
            guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset1920x1080) else {
                promise.reject(Exception(name: "ERR_EXPORT_SESSION", description: "Could not create export session for tracer"))
                return
            }
            exportSession.outputURL = outputURL
            exportSession.outputFileType = .mp4
            exportSession.videoComposition = videoComposition
            exportSession.shouldOptimizeForNetworkUse = true

            // UIBackgroundTask so backgrounding mid-render doesn't kill the
            // export with -11847; cancelExport in the expiration handler so a
            // partial file is surfaced as an error, not a silent success.
            // beginBackgroundTask must run on the main thread.
            var bgTaskId: UIBackgroundTaskIdentifier = .invalid
            DispatchQueue.main.sync {
                bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ClipparTracerRender") {
                    print("[Clippar.Tracer] background task expiring — cancelling export")
                    exportSession.cancelExport()
                }
            }
            defer {
                if bgTaskId != .invalid {
                    DispatchQueue.main.async {
                        UIApplication.shared.endBackgroundTask(bgTaskId)
                    }
                }
            }

            let semaphore = DispatchSemaphore(value: 0)
            var exportError: Error?
            exportSession.exportAsynchronously {
                // .cancelled (bg-task expiry) is an error too — JS must not
                // record a half-written tracer file as 'done'.
                if exportSession.status == .failed || exportSession.status == .cancelled {
                    exportError = exportSession.error ?? NSError(
                        domain: "ClipparExport",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "Tracer export was cancelled (likely backgrounded too long)"]
                    )
                }
                semaphore.signal()
            }
            semaphore.wait()

            if let error = exportError {
                let nsErr = error as NSError
                print("[Clippar.Tracer] FAIL render status=\(exportSession.status.rawValue) error=\(error.localizedDescription) code=\(nsErr.code) domain=\(nsErr.domain)")
                try? FileManager.default.removeItem(at: outputURL)
                promise.reject(Exception(name: "ERR_TRACER_RENDER_FAILED", description: "Tracer render failed: \(error.localizedDescription) (code \(nsErr.code))"))
                return
            }

            let elapsed = CACurrentMediaTime() - startTime
            print("[Clippar.Tracer] OK render animStart=\(String(format: "%.2f", spec.animStartSec)) animDur=\(String(format: "%.2f", spec.animDurationSec)) durationSec=\(String(format: "%.1f", durationSec)) elapsedSec=\(String(format: "%.1f", elapsed)) out=\(outputURL.lastPathComponent)")

            promise.resolve([
                "tracerUri": outputURL.absoluteString,
                "durationMs": durationSec * 1000.0,
            ] as [String: Any])
            } // autoreleasepool
        }
    }

    // ========================================================================
    // MARK: getCameraFovDeg — back-wide 1920x1080 horizontal FOV
    // ========================================================================

    /// Resolves { hFovLandscapeDeg } from the back wide camera's 1920x1080
    /// format (videoFieldOfView is the LANDSCAPE/long-axis horizontal FOV —
    /// the TS side converts to portrait). No capture session is created.
    /// Resolves { hFovLandscapeDeg: null } when unavailable (simulator, etc.).
    internal func getCameraFovDegImpl(promise: Promise) {
        DispatchQueue.global(qos: .utility).async {
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                promise.resolve(["hFovLandscapeDeg": NSNull()])
                return
            }
            var best: Double?
            for format in device.formats {
                let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                guard dims.width == 1920 && dims.height == 1080 else { continue }
                let fov = Double(format.videoFieldOfView)
                guard fov > 0 else { continue }
                // Prefer a format that supports the camera pipeline's 30fps.
                let supports30 = format.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= 30 }
                if best == nil { best = fov }
                if supports30 {
                    best = fov
                    break
                }
            }
            if let fov = best {
                promise.resolve(["hFovLandscapeDeg": fov])
            } else {
                promise.resolve(["hFovLandscapeDeg": NSNull()])
            }
        }
    }

    // ========================================================================
    // MARK: getDevicePitchDeg — one-shot CoreMotion camera pitch (F2)
    // ========================================================================

    /// One-shot pitch-down angle of the BACK camera optical axis, in degrees
    /// (positive = camera tilted down toward the ground). Derivation: the
    /// optical axis is device -Z; with gravity g (unit, device coords),
    /// sin(pitchDown) = dot(-Z_axis_world_down) = -gz. Device flat screen-up
    /// reads gz = -1 (pitch -90, camera straight down is +90 via -gz... the
    /// sign works out: portrait upright on a tripod gives gz ~ 0 -> pitch ~ 0;
    /// tilting the camera toward the ground tips the screen normal upward,
    /// gz goes negative, -gz > 0 -> positive pitch-down).
    /// Resolves { pitchDownDeg } or { pitchDownDeg: null } after a ~1s timeout
    /// (F2 — the TS side then falls back to config.tracer.horizonY).
    internal func getDevicePitchDegImpl(promise: Promise) {
        let manager = CMMotionManager()
        let stateQueue = DispatchQueue(label: "clippar.tracer.pitch")
        var resolved = false

        // NOTE: manager <-> handler <-> finish form a deliberate temporary
        // retain cycle that keeps the one-shot manager alive; stopping updates
        // in finish() breaks it. The timeout below guarantees finish() runs.
        func finish(_ value: Double?) {
            stateQueue.async {
                guard !resolved else { return }
                resolved = true
                manager.stopDeviceMotionUpdates()
                manager.stopAccelerometerUpdates()
                if let v = value, v.isFinite {
                    promise.resolve(["pitchDownDeg": v])
                } else {
                    promise.resolve(["pitchDownDeg": NSNull()])
                }
            }
        }

        func pitchDownDeg(gx: Double, gy: Double, gz: Double) -> Double? {
            let norm = (gx * gx + gy * gy + gz * gz).squareRoot()
            // A clean static gravity sample has |g| ~ 1; reject junk reads.
            guard norm > 0.5 && norm < 1.5 else { return nil }
            let s = max(-1.0, min(1.0, -gz / norm))
            return asin(s) * 180.0 / Double.pi
        }

        let motionQueue = OperationQueue()
        motionQueue.maxConcurrentOperationCount = 1

        if manager.isDeviceMotionAvailable {
            manager.deviceMotionUpdateInterval = 0.05
            manager.startDeviceMotionUpdates(to: motionQueue) { motion, _ in
                guard let g = motion?.gravity else { return }
                if let deg = pitchDownDeg(gx: g.x, gy: g.y, gz: g.z) {
                    finish(deg)
                }
            }
        } else if manager.isAccelerometerAvailable {
            // Raw accelerometer ~= gravity on a static tripod-mounted phone.
            manager.accelerometerUpdateInterval = 0.05
            manager.startAccelerometerUpdates(to: motionQueue) { data, _ in
                guard let a = data?.acceleration else { return }
                if let deg = pitchDownDeg(gx: a.x, gy: a.y, gz: a.z) {
                    finish(deg)
                }
            }
        } else {
            finish(nil)
            return
        }

        // F2: ~1s timeout -> null (TS falls back to config.tracer.horizonY).
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.0) {
            finish(nil)
        }
    }
}
