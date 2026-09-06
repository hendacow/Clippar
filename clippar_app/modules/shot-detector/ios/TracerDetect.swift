//
//  TracerDetect.swift
//  Tracer V3 — the DRIVER for TracerDetectCore: AVAssetReader frame pump, Vision body pose,
//  the Core ML golf-ball model, and the orchestration that mirrors `lib/detect.py::detect()`.
//
//  Everything numeric lives in TracerDetectCore.swift. This file only moves pixels and time
//  around, so that the part with the measured behaviour can be typechecked and unit-run
//  without an Xcode project (there is no `pod install` in this checkout).
//
//  ENTRY POINT (called by the Expo function another agent registers — this file declares no
//  Expo module and imports no ExpoModulesCore):
//
//      let dict = TracerDetect.detect(assetURL: url,
//                                     impactTimeMs: 5610,
//                                     options: TracerDetectOptions(json: optionsJson))
//
//  It returns the SHARED CONVENTION 2 dictionary — pixels, top-left origin, display-oriented —
//  ready to be handed to JS as-is. It never throws and never rejects: a clip it cannot read, a
//  missing model, a golfer it cannot find all come back as `found: false` with a `reason`.
//  That is deliberate. The product rule from the lab is that a failure must be a SKIP, never a
//  fabricated arc, and a rejected promise higher up is a skip that looks like a bug.
//
//  COST. This is an offline, post-shot job on one clip, the same shape as the app's existing
//  on-device trimming — not a capture-time path. With `config.tracer.enabled` false nothing in
//  this file runs and no model is loaded (loading is lazy, deliberately not `OnCreate`).
//
import Foundation
import AVFoundation
import Vision
import CoreML
import CoreVideo
import CoreGraphics
import Accelerate

// MARK: - Options

/// Parsed from the `optionsJson` string the JS side passes. Every key is optional; the defaults
/// are the lab's. Only the knobs the integration actually needs are exposed — the rest of `P`
/// stays where it was measured.
public struct TracerDetectOptions {
    public var params = TracerParams()
    /// Use the bundled Core ML ball model for address candidates. False = blob + pose ROI only.
    public var useCoreML = true
    /// Emit per-stage timings and the address decision into `notes`.
    public var verbose = false

    public init() {}

    public init(json: String) {
        self.init()
        guard !json.isEmpty,
              let data = json.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        func d(_ k: String) -> Double? { (obj[k] as? NSNumber)?.doubleValue }
        func i(_ k: String) -> Int? { (obj[k] as? NSNumber)?.intValue }
        func b(_ k: String) -> Bool? { obj[k] as? Bool }

        // window
        if let v = i("preFrames") { params.preFrames = max(0, v) }
        if let v = i("postFrames") { params.postFrames = max(5, v) }
        if let v = i("bgStartFrames") { params.bgStart = max(2, v) }
        if let v = i("bgEndFrames") { params.bgEnd = max(1, v) }
        if let v = i("maxFrames") { params.maxFrames = max(0, v) }
        // thresholds
        if let v = d("peakThr") { params.peakThr = v }
        if let v = d("acceptScore") { params.acceptScore = v }
        if let v = d("acceptFirst") { params.acceptFirst = v }
        if let v = d("confFloor") { params.confFloor = v }
        if let v = i("minTrackEmit") { params.minTrackEmit = max(1, v) }
        if let v = d("addrWeakC") { params.addrWeakC = v }
        // switches
        if let v = b("pose") { params.poseEnabled = v }
        if let v = b("localBg") { params.localBg = v }
        if let v = b("useCoreML") { useCoreML = v }
        if let v = b("verbose") { verbose = v }
    }
}

// MARK: - Result

/// The successful payload. Named `TracerDetectPayload` rather than `TracerDetection` because
/// Core already uses that name for ONE detection; this is the whole run.
public struct TracerDetectPayload {
    public var address: (x: Double, y: Double, r: Double)
    public var launchFrame: Int
    public var impactFrameUsed: Int
    public var detections: [TracerDetection]
    public var confMean: Double
}

public enum TracerDetectResult {
    case ok(TracerDetectPayload)
    case none(reason: String)
}

// MARK: - Frame pump

/// One decoded frame, already rotated into display orientation.
struct TracerDecodedFrame {
    var index: Int
    var bgra: TracerBGRA
}

/// Sequential frame reader over a frame-index range, display-oriented.
///
/// The patterns here are lifted from `detectBallLaunchImpl` in ShotTracer.swift because each one
/// encodes a bug that was already paid for: `alwaysCopiesSampleData = false`, an autoreleasepool
/// around every `copyNextSampleBuffer` (without it a 50-frame pass holds 50 full frames), a
/// backward pad on the requested time range because the reader snaps to the preceding sync
/// sample, and trimming to the wanted range by PTS rather than by counting frames.
final class TracerFramePump {
    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let fps: Double
    private let startFrame: Int
    private let endFrame: Int
    private let rotation: Int          // 0, 90, 180, 270 — clockwise, to reach display orientation
    let displayWidth: Int
    let displayHeight: Int

    init?(asset: AVURLAsset, track: AVAssetTrack, startFrame: Int, endFrame: Int, fps: Double) {
        guard fps > 0, endFrame >= startFrame else { return nil }
        self.fps = fps
        self.startFrame = startFrame
        self.endFrame = endFrame
        let t = track.preferredTransform
        // Same four-case table as ShotDetectorModule.cgOrientation(for:), but expressed as the
        // clockwise pixel rotation needed to reach display orientation rather than as a
        // CGImagePropertyOrientation — this file rotates the pixels itself so that Vision, Core
        // ML and the detector all see one coordinate system.
        if t.a == 0 && t.b == 1 && t.c == -1 && t.d == 0 { rotation = 90 }
        else if t.a == -1 && t.b == 0 && t.c == 0 && t.d == -1 { rotation = 180 }
        else if t.a == 0 && t.b == -1 && t.c == 1 && t.d == 0 { rotation = 270 }
        else { rotation = 0 }
        let natural = track.naturalSize
        let nw = Int(abs(natural.width).rounded()), nh = Int(abs(natural.height).rounded())
        if rotation == 90 || rotation == 270 {
            displayWidth = nh
            displayHeight = nw
        } else {
            displayWidth = nw
            displayHeight = nh
        }
        guard let r = try? AVAssetReader(asset: asset) else { return nil }
        reader = r
        output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        let padSec = 0.5
        let start = max(0.0, Double(startFrame) / fps - padSec)
        let durationSec = CMTimeGetSeconds(asset.duration)
        let end = min(durationSec.isFinite && durationSec > 0 ? durationSec : Double(endFrame + 2) / fps,
                      Double(endFrame + 2) / fps)
        guard end > start else { return nil }
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: 600),
            duration: CMTime(seconds: end - start, preferredTimescale: 600))
        guard reader.startReading() else { return nil }
    }

    deinit { reader.cancelReading() }

    /// Feed every frame in [startFrame, endFrame] to `body`, in order. Return false from `body`
    /// to stop early.
    func forEach(_ body: (TracerDecodedFrame) -> Bool) {
        var done = false
        var lastIndex = Int.min
        while !done {
            autoreleasepool {
                guard let sb = output.copyNextSampleBuffer() else { done = true; return }
                let pts = CMSampleBufferGetPresentationTimeStamp(sb)
                guard pts.isNumeric else { return }
                let k = Int(floor(CMTimeGetSeconds(pts) * fps + 1e-6))
                if k > endFrame { done = true; return }
                if k < startFrame { return }
                // Monotonic guard: a re-ordered or duplicated PTS would corrupt the frame->index
                // mapping the whole detector is indexed by.
                if k <= lastIndex { return }
                lastIndex = k
                guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
                guard let frame = Self.displayOrientedBGRA(pb, rotation: rotation) else { return }
                if !body(TracerDecodedFrame(index: k, bgra: frame)) { done = true }
            }
        }
        reader.cancelReading()
    }

    /// Copy a BGRA pixel buffer into a contiguous display-oriented byte array.
    ///
    /// The index maps are derived from `preferredTransform` algebraically rather than taken from
    /// a rotation library: `CGRect(0,0,w,h).applying(t)` with t = [0,1,-1,0] sends (x, y) to
    /// (-y, x), which after translation to the origin is (H-1-y, x) — a clockwise quarter turn.
    /// The 180 and 270 cases follow the same way. Doing it by hand costs one gather pass per
    /// frame and removes any question about which way a library's "90 degrees" turns.
    static func displayOrientedBGRA(_ pb: CVPixelBuffer, rotation: Int) -> TracerBGRA? {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
        let sw = CVPixelBufferGetWidth(pb)
        let sh = CVPixelBufferGetHeight(pb)
        let stride = CVPixelBufferGetBytesPerRow(pb)
        let src = base.assumingMemoryBound(to: UInt8.self)
        let dw = (rotation == 90 || rotation == 270) ? sh : sw
        let dh = (rotation == 90 || rotation == 270) ? sw : sh
        var out = [UInt8](repeating: 0, count: dw * dh * 4)
        out.withUnsafeMutableBufferPointer { dst in
            let d = dst.baseAddress!
            for y in 0..<sh {
                let row = src + y * stride
                for x in 0..<sw {
                    var dx = x, dy = y
                    switch rotation {
                    case 90:  dx = sh - 1 - y; dy = x
                    case 180: dx = sw - 1 - x; dy = sh - 1 - y
                    case 270: dx = y;          dy = sw - 1 - x
                    default:  break
                    }
                    let si = x * 4
                    let di = (dy * dw + dx) * 4
                    d[di] = row[si]
                    d[di + 1] = row[si + 1]
                    d[di + 2] = row[si + 2]
                    d[di + 3] = row[si + 3]
                }
            }
        }
        return TracerBGRA(width: dw, height: dh, px: out)
    }
}

/// Wrap a display-oriented BGRA frame (or a rectangle of it) in a CVPixelBuffer for Vision.
func tracerMakePixelBuffer(_ f: TracerBGRA, x0: Int, y0: Int, width: Int, height: Int) -> CVPixelBuffer? {
    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                              kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb) == kCVReturnSuccess,
          let buf = pb else { return nil }
    CVPixelBufferLockBaseAddress(buf, [])
    defer { CVPixelBufferUnlockBaseAddress(buf, []) }
    guard let base = CVPixelBufferGetBaseAddress(buf) else { return nil }
    let stride = CVPixelBufferGetBytesPerRow(buf)
    let dst = base.assumingMemoryBound(to: UInt8.self)
    f.px.withUnsafeBufferPointer { src in
        for y in 0..<height {
            let s = src.baseAddress! + ((y0 + y) * f.width + x0) * 4
            memcpy(dst + y * stride, s, width * 4)
        }
    }
    return buf
}

// MARK: - Vision body pose

/// Vision's body-pose joints in COCO-17 order, which is the order `TracerDetectCore` (and the
/// lab's yolov8n-pose) indexes: nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles.
enum TracerVisionPose {
    static let jointOrder: [VNHumanBodyPoseObservation.JointName] = [
        .nose, .leftEye, .rightEye, .leftEar, .rightEar,
        .leftShoulder, .rightShoulder, .leftElbow, .rightElbow,
        .leftWrist, .rightWrist, .leftHip, .rightHip,
        .leftKnee, .rightKnee, .leftAnkle, .rightAnkle
    ]

    /// The golfer's pose on one display-oriented frame, in TOP-LEFT pixels.
    ///
    /// PORT: the lab uses yolov8n-pose and takes "the largest person" by the DETECTOR's box.
    /// `VNHumanBodyPoseObservation` carries no box, so the box here is the extent of the
    /// confident keypoints. It is used for one thing — the `L = 0.45 * boxHeight` fallback when
    /// the hips are missing or the golfer is bent over — and a keypoint hull is slightly smaller
    /// than a person box (no hair, no shoe margin), so that fallback runs a little short.
    static func pose(in frame: TracerBGRA, params: TracerParams) -> TracerPose? {
        guard let pb = tracerMakePixelBuffer(frame, x0: 0, y0: 0, width: frame.width, height: frame.height) else {
            return nil
        }
        let request = VNDetectHumanBodyPoseRequest()
        // The buffer is ALREADY display-oriented, so Vision is told `.up` and every coordinate
        // it returns is in the same frame the detector works in. One rotation, one convention.
        let handler = VNImageRequestHandler(cvPixelBuffer: pb, orientation: .up, options: [:])
        guard (try? handler.perform([request])) != nil,
              let observations = request.results, !observations.isEmpty else { return nil }

        var best: TracerPose?
        var bestArea = -1.0
        let W = Double(frame.width), H = Double(frame.height)
        for obs in observations {
            if Double(obs.confidence) < params.poseConf { continue }
            var xs = [Double](repeating: 0, count: 17)
            var ys = [Double](repeating: 0, count: 17)
            var cs = [Double](repeating: -1, count: 17)
            var minX = Double.greatestFiniteMagnitude, minY = Double.greatestFiniteMagnitude
            var maxX = -Double.greatestFiniteMagnitude, maxY = -Double.greatestFiniteMagnitude
            for (i, name) in jointOrder.enumerated() {
                guard let p = try? obs.recognizedPoint(name), p.confidence > 0 else { continue }
                // Vision is normalized BOTTOM-LEFT; the detector is pixels TOP-LEFT.
                let x = Double(p.location.x) * W
                let y = (1.0 - Double(p.location.y)) * H
                xs[i] = x
                ys[i] = y
                cs[i] = Double(p.confidence)
                if Double(p.confidence) >= params.kpConf {
                    minX = min(minX, x); maxX = max(maxX, x)
                    minY = min(minY, y); maxY = max(maxY, y)
                }
            }
            if minX > maxX || minY > maxY { continue }
            let area = (maxX - minX) * (maxY - minY)
            if area > bestArea {
                bestArea = area
                best = TracerPose(x: xs, y: ys, conf: cs, box: (minX, minY, maxX, maxY))
            }
        }
        return best
    }
}

// MARK: - Core ML golf-ball model

/// A token whose class identity locates the module's own bundle (`Bundle(for:)` needs a class).
private final class TracerBundleToken {}

/// The lab's `golfballyolov8n_640.mlpackage`, bundled as `GolfBallDetector.mlpackage` and
/// compiled to `.mlmodelc` once at first use.
///
/// CocoaPods `resource_bundles` copies a `.mlpackage` VERBATIM — it does NOT compile it the way
/// an app target would — so both forms are handled, exactly as `SwingVisionModule.loadResources()`
/// next door already does. Loading is LAZY on purpose: with `config.tracer.enabled` false nothing
/// calls `detect`, so no model is compiled, no ANE is woken and app launch is untouched.
///
/// Degrades: if the resource is missing or will not compile, `available` stays false, the address
/// finder falls back to the bright-blob and pose-ROI candidates, and `notes.coreml` says why.
/// It never crashes and never invents a detection.
final class TracerBallModel {
    static let shared = TracerBallModel()

    private let lock = NSLock()
    private var attempted = false
    private var visionModel: VNCoreMLModel?
    private(set) var loadError: String?

    private static let inputSide = 640
    /// Ultralytics `predict(conf=0.15)` — the value the lab's address finder ran with.
    static let confThreshold = 0.15
    /// Ultralytics' default NMS IoU. The exported model has `nms=False`, so NMS is ours to do.
    static let nmsIoU = 0.7

    var available: Bool {
        ensureLoaded()
        return visionModel != nil
    }

    private func candidateBundles() -> [Bundle] {
        var bundles: [Bundle] = []
        let host = Bundle(for: TracerBundleToken.self)
        for b in [host, Bundle.main] {
            if let url = b.url(forResource: "ShotDetectorResources", withExtension: "bundle"),
               let rb = Bundle(url: url) {
                bundles.append(rb)
            }
        }
        bundles.append(host)
        bundles.append(Bundle.main)
        return bundles
    }

    private func findResource(_ name: String, _ exts: [String]) -> URL? {
        for b in candidateBundles() {
            for ext in exts {
                if let url = b.url(forResource: name, withExtension: ext) { return url }
            }
        }
        return nil
    }

    func ensureLoaded() {
        lock.lock()
        defer { lock.unlock() }
        if attempted { return }
        attempted = true
        var compiledURL = findResource("GolfBallDetector", ["mlmodelc"])
        if compiledURL == nil, let pkg = findResource("GolfBallDetector", ["mlpackage"]) {
            do {
                let cacheDir = try FileManager.default.url(
                    for: .applicationSupportDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true
                ).appendingPathComponent("ShotDetector", isDirectory: true)
                try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
                let cached = cacheDir.appendingPathComponent("GolfBallDetector.mlmodelc")
                if FileManager.default.fileExists(atPath: cached.path) {
                    compiledURL = cached
                } else {
                    let tmp = try MLModel.compileModel(at: pkg)
                    try? FileManager.default.removeItem(at: cached)
                    try FileManager.default.copyItem(at: tmp, to: cached)
                    compiledURL = cached
                }
            } catch {
                loadError = "mlpackage compile failed: \(error.localizedDescription)"
                return
            }
        }
        guard let modelURL = compiledURL else {
            loadError = "GolfBallDetector (.mlmodelc/.mlpackage) not found in any bundle"
            return
        }
        do {
            let config = MLModelConfiguration()
            config.computeUnits = .all
            visionModel = try VNCoreMLModel(for: try MLModel(contentsOf: modelURL, configuration: config))
        } catch {
            loadError = "model load failed: \(error.localizedDescription)"
        }
    }

    /// Ball detections on one display-oriented frame, in TOP-LEFT pixels.
    ///
    /// PORT, and this one matters: the lab runs ultralytics at `imgsz=1920`, i.e. the ball is at
    /// NATIVE resolution (~30 px across at address). The exported Core ML model has a FIXED
    /// 640x640 input, so a whole-frame letterbox shrinks a 1080x1920 portrait clip by 3x and the
    /// ball to ~10 px — measurably still detectable (0.745 on IMG_3629 frame impact-0.8 s, checked
    /// against this exact .mlpackage) but weaker on the far-camera clips that already fail.
    /// So the frame is run as a whole-frame letterbox PLUS native-resolution 640x640 tiles over
    /// `tileRegions`, and the detections are merged. That restores the lab's effective resolution;
    /// the extra inferences cost ~2 ms each on the Neural Engine (measured on a Mac in the lab's
    /// `coreml_bench_results.md`, not on a phone).
    func detect(in frame: TracerBGRA, tileRegions: [(Int, Int, Int, Int)]) -> [TracerYoloDetection] {
        ensureLoaded()
        guard let model = visionModel else { return [] }
        var out: [TracerYoloDetection] = []
        var windows: [(Int, Int, Int, Int)] = [(0, 0, frame.width, frame.height)]
        for r in tileRegions {
            let side = Self.inputSide
            let cx = (r.0 + r.2) / 2, cy = (r.1 + r.3) / 2
            let x0 = max(0, min(frame.width - min(side, frame.width), cx - side / 2))
            let y0 = max(0, min(frame.height - min(side, frame.height), cy - side / 2))
            let x1 = min(frame.width, x0 + side)
            let y1 = min(frame.height, y0 + side)
            if x1 - x0 >= 64 && y1 - y0 >= 64 { windows.append((x0, y0, x1, y1)) }
        }
        for w in windows {
            out += infer(frame: frame, x0: w.0, y0: w.1, x1: w.2, y1: w.3, model: model)
        }
        return Self.nonMaximumSuppression(out)
    }

    private func infer(frame: TracerBGRA, x0: Int, y0: Int, x1: Int, y1: Int,
                       model: VNCoreMLModel) -> [TracerYoloDetection] {
        let side = Self.inputSide
        let cw = x1 - x0, ch = y1 - y0
        if cw <= 0 || ch <= 0 { return [] }
        let scale = Double(side) / Double(max(cw, ch))
        let nw = max(1, Int((Double(cw) * scale).rounded()))
        let nh = max(1, Int((Double(ch) * scale).rounded()))
        let ox = (side - nw) / 2, oy = (side - nh) / 2

        // Letterbox canvas: ultralytics pads with 114 grey and centres the image; matching that
        // keeps the model on the input distribution it was exported with.
        var canvas = [UInt8](repeating: 114, count: side * side * 4)
        for i in stride(from: 3, to: canvas.count, by: 4) { canvas[i] = 255 }
        var scaled = [UInt8](repeating: 0, count: nw * nh * 4)
        var ok = false
        frame.px.withUnsafeBufferPointer { srcPtr in
            scaled.withUnsafeMutableBufferPointer { dstPtr in
                // vImage's buffer type wants a mutable pointer; the scale never writes to its
                // source, so handing it the frame's own storage avoids copying 8 MB per tile.
                let srcBase = UnsafeMutableRawPointer(mutating: srcPtr.baseAddress!)
                    .advanced(by: (y0 * frame.width + x0) * 4)
                var srcBuf = vImage_Buffer(data: srcBase,
                                           height: vImagePixelCount(ch),
                                           width: vImagePixelCount(cw),
                                           rowBytes: frame.width * 4)
                var dstBuf = vImage_Buffer(data: UnsafeMutableRawPointer(dstPtr.baseAddress!),
                                           height: vImagePixelCount(nh),
                                           width: vImagePixelCount(nw),
                                           rowBytes: nw * 4)
                ok = vImageScale_ARGB8888(&srcBuf, &dstBuf, nil, vImage_Flags(kvImageNoFlags)) == kvImageNoError
            }
        }
        if !ok { return [] }
        for y in 0..<nh {
            let s = y * nw * 4
            let d = ((oy + y) * side + ox) * 4
            canvas.replaceSubrange(d..<(d + nw * 4), with: scaled[s..<(s + nw * 4)])
        }
        let tile = TracerBGRA(width: side, height: side, px: canvas)
        guard let pb = tracerMakePixelBuffer(tile, x0: 0, y0: 0, width: side, height: side) else { return [] }

        let request = VNCoreMLRequest(model: model)
        // The buffer is already exactly the model's input size, so this is the identity.
        request.imageCropAndScaleOption = .scaleFill
        let handler = VNImageRequestHandler(cvPixelBuffer: pb, orientation: .up, options: [:])
        guard (try? handler.perform([request])) != nil,
              let obs = request.results?.compactMap({ $0 as? VNCoreMLFeatureValueObservation }).first,
              let arr = obs.featureValue.multiArrayValue else { return [] }
        return decode(arr, ox: ox, oy: oy, scale: scale, x0: x0, y0: y0)
    }

    /// The export is `nms=False`, so the output is the raw YOLOv8 head: [1, 5, 8400] with rows
    /// cx, cy, w, h, score in INPUT-IMAGE pixels (verified against this .mlpackage on a real
    /// frame — best anchor 302.75, 436.5, 7.5, 7.5 at score 0.745, which maps back onto the
    /// labelled address ball of IMG_3629). One class: golfball.
    private func decode(_ arr: MLMultiArray, ox: Int, oy: Int, scale: Double,
                        x0: Int, y0: Int) -> [TracerYoloDetection] {
        guard arr.shape.count == 3, arr.shape[1].intValue >= 5 else { return [] }
        let anchors = arr.shape[2].intValue
        let s1 = arr.strides[1].intValue
        let s2 = arr.strides[2].intValue
        var out: [TracerYoloDetection] = []
        guard arr.dataType == .float32 else { return [] }
        let ptr = arr.dataPointer.assumingMemoryBound(to: Float32.self)
        for i in 0..<anchors {
            let score = Double(ptr[4 * s1 + i * s2])
            if score < Self.confThreshold { continue }
            let cx = Double(ptr[0 * s1 + i * s2])
            let cy = Double(ptr[1 * s1 + i * s2])
            let bw = Double(ptr[2 * s1 + i * s2])
            let bh = Double(ptr[3 * s1 + i * s2])
            let fx = (cx - Double(ox)) / scale + Double(x0)
            let fy = (cy - Double(oy)) / scale + Double(y0)
            // The lab's radius is the mean half-side of the box: (dx + dy) / 4.
            let r = ((bw + bh) / 4.0) / scale
            if r <= 0 { continue }
            out.append(TracerYoloDetection(x: fx, y: fy, r: r, conf: score))
        }
        return out
    }

    static func nonMaximumSuppression(_ dets: [TracerYoloDetection]) -> [TracerYoloDetection] {
        let sorted = dets.sorted { $0.conf > $1.conf }
        var keep: [TracerYoloDetection] = []
        for d in sorted {
            var suppressed = false
            for k in keep {
                // Boxes are square by construction here (r is the mean half-side).
                let ix = max(0.0, min(d.x + d.r, k.x + k.r) - max(d.x - d.r, k.x - k.r))
                let iy = max(0.0, min(d.y + d.r, k.y + k.r) - max(d.y - d.r, k.y - k.r))
                let inter = ix * iy
                let uni = 4 * d.r * d.r + 4 * k.r * k.r - inter
                if uni > 0 && inter / uni > nmsIoU { suppressed = true; break }
            }
            if !suppressed { keep.append(d) }
            if keep.count >= 300 { break }
        }
        return keep
    }
}

// MARK: - Orchestration (mirrors `lib/detect.py::detect()`)

public enum TracerDetect {

    /// Convenience entry point for the Expo function: options as JSON, result as the
    /// SHARED CONVENTION 2 dictionary.
    public static func detect(assetURL: URL, impactTimeMs: Double, optionsJson: String) -> [String: Any] {
        return detect(assetURL: assetURL, impactTimeMs: impactTimeMs,
                      options: TracerDetectOptions(json: optionsJson))
    }

    /// Detect the ball's first frames of flight. Never throws; a failure is `found: false`
    /// with a reason in `notes`.
    public static func detect(assetURL: URL, impactTimeMs: Double,
                              options: TracerDetectOptions) -> [String: Any] {
        var notes: [String: Any] = [
            "coords": "native px, top-left origin, display-oriented",
            "conf": "heuristic ordinal, uncalibrated, capped 0.7 for r<1.5px"
        ]
        let params = options.params

        guard FileManager.default.fileExists(atPath: assetURL.path) else {
            return failure(reason: "file not found", notes: &notes, fps: 0, width: 0, height: 0,
                           impactFrame: 0)
        }
        let asset = AVURLAsset(url: assetURL)
        guard let track = asset.tracks(withMediaType: .video).first else {
            return failure(reason: "no video track", notes: &notes, fps: 0, width: 0, height: 0,
                           impactFrame: 0)
        }
        let fps = Double(track.nominalFrameRate)
        guard fps > 1 else {
            return failure(reason: "unusable frame rate", notes: &notes, fps: 0, width: 0, height: 0,
                           impactFrame: 0)
        }
        let transform = track.preferredTransform
        let displayRect = CGRect(origin: .zero, size: track.naturalSize).applying(transform)
        let W = Int(abs(displayRect.width).rounded())
        let H = Int(abs(displayRect.height).rounded())
        guard W > 100 && H > 100 else {
            return failure(reason: "unusable frame size", notes: &notes, fps: fps, width: W, height: H,
                           impactFrame: 0)
        }

        let u = Double(W) / 1080.0
        let fr = fps / 30.0
        let q = 1.0 / fr
        let impactSec = impactTimeMs / 1000.0
        let fi = Int(floor(impactSec * fps + 1e-6))

        // Window, in absolute frame indices (the lab's `P` values are 30 fps units).
        let kBg0 = max(0, fi - Int((Double(params.bgStart) * fr).rounded()))
        let kBg1 = fi - Int((Double(params.bgEnd) * fr).rounded())
        let bgStep = max(1, Int((Double(params.bgStep) * fr).rounded()))
        let kA0 = fi - Int((Double(params.preFrames) * fr).rounded())
        var kA1 = fi + Int((Double(params.postFrames) * fr).rounded())
        if params.maxFrames > 0 { kA1 = min(kA1, kA0 + params.maxFrames) }
        guard kBg1 > kBg0, kA0 > kBg1 else {
            return failure(reason: "impact too close to the start of the clip for a background model",
                           notes: &notes, fps: fps, width: W, height: H, impactFrame: fi)
        }
        var addrKs = Set(params.addrFrames.map { fi - Int((Double($0) * fr).rounded()) })
        addrKs = Set(addrKs.filter { $0 >= 0 })
        let sigAll = params.sigmas.map { $0 * u }

        // ------------------------------------------------------------------ pass A
        // Background stack + the frames the static ball is looked for on.
        var bgStack: [PlaneF] = []
        var addressFrames: [(Int, TracerBGRA)] = []
        let tA = CFAbsoluteTimeGetCurrent()
        guard let pumpA = TracerFramePump(asset: asset, track: track,
                                          startFrame: kBg0, endFrame: kA0 - 1, fps: fps) else {
            return failure(reason: "could not open the clip for reading", notes: &notes,
                           fps: fps, width: W, height: H, impactFrame: fi)
        }
        pumpA.forEach { f in
            if f.index <= kBg1 && (f.index - kBg0) % bgStep == 0 {
                bgStack.append(tracerLumaPlane(f.bgra, x0: 0, y0: 0, x1: W, y1: H))
            }
            if addrKs.contains(f.index) { addressFrames.append((f.index, f.bgra)) }
            return true
        }
        guard bgStack.count >= 3 else {
            return failure(reason: "only \(bgStack.count) background frames available",
                           notes: &notes, fps: fps, width: W, height: H, impactFrame: fi)
        }
        guard !addressFrames.isEmpty else {
            return failure(reason: "no address frames decoded", notes: &notes,
                           fps: fps, width: W, height: H, impactFrame: fi)
        }
        addressFrames.sort { $0.0 < $1.0 }
        let addrBGRA = addressFrames.map { $0.1 }
        notes["backgroundFrames"] = bgStack.count
        let bg = medianPlane(bgStack)
        bgStack.removeAll()
        notes["oneOffMsBackground"] = Int((CFAbsoluteTimeGetCurrent() - tA) * 1000)

        // ------------------------------------------------------------------ pose + address
        let tPose = CFAbsoluteTimeGetCurrent()
        var geom: GolferGeometry?
        if params.poseEnabled {
            let poses = addrBGRA.map { TracerVisionPose.pose(in: $0, params: params) }
            geom = tracerGolferGeometry(poses: poses, params: params)
            if geom == nil { notes["pose"] = "no golfer found on the address frames; no body veto" }
        } else {
            notes["pose"] = "disabled by options"
        }
        notes["oneOffMsPoseAddress"] = Int((CFAbsoluteTimeGetCurrent() - tPose) * 1000)
        if let g = geom {
            notes["pose"] = "L=\(Int(g.legLength)) side=\(g.side >= 0 ? "+" : "")\(g.side)"
            notes["poseLegLength"] = Int(g.legLength)
            notes["poseSide"] = g.side
        }

        let tAddr = CFAbsoluteTimeGetCurrent()
        var yoloPerFrame: [[TracerYoloDetection]] = []
        if options.useCoreML {
            let model = TracerBallModel.shared
            if model.available {
                let tiles: [(Int, Int, Int, Int)] = geom.map {
                    tracerAddressROIs(geom: $0, width: W, height: H, params: params)
                } ?? [(Int(0.1 * Double(W)), Int(0.45 * Double(H)), Int(0.9 * Double(W)), Int(0.95 * Double(H)))]
                yoloPerFrame = addrBGRA.map { model.detect(in: $0, tileRegions: tiles) }
                notes["coreml"] = "ok"
                notes["coremlDetections"] = yoloPerFrame.map { $0.count }
            } else {
                notes["coreml"] = "unavailable: \(model.loadError ?? "unknown")"
            }
        } else {
            notes["coreml"] = "disabled by options"
        }

        let cands = tracerAddressCandidates(frames: addrBGRA, yoloPerFrame: yoloPerFrame,
                                            geom: geom, u: u, params: params)
        guard !cands.isEmpty else {
            return failure(reason: "no address candidates", notes: &notes,
                           fps: fps, width: W, height: H, impactFrame: fi)
        }

        // ------------------------------------------------------------------ pass B
        // The departure scan: how each candidate's own disc changes across impact.
        var infos: [AddressInfo] = cands.map { c in
            let (C, rm) = tracerBallContrast(bg: bg, ax: c.x, ay: c.y, r: c.r, u: u)
            return AddressInfo(cand: c, C: C, rMeasured: rm)
        }
        let sk0 = fi + Int((Double(params.departScanLo) * fr).rounded())
        let sk1 = fi + Int((Double(params.departScanHi) * fr).rounded())
        if let pumpB = TracerFramePump(asset: asset, track: track,
                                       startFrame: max(0, sk0), endFrame: sk1, fps: fps) {
            pumpB.forEach { f in
                let luma = tracerLumaPlane(f.bgra, x0: 0, y0: 0, x1: W, y1: H)
                for i in infos.indices {
                    let c = infos[i].cand
                    let rr = max(1.0, 0.7 * c.r)
                    let ya = max(0, Int(c.y - rr)), yb = min(H, Int(c.y + rr + 1))
                    let xa = max(0, Int(c.x - rr)), xb = min(W, Int(c.x + rr + 1))
                    if yb <= ya || xb <= xa { infos[i].series.append((f.index, 0)); continue }
                    var s = 0.0
                    var n = 0
                    for y in ya..<yb {
                        for x in xa..<xb {
                            s += Double(luma.px[y * W + x] - bg.px[y * W + x])
                            n += 1
                        }
                    }
                    infos[i].series.append((f.index, s / Double(max(1, n))))
                }
                return true
            }
        }
        tracerFinishAddressValidation(&infos, impactFrame: fi, fpsRatio: fr, params: params)
        infos.sort { $0.score > $1.score }

        // ------------------------------------------------------------------ address decision
        let top = infos[0]
        // An unambiguous model detection that plainly departs skips the launch validation pass.
        let unambiguous = top.cand.source == "yolo" && top.change >= 0.5 && top.launchFrame != nil
            && (infos.count == 1 || top.score >= 2.0 * infos[1].score)
        var best = top
        if !unambiguous {
            best = pickAddress(infos: infos, asset: asset, track: track, bg: bg, fi: fi, fps: fps,
                               u: u, q: q, W: W, H: H, sigAll: sigAll, params: params)
            notes["addressChosenBy"] = "launch validation among \(infos.count) candidates"
        }
        notes["oneOffMsAddress"] = Int((CFAbsoluteTimeGetCurrent() - tAddr) * 1000)

        let address = best.cand
        let C0 = best.C
        var kLaunch = best.launchFrame
        let r0 = address.source == "yolo" ? address.r : (best.rMeasured ?? address.r)
        notes["addressSource"] = address.source
        notes["addressContrast"] = C0.map { (($0 * 10).rounded() / 10) as Any } ?? NSNull()
        notes["addressPath"] = address.source + (address.inRoi ? "+roi" : "")
            + (address.roiChan.map { "(\($0))" } ?? "")
        notes["addressInRoi"] = address.inRoi
        let addressDict: [String: Any] = ["x": (address.x * 10).rounded() / 10,
                                          "y": (address.y * 10).rounded() / 10,
                                          "r": (r0 * 100).rounded() / 100]

        if C0 == nil || abs(C0!) < 8 { notes["weakAddressContrast"] = true }
        // [detect2] A low-contrast candidate OUTSIDE the pose ROI is not a ball we can vouch for.
        // This single rule removed the lab's one fabricated canopy track (IMG_5521).
        if (C0 == nil || abs(C0!) < params.addrWeakC) && geom != nil && !address.inRoi {
            notes["reason"] = "address refused: weak contrast and outside the pose ROI"
            return assemble(found: false, fps: fps, W: W, H: H, fi: fi, impactUsed: nil,
                            launch: nil, address: addressDict, dets: [], notes: notes, msPerFrame: 0)
        }
        guard let launch = kLaunch else {
            // No departure cue means no launch frame, and wave 3's fallback to a sector search
            // around the given impact is exactly what fabricated a 3-frame track on IMG_3632.
            notes["reason"] = "no persistent departure in impact\(params.departScanLo)..+\(params.departScanHi)"
            return assemble(found: false, fps: fps, W: W, H: H, fi: fi, impactUsed: nil,
                            launch: nil, address: addressDict, dets: [], notes: notes, msPerFrame: 0)
        }
        kLaunch = launch
        let impactUsed = launch - 1
        if abs(Double(impactUsed - fi)) > Double(params.impactFlagFrames) * fr {
            notes["impactCorrected"] = true
            notes["impactCorrectedDetail"] = "departure at f\(launch) puts impact at f\(impactUsed), given f\(fi)"
        } else {
            notes["impactCorrected"] = false
        }

        // ------------------------------------------------------------------ pass D: tracking
        let track_ = TracerTrack(u: u, params: params)
        var prevLuma: PlaneF?
        var skeleton: GolferSkeleton?
        var poseAge = 0
        var nReseed = 0, nSwitch = 0, nVetoSeed = 0, nVetoTrack = 0
        var framesAnalysed = 0
        var procSec = 0.0
        var stopNotes: [String] = []

        if let pumpD = TracerFramePump(asset: asset, track: track,
                                       startFrame: max(0, kA0 - 1), endFrame: kA1, fps: fps) {
            pumpD.forEach { f in
                let k = f.index
                let luma = tracerLumaPlane(f.bgra, x0: 0, y0: 0, x1: W, y1: H)
                if k < kA0 || prevLuma == nil {
                    prevLuma = luma
                    return true
                }
                let t0 = CFAbsoluteTimeGetCurrent()
                let (satur, value) = tracerSaturationValuePlanes(f.bgra, x0: 0, y0: 0, x1: W, y1: H)

                // [detect2 (b)] pose while the track is young. Afterwards the mask is DROPPED,
                // not carried: a stale mask of a golfer mid-follow-through vetoes the wrong pixels.
                if params.poseEnabled, geom != nil {
                    if Double(k - launch) <= Double(params.poseFrames) * fr {
                        if let p = TracerVisionPose.pose(in: f.bgra, params: params) {
                            skeleton = tracerGolferSkeleton(pose: p, legLength: geom!.legLength,
                                                            u: u, params: params)
                            poseAge = 0
                        } else {
                            poseAge += 1
                            if Double(poseAge) > Double(params.poseCarry) * fr { skeleton = nil }
                        }
                    } else {
                        skeleton = nil
                    }
                }

                // Second chance: a seed that died with <= 2 detections inside the re-seed window
                // gets the sector search run once more (the club head over the ball on the
                // departure frame is the typical wrong seed).
                if !track_.alive && track_.n <= 2 && nReseed < params.reseedMax
                    && Double(k - launch) <= Double(params.reseedWindow) * fr {
                    stopNotes.append("re-seeding at f\(k): a \(track_.n)-detection seed died")
                    track_.reset()
                    nReseed += 1
                }

                if !track_.alive {
                    // nothing more to do on this frame
                } else if track_.n == 0 {
                    if k >= launch {
                        let steps = k - launch + 1
                        let (hit, nv) = tracerSectorSearch(
                            luma: luma, bg: bg, prevLuma: prevLuma!, satur: satur, value: value,
                            ax: address.x, ay: address.y, r0: r0, frame: k, impactFrame: fi,
                            steps: steps, u: u, q: q, sigAll: sigAll, thr: params.acceptFirst,
                            skeleton: skeleton, params: params)
                        nVetoSeed += nv
                        if let hit = hit {
                            var det = TracerDetection(frame: k, t: Double(k) / fps, x: hit.x, y: hit.y,
                                                      r: hit.cand.r, score: hit.f, maha: 0, idx: 0)
                            det.snr = hit.cand.snr; det.contrast = hit.cand.contrast
                            det.c2 = hit.cand.c2; det.iso = hit.cand.iso; det.aniso = hit.cand.aniso
                            det.polarity = hit.cand.polarity; det.shift = hit.cand.shift
                            track_.add(det)
                        } else if Double(k - launch) >= 4 * fr {
                            track_.alive = false
                            stopNotes.append("no first detection within 4 frames of launch f\(launch)")
                        }
                    }
                } else {
                    let (step, nv) = tracerTrackFrame(
                        track: track_, luma: luma, bg: bg, prevLuma: prevLuma!,
                        satur: satur, value: value, frame: k, fps: fps,
                        addressX: address.x, addressY: address.y, launchFrame: launch,
                        sigAll: sigAll, u: u, skeleton: skeleton, params: params)
                    nVetoTrack += nv
                    switch step {
                    case .detected:
                        break
                    case .stopped(let why):
                        stopNotes.append("stopped at f\(k): \(why)")
                    case .missed:
                        // An unconfirmed seed is put to a contest before the miss counts: the
                        // departure frame is sometimes the club-over-the-ball frame and sometimes
                        // the first flight frame, and no threshold separates them.
                        var switched = false
                        if track_.n == 1 && Double(k - launch) <= Double(params.reseedWindow) * fr {
                            let (hit, nv2) = tracerSectorSearch(
                                luma: luma, bg: bg, prevLuma: prevLuma!, satur: satur, value: value,
                                ax: address.x, ay: address.y, r0: r0, frame: k, impactFrame: fi,
                                steps: k - launch + 1, u: u, q: q, sigAll: sigAll,
                                thr: params.acceptFirst, skeleton: skeleton, params: params)
                            nVetoSeed += nv2
                            if let hit = hit, hit.f > track_.dets[0].score {
                                stopNotes.append(String(format: "seed switched at f%d: %.2f > %.2f",
                                                        k, hit.f, track_.dets[0].score))
                                track_.reset()
                                nSwitch += 1
                                var det = TracerDetection(frame: k, t: Double(k) / fps, x: hit.x,
                                                          y: hit.y, r: hit.cand.r, score: hit.f,
                                                          maha: 0, idx: 0)
                                det.snr = hit.cand.snr; det.contrast = hit.cand.contrast
                                det.c2 = hit.cand.c2; det.iso = hit.cand.iso
                                det.aniso = hit.cand.aniso; det.polarity = hit.cand.polarity
                                det.shift = hit.cand.shift
                                track_.add(det)
                                switched = true
                            }
                        }
                        if !switched, let why = tracerRegisterMiss(track: track_, params: params) {
                            stopNotes.append("stopped at f\(k): \(why)")
                        }
                    }
                }
                procSec += CFAbsoluteTimeGetCurrent() - t0
                framesAnalysed += 1
                prevLuma = luma
                return true
            }
        }

        // ------------------------------------------------------------------ emission
        let emission = tracerApplyEmissionRule(track_.dets, u: u, params: params)
        notes["trackDetections"] = track_.dets.count
        notes["trackConfMean"] = (emission.confMean * 100).rounded() / 100
        notes["reseeds"] = nReseed
        notes["seedSwitches"] = nSwitch
        notes["poseVetoesSeed"] = nVetoSeed
        notes["poseVetoesTrack"] = nVetoTrack
        notes["framesAnalysed"] = framesAnalysed
        notes["rhoFinal"] = (track_.rho * 100).rounded() / 100
        if !stopNotes.isEmpty && options.verbose { notes["trackLog"] = stopNotes }
        if emission.suppressed {
            notes["reason"] = "track of \(track_.dets.count) detection(s), mean conf "
                + String(format: "%.2f", emission.confMean)
                + ", suppressed (minTrackEmit=\(params.minTrackEmit), confFloor=\(params.confFloor))"
        } else if emission.detections.isEmpty {
            notes["reason"] = stopNotes.last ?? "no detections"
        }
        let ms = framesAnalysed > 0 ? (procSec * 1000.0 / Double(framesAnalysed)) : 0

        // The typed outcome is the decision; the dictionary is a rendering of it. Keeping the
        // enum on the path (rather than beside it) means a Swift caller and the JS caller can
        // never disagree about whether a run succeeded.
        let outcome: TracerDetectResult = emission.detections.isEmpty
            ? .none(reason: (notes["reason"] as? String) ?? "no detections")
            : .ok(TracerDetectPayload(address: (x: address.x, y: address.y, r: r0),
                                      launchFrame: launch, impactFrameUsed: impactUsed,
                                      detections: emission.detections, confMean: emission.confMean))
        switch outcome {
        case .none(let reason):
            notes["reason"] = reason
            return assemble(found: false, fps: fps, W: W, H: H, fi: fi, impactUsed: impactUsed,
                            launch: launch, address: addressDict, dets: [], notes: notes,
                            msPerFrame: (ms * 100).rounded() / 100)
        case .ok(let payload):
            let detDicts: [[String: Any]] = payload.detections.map {
                ["frame": $0.frame,
                 "t": ($0.t * 10000).rounded() / 10000,
                 "x": ($0.x * 10).rounded() / 10,
                 "y": ($0.y * 10).rounded() / 10,
                 "r": ($0.r * 100).rounded() / 100,
                 "conf": ($0.conf * 1000).rounded() / 1000]
            }
            return assemble(found: true, fps: fps, W: W, H: H, fi: fi,
                            impactUsed: payload.impactFrameUsed, launch: payload.launchFrame,
                            address: ["x": (payload.address.x * 10).rounded() / 10,
                                      "y": (payload.address.y * 10).rounded() / 10,
                                      "r": (payload.address.r * 100).rounded() / 100],
                            dets: detDicts, notes: notes, msPerFrame: (ms * 100).rounded() / 100)
        }
    }

    // MARK: helpers

    /// [det-bg-kalman] Per-pixel median over the background frames. A median, not a mean, so a
    /// club, a shadow or another player crossing the frame during the pre-impact second does not
    /// smear into the model the ball is later measured against.
    static func medianPlane(_ stack: [PlaneF]) -> PlaneF {
        guard let first = stack.first else { return PlaneF(width: 0, height: 0) }
        let n = stack.count
        var out = PlaneF(width: first.width, height: first.height)
        var buf = [Float](repeating: 0, count: n)
        for i in 0..<(first.width * first.height) {
            for j in 0..<n { buf[j] = stack[j].px[i] }
            // Insertion sort: n is ~9, and this avoids allocating a sorted copy per pixel.
            for a in 1..<n {
                let v = buf[a]
                var b = a - 1
                while b >= 0 && buf[b] > v { buf[b + 1] = buf[b]; b -= 1 }
                buf[b + 1] = v
            }
            out.px[i] = n % 2 == 1 ? buf[n / 2] : 0.5 * (buf[n / 2 - 1] + buf[n / 2])
        }
        return out
    }

    /// [det-bg-kalman] Among the top validated candidates, keep the one from which a ball
    /// actually launches: run the sector search from each over impact-1..impact+3 and take the
    /// best. Only candidates WITH a departure are eligible — a patch already changed before the
    /// scan window is the golfer's shadow or the club at address, not a ball that left.
    static func pickAddress(infos: [AddressInfo], asset: AVURLAsset, track: AVAssetTrack,
                            bg: PlaneF, fi: Int, fps: Double, u: Double, q: Double,
                            W: Int, H: Int, sigAll: [Double], params: TracerParams) -> AddressInfo {
        let fr = fps / 30.0
        let dep = infos.filter { $0.launchFrame != nil }
        var top = dep.filter { $0.cand.source == "yolo" || $0.change > 0.3 }
        if top.count > 4 { top = Array(top.prefix(4)) }
        if top.isEmpty { top = Array((dep.isEmpty ? infos : dep).prefix(2)) }
        guard let anchor = top.first else { return infos[0] }

        let k0 = fi - Int((1 * fr).rounded())
        let k1 = fi + Int((3 * fr).rounded())
        var results = [Double](repeating: 0, count: top.count)
        var prevLuma: PlaneF?
        if let pump = TracerFramePump(asset: asset, track: track,
                                      startFrame: max(0, k0 - 1), endFrame: k1 + 1, fps: fps) {
            pump.forEach { f in
                let luma = tracerLumaPlane(f.bgra, x0: 0, y0: 0, x1: W, y1: H)
                if let prev = prevLuma, f.index >= k0 {
                    let (satur, value) = tracerSaturationValuePlanes(f.bgra, x0: 0, y0: 0, x1: W, y1: H)
                    for (i, it) in top.enumerated() {
                        let c = it.cand
                        let r0 = c.source == "yolo" ? c.r : (it.rMeasured ?? c.r)
                        let kl = it.launchFrame ?? fi
                        if f.index < kl { continue }
                        let (hit, _) = tracerSectorSearch(
                            luma: luma, bg: bg, prevLuma: prev, satur: satur, value: value,
                            ax: c.x, ay: c.y, r0: r0, frame: f.index, impactFrame: fi,
                            steps: f.index - kl + 1, u: u, q: q, sigAll: sigAll, thr: 0.0,
                            skeleton: nil, params: params)
                        if let hit = hit { results[i] = max(results[i], hit.f) }
                    }
                }
                prevLuma = luma
                return true
            }
        }
        var bestIdx = 0
        var bestVal = -1.0
        for (i, it) in top.enumerated() {
            let val = results[i] * (0.5 + 0.5 * min(1.0, it.score / max(1e-6, anchor.score)))
            if val > bestVal { bestVal = val; bestIdx = i }
        }
        // If even the winner never produced a plausible first step, fall back to the highest
        // validation score rather than to a candidate a weak search happened to prefer.
        if results[bestIdx] < params.acceptFirst { bestIdx = 0 }
        return top[bestIdx]
    }

    static func failure(reason: String, notes: inout [String: Any], fps: Double,
                        width: Int, height: Int, impactFrame: Int) -> [String: Any] {
        notes["reason"] = reason
        return assemble(found: false, fps: fps, W: width, H: height, fi: impactFrame,
                        impactUsed: nil, launch: nil, address: nil, dets: [], notes: notes,
                        msPerFrame: 0)
    }

    static func assemble(found: Bool, fps: Double, W: Int, H: Int, fi: Int, impactUsed: Int?,
                         launch: Int?, address: [String: Any]?, dets: [[String: Any]],
                         notes: [String: Any], msPerFrame: Double) -> [String: Any] {
        // Optionals are unwrapped explicitly into NSNull rather than with `as Any? ?? NSNull()`:
        // bridging an Optional through `Any?` keeps the nil WRAPPED, so the coalesce never fires
        // and JS sees something other than null. Same shape as `resolveBallLaunch` next door.
        var payload: [String: Any] = [
            "found": found,
            "method": found ? "blob-kalman" : "none",
            "fps": fps,
            "width": W,
            "height": H,
            "impactFrameGiven": fi,
            "detections": dets,
            "notes": notes,
            "msPerFrame": msPerFrame
        ]
        payload["impactFrameUsed"] = impactUsed.map { $0 as Any } ?? NSNull()
        payload["launchFrame"] = launch.map { $0 as Any } ?? NSNull()
        payload["address"] = address.map { $0 as Any } ?? NSNull()
        return payload
    }
}
