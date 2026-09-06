//
//  TracerDetectCore.swift
//  Tracer V3 — the ball-launch detector's ALGORITHM, with no I/O and no frameworks
//  beyond Accelerate. Deliberately free of `import ExpoModulesCore`, Vision, Core ML
//  and AVFoundation so it can be typechecked and unit-run outside an Xcode project
//  (there is no `pod install` in this checkout — see docs/tracer-v3/native-detect.md).
//
//  PROVENANCE. This is a port of `~/projects/clippar/tracer-lab/lib/detect.py` at the
//  wave-4 final state (= experiments/detect2/detect_final.py), which itself is a port of
//  the wave-1 `det-bg-kalman` detector with the wave-2 judge's changes and the wave-4
//  `detect2` changes. Measured there (experiments/detect2/report.md §9):
//    183/247 matched on the 8 labelled clips, 0 false positives, first-12 93/103;
//    20/20 lock-on under a +/-3-frame impact error, 0 fabricated tracks;
//    tracks on 5 of 11 unseen airborne shots, 66 detections of which 65 correct;
//    ONE clearly wrong output (3 detections on IMG_2329, a topped shot that must stay silent).
//  Nothing here is new science. Every constant in `TracerParams` is traced line by line to
//  the lab's `P` dict in the report; where a value or a method had to change for iOS it says
//  so in a `PORT:` comment at the site, and the report carries the same list.
//
//  COORDINATES. Everything in this file is in DISPLAY-ORIENTED PIXELS with a TOP-LEFT
//  origin (x right, y down) — identical to the lab. The normalized bottom-left render spec
//  is produced in TypeScript (`lib/tracerV3.ts`); no conversion happens here or in the
//  driver. Pixel constants are in 1080p units and scaled by `u = width / 1080`; per-frame
//  constants are in 30 fps units and scaled by `fr = fps / 30`.
//
//  WHY A PORT AND NOT A REWRITE. The lab's numbers are the only evidence this detector
//  works, and they belong to this exact arrangement of thresholds. A "cleaner" formulation
//  would have no measured recall behind it, and the failure mode the lab spent a whole wave
//  removing — a fabricated arc over a shot that never flew — is invisible until it reaches
//  a real round. So the structure follows the Python function for function, including the
//  parts that look redundant.
//
import Foundation
import Accelerate

// MARK: - Parameters (the lab's `P` dict)

/// Every tuned constant, in one place, so a transcription error is visible in one screen.
/// Names are the lab's, camel-cased. Values are the lab's `P` at wave-4 final.
/// Anything the lab carries but this port does NOT is listed at the bottom with the reason.
public struct TracerParams {
    // Analysis window, in 30 fps frames relative to the GIVEN impact frame.
    public var preFrames = 3
    public var postFrames = 45
    // Background model: frames [impact-30, impact-6] every 3rd, per-pixel median.
    public var bgStart = 30
    public var bgEnd = 6
    public var bgStep = 3
    // Frames before impact on which the static ball is looked for.
    public var addrFrames = [24, 15, 6]

    // Multi-scale DoG.
    public var sigmas: [Double] = [1.0, 1.35, 1.8, 2.4, 3.2, 4.3, 5.7, 7.6]
    public var dogK = 1.6
    /// DoG response (grey levels) a pixel needs to be a candidate at all.
    public var peakThr = 4.0

    // Launch sector above the address ball.
    public var sectorDistMin = 25.0
    public var sectorDistMax = 520.0
    public var sectorHalfAngleDeg = 65.0
    /// Second step, in units of the (phase-scaled) first step.
    public var step2AlongLo = 0.4
    public var step2AlongHi = 5.0

    public var acceptScore = 0.22
    public var acceptFirst = 0.35
    public var maxMissEarly = 3
    public var maxMissLate = 5
    /// Stop when the predicted radius (1080p px) falls below this.
    public var minRadius = 0.7
    /// |patch change| / ball contrast that counts as "changed".
    public var departFrac = 0.45

    // Emission rule (judge B.1 change 2 + detect2 step 1).
    public var minTrackEmit = 3
    public var confFloor = 0.4

    // |d| centroid refinement (judge B.1 change 1).
    public var refineFrac = 0.3
    public var refine = true

    // Kalman process noise. `youngVelNoise` was set AFTER seeing hold-out IMG_3622, so the
    // hold-out is not clean for it — the lab says so and so does this comment.
    public var youngVelNoise = 0.35
    public var velNoise = 0.18
    // Hard consecutive-frame motion requirement while the track is young and fast.
    public var motionYoungN = 6
    public var motionMinStepR = 3.0

    // detect2 (f): the departure cue defines the launch frame.
    public var departScanLo = -4
    public var departScanHi = 6
    public var departPersist = 2
    public var impactFlagFrames = 2
    /// After the departure step the series must stay within this x |step| of the post-step
    /// value: a ball leaves once, a shadow edge crossing the disc ramps on.
    public var departDriftMax = 1.5

    // detect2 (f, cont.): one second-chance re-seed, and the first-step size gate.
    public var reseedMax = 1
    public var reseedWindow = 6
    public var seedRMax = 1.3

    // detect2 (b): pose skeleton veto. NOT a convex hull — the hull killed IMG_3652 in the lab.
    public var poseEnabled = true
    public var poseConf = 0.25
    public var kpConf = 0.3
    public var poseFrames = 8
    public var poseCarry = 8
    public var limbFrac = 0.10
    public var headFrac = 0.22
    public var handFrac = 0.13
    public var vetoMargin = 8.0
    public var vetoHardN = 3

    // detect2 (a): pose-seeded, colour-agnostic address ROI.
    public var roiDxLo = 0.2
    public var roiDxHi = 1.6
    public var roiDy = 0.45
    public var rExpFrac = 0.024
    public var roiPresenceFrac = 0.3
    public var roiInsideFactor = 1.2
    public var roiOutsideFactor = 0.6

    // detect2 (d): exposure-shift-immune seeding.
    public var localBg = true
    public var localBgScale = 4
    public var localBgK = 13
    public var seedPolarities = [1, -1]

    // detect2 (c): seed crowd penalty. MEASURED AND REJECTED in the lab (k=0.1 cost IMG_3640
    // its whole track, 183 -> 179). It ships OFF at k=0 exactly as in the lab so the
    // measurement can be repeated without re-deriving the code.
    public var crowdRadius = 40.0
    public var crowdK = 0.0
    public var crowdRel = 0.5

    /// An address with |contrast| below this AND outside the pose ROI is refused outright.
    /// This one rule is what removed the lab's IMG_5521 fabricated canopy track.
    public var addrWeakC = 8.0

    // ---- Driver-side budget, not part of the lab's P ----
    /// PORT: hard ceiling on frames decoded, so a corrupt or very long asset cannot pin the
    /// CPU. 0 = no ceiling. The lab has no equivalent because it reads a fixed window.
    public var maxFrames = 0

    // NOT PORTED, and why:
    //  * golfer_veto / golfer_mode / golfer_min_height / golfer_margin / golfer_head_frac /
    //    golfer_carry / golfer_scale — the wave-1 convex-hull/silhouette veto. The lab ships it
    //    OFF (`P["golfer_veto"]=False`) having measured it removing one correct frame and zero
    //    wrong ones; the pose skeleton veto above replaced it. Porting dead-and-disabled code
    //    would be 120 lines nothing calls.
    //  * accept_score_nodepart — unused since detect2 step 1 removed the no-departure fallback.
    //  * pose_imgsz — a yolov8n-pose input size. Vision's VNDetectHumanBodyPoseRequest has no
    //    equivalent knob.
    public init() {}
}

// MARK: - Planes

/// A single-channel float image, row-major, top-left origin. The working type for every
/// difference map. `Float` (not `Double`) to match the lab's float32 maps and to stay in
/// vDSP's native type.
public struct PlaneF {
    public var width: Int
    public var height: Int
    public var px: [Float]

    public init(width: Int, height: Int, value: Float = 0) {
        self.width = width
        self.height = height
        self.px = [Float](repeating: value, count: max(0, width * height))
    }

    public init(width: Int, height: Int, px: [Float]) {
        self.width = width
        self.height = height
        self.px = px
    }

    @inline(__always) public func at(_ x: Int, _ y: Int) -> Float {
        return px[y * width + x]
    }

    @inline(__always) public mutating func set(_ x: Int, _ y: Int, _ v: Float) {
        px[y * width + x] = v
    }

    /// Sub-rectangle copy. Bounds are clamped by the caller; this trusts them.
    public func crop(x0: Int, y0: Int, x1: Int, y1: Int) -> PlaneF {
        let w = x1 - x0, h = y1 - y0
        var out = PlaneF(width: w, height: h)
        if w <= 0 || h <= 0 { return out }
        for y in 0..<h {
            let src = (y0 + y) * width + x0
            let dst = y * w
            out.px.replaceSubrange(dst..<(dst + w), with: px[src..<(src + w)])
        }
        return out
    }
}

/// A single-channel 8-bit image (HSV saturation / value planes, and the median-blur input).
public struct PlaneU8 {
    public var width: Int
    public var height: Int
    public var px: [UInt8]

    public init(width: Int, height: Int, value: UInt8 = 0) {
        self.width = width
        self.height = height
        self.px = [UInt8](repeating: value, count: max(0, width * height))
    }

    public init(width: Int, height: Int, px: [UInt8]) {
        self.width = width
        self.height = height
        self.px = px
    }

    @inline(__always) public func at(_ x: Int, _ y: Int) -> UInt8 {
        return px[y * width + x]
    }
}

// MARK: - Scalar helpers (lab `_soft`, `_f_size`, `_sigmoid`)

@inline(__always)
public func tracerSoft(_ x: Double, _ lo: Double, _ hi: Double) -> Double {
    return min(1.0, max(0.0, (x - lo) / (hi - lo)))
}

@inline(__always)
public func tracerFSize(_ r: Double, _ rPred: Double, _ sigLn: Double) -> Double {
    let a = log(max(r, 1e-3) / max(rPred, 1e-3))
    return exp(-(a * a) / (2 * sigLn * sigLn))
}

@inline(__always)
public func tracerSigmoid(_ z: Double) -> Double {
    return 1.0 / (1.0 + exp(-z))
}

/// Median of a small array. Matches numpy's `median` (mean of the two middle values on
/// an even count), which the lab relies on for the 2-element `r_pred` case.
public func tracerMedian(_ v: [Double]) -> Double {
    if v.isEmpty { return 0 }
    let s = v.sorted()
    let n = s.count
    if n % 2 == 1 { return s[n / 2] }
    return 0.5 * (s[n / 2 - 1] + s[n / 2])
}

public func tracerMedian(_ v: [Float]) -> Float {
    if v.isEmpty { return 0 }
    var s = v
    s.sort()
    let n = s.count
    if n % 2 == 1 { return s[n / 2] }
    return 0.5 * (s[n / 2 - 1] + s[n / 2])
}

// MARK: - Image operations

/// OpenCV `cv2.getGaussianKernel` for an explicit sigma, with OpenCV's implicit kernel size
/// for a float image: `ksize = round(sigma * 4 * 2 + 1) | 1`. Getting this wrong shifts every
/// DoG response, so it is derived here rather than guessed.
public func tracerGaussianKernel(sigma: Double) -> [Float] {
    let s = max(sigma, 1e-6)
    var k = Int((s * 8.0 + 1.0).rounded())
    k |= 1
    if k < 3 { k = 3 }
    let c = (k - 1) / 2
    var w = [Float](repeating: 0, count: k)
    var sum = 0.0
    for i in 0..<k {
        let d = Double(i - c)
        let v = exp(-(d * d) / (2 * s * s))
        w[i] = Float(v)
        sum += v
    }
    let inv = Float(1.0 / sum)
    for i in 0..<k { w[i] *= inv }
    return w
}

/// BORDER_REFLECT_101 index mapping (OpenCV's GaussianBlur default): the border pixel itself
/// is not repeated, so `-1 -> 1` and `n -> n-2`. Loops because a very small plane can need
/// several folds.
@inline(__always)
func tracerReflect101(_ i: Int, _ n: Int) -> Int {
    if n == 1 { return 0 }
    var v = i
    while v < 0 || v >= n {
        if v < 0 { v = -v }
        if v >= n { v = 2 * n - 2 - v }
    }
    return v
}

/// Separable Gaussian blur with BORDER_REFLECT_101, i.e. `cv2.GaussianBlur(src, (0,0), sigma)`
/// on a float image. Horizontal pass then vertical, as OpenCV does.
///
/// The inner loop is one `vDSP_vsma` per kernel tap over a whole row rather than a scalar
/// multiply-accumulate per pixel: the sector search blurs a ~1 Mpx region at up to six scales
/// in both polarities, and the scalar form is roughly an order of magnitude too slow for that.
public func tracerGaussianBlur(_ src: PlaneF, sigma: Double) -> PlaneF {
    let w = src.width, h = src.height
    if w <= 0 || h <= 0 { return src }
    let k = tracerGaussianKernel(sigma: sigma)
    let ks = k.count
    let c = (ks - 1) / 2
    var mid = PlaneF(width: w, height: h)
    var out = PlaneF(width: w, height: h)

    // --- horizontal ---
    // Each row is copied into a padded scratch buffer with reflect-101 edges so every tap is
    // a contiguous, unbranched vector add.
    var padded = [Float](repeating: 0, count: w + 2 * c)
    for y in 0..<h {
        let rowBase = y * w
        for i in 0..<c { padded[i] = src.px[rowBase + tracerReflect101(i - c, w)] }
        for x in 0..<w { padded[c + x] = src.px[rowBase + x] }
        for i in 0..<c { padded[c + w + i] = src.px[rowBase + tracerReflect101(w + i, w)] }
        mid.px.withUnsafeMutableBufferPointer { dst in
            padded.withUnsafeBufferPointer { pad in
                let d = dst.baseAddress! + rowBase
                for t in 0..<ks {
                    var wt = k[t]
                    if wt == 0 { continue }
                    vDSP_vsma(pad.baseAddress! + t, 1, &wt, d, 1, d, 1, vDSP_Length(w))
                }
            }
        }
    }

    // --- vertical ---
    // Rows are already contiguous, so the reflect happens on the row index only.
    mid.px.withUnsafeBufferPointer { srcBuf in
        out.px.withUnsafeMutableBufferPointer { dstBuf in
            for y in 0..<h {
                let d = dstBuf.baseAddress! + y * w
                for t in 0..<ks {
                    var wt = k[t]
                    if wt == 0 { continue }
                    let sy = tracerReflect101(y + t - c, h)
                    vDSP_vsma(srcBuf.baseAddress! + sy * w, 1, &wt, d, 1, d, 1, vDSP_Length(w))
                }
            }
        }
    }
    return out
}

/// `cv2.dilate(src, np.ones((k, k)))` — a rectangular max filter with the anchor at the
/// centre and OpenCV's implicit -inf border, computed as two O(n) van-Herk/Gil-Werman passes.
/// Used only to find strict local maxima (`best >= dilate(best)`), so the border convention
/// matters only for peaks sitting on the very edge of the ROI.
public func tracerDilateRect(_ src: PlaneF, k: Int) -> PlaneF {
    let w = src.width, h = src.height
    if k <= 1 || w <= 0 || h <= 0 { return src }
    let r = k / 2
    var mid = PlaneF(width: w, height: h)
    var out = PlaneF(width: w, height: h)
    var line = [Float](repeating: 0, count: max(w, h))
    var deqIdx = [Int](repeating: 0, count: max(w, h))

    @inline(__always)
    func maxFilter1D(_ input: inout [Float], _ n: Int, _ output: inout [Float]) {
        // Monotonic deque: output[i] = max(input[i-r ... i+r]) clipped to [0, n).
        var head = 0, tail = 0
        var next = 0
        for i in 0..<n {
            let hi = min(n - 1, i + r)
            while next <= hi {
                while tail > head && input[deqIdx[tail - 1]] <= input[next] { tail -= 1 }
                deqIdx[tail] = next
                tail += 1
                next += 1
            }
            let lo = i - r
            while head < tail && deqIdx[head] < lo { head += 1 }
            output[i] = input[deqIdx[head]]
        }
    }

    // rows
    var rowIn = [Float](repeating: 0, count: w)
    for y in 0..<h {
        for x in 0..<w { rowIn[x] = src.px[y * w + x] }
        maxFilter1D(&rowIn, w, &line)
        for x in 0..<w { mid.px[y * w + x] = line[x] }
    }
    // columns
    var colIn = [Float](repeating: 0, count: h)
    for x in 0..<w {
        for y in 0..<h { colIn[y] = mid.px[y * w + x] }
        maxFilter1D(&colIn, h, &line)
        for y in 0..<h { out.px[y * w + x] = line[y] }
    }
    return out
}

/// `cv2.medianBlur(src8u, k)` with BORDER_REPLICATE (OpenCV's convention for medianBlur),
/// as a sliding-window 256-bin histogram (Huang). Exact, and O(k) per pixel rather than
/// O(k^2 log k) — the address finder uses k up to 151.
public func tracerMedianBlurU8(_ src: PlaneU8, k: Int) -> PlaneU8 {
    let w = src.width, h = src.height
    let ks = k | 1
    if ks < 3 || w <= 0 || h <= 0 { return src }
    // No clamp on ks against the plane size: BORDER_REPLICATE is well defined for any window,
    // and shrinking the kernel near a small ROI would silently change the filter (caught by the
    // brute-force cross-check in docs/tracer-v3/tracer-detect-core-check.swift).
    let r = ks / 2
    var out = PlaneU8(width: w, height: h)
    let half = (ks * ks) / 2   // the (n/2)-th smallest, 0-based — OpenCV's median for odd n^2
    // Two-level histogram (Huang's coarse/fine): the median scan is 16 + 16 buckets instead of
    // up to 256. Exactly the same answer; it matters because the address finder runs this at
    // k = 59 over a whole ROI and the local-offset map runs it on every analysed frame.
    var coarse = [Int](repeating: 0, count: 16)
    var fine = [Int](repeating: 0, count: 256)

    @inline(__always)
    func clampIdx(_ i: Int, _ n: Int) -> Int { return i < 0 ? 0 : (i >= n ? n - 1 : i) }

    for y in 0..<h {
        // Rebuild at the start of every row (O(k^2) per row, amortised O(k) per pixel).
        for i in 0..<16 { coarse[i] = 0 }
        for i in 0..<256 { fine[i] = 0 }
        for dy in -r...r {
            let sy = clampIdx(y + dy, h)
            for dx in -r...r {
                let v = Int(src.px[sy * w + clampIdx(dx, w)])
                fine[v] += 1
                coarse[v >> 4] += 1
            }
        }
        for x in 0..<w {
            if x > 0 {
                // slide right: drop column x-1-r, add column x+r
                let dropX = clampIdx(x - 1 - r, w)
                let addX = clampIdx(x + r, w)
                for dy in -r...r {
                    let sy = clampIdx(y + dy, h)
                    let a = Int(src.px[sy * w + dropX])
                    fine[a] -= 1
                    coarse[a >> 4] -= 1
                    let b = Int(src.px[sy * w + addX])
                    fine[b] += 1
                    coarse[b >> 4] += 1
                }
            }
            var acc = 0
            var bucket = 0
            while bucket < 15 {
                if acc + coarse[bucket] > half { break }
                acc += coarse[bucket]
                bucket += 1
            }
            var v = bucket << 4
            let end = v + 16
            while v < end - 1 {
                acc += fine[v]
                if acc > half { break }
                v += 1
            }
            if v == end - 1 { acc += fine[v] }
            out.px[y * w + x] = UInt8(min(255, v))
        }
    }
    return out
}

/// `cv2.resize(..., interpolation=cv2.INTER_AREA)` for a downscale: every destination pixel is
/// the area-weighted mean of the source interval it covers. Used by the local-offset map only.
public func tracerResizeArea(_ src: PlaneF, toWidth: Int, toHeight: Int) -> PlaneF {
    let w = src.width, h = src.height
    let dw = max(1, toWidth), dh = max(1, toHeight)
    var out = PlaneF(width: dw, height: dh)
    if w <= 0 || h <= 0 { return out }
    let sx = Double(w) / Double(dw)
    let sy = Double(h) / Double(dh)
    for oy in 0..<dh {
        let y0 = Double(oy) * sy
        let y1 = min(Double(h), y0 + sy)
        let iy0 = Int(floor(y0)), iy1 = min(h - 1, Int(ceil(y1)) - 1)
        for ox in 0..<dw {
            let x0 = Double(ox) * sx
            let x1 = min(Double(w), x0 + sx)
            let ix0 = Int(floor(x0)), ix1 = min(w - 1, Int(ceil(x1)) - 1)
            var acc = 0.0
            var wsum = 0.0
            var yy = iy0
            while yy <= iy1 {
                let wy = min(Double(yy + 1), y1) - max(Double(yy), y0)
                if wy > 0 {
                    var xx = ix0
                    while xx <= ix1 {
                        let wx = min(Double(xx + 1), x1) - max(Double(xx), x0)
                        if wx > 0 {
                            acc += Double(src.px[yy * w + xx]) * wx * wy
                            wsum += wx * wy
                        }
                        xx += 1
                    }
                }
                yy += 1
            }
            out.px[oy * dw + ox] = wsum > 0 ? Float(acc / wsum) : 0
        }
    }
    return out
}

/// `cv2.resize(..., interpolation=cv2.INTER_LINEAR)` with OpenCV's half-pixel centre
/// convention (`src = (dst + 0.5) * scale - 0.5`) and replicated edges.
public func tracerResizeBilinear(_ src: PlaneF, toWidth: Int, toHeight: Int) -> PlaneF {
    let w = src.width, h = src.height
    let dw = max(1, toWidth), dh = max(1, toHeight)
    var out = PlaneF(width: dw, height: dh)
    if w <= 0 || h <= 0 { return out }
    let sx = Double(w) / Double(dw)
    let sy = Double(h) / Double(dh)
    for oy in 0..<dh {
        var fy = (Double(oy) + 0.5) * sy - 0.5
        if fy < 0 { fy = 0 }
        if fy > Double(h - 1) { fy = Double(h - 1) }
        let y0 = Int(floor(fy))
        let y1 = min(h - 1, y0 + 1)
        let ty = Float(fy - Double(y0))
        for ox in 0..<dw {
            var fx = (Double(ox) + 0.5) * sx - 0.5
            if fx < 0 { fx = 0 }
            if fx > Double(w - 1) { fx = Double(w - 1) }
            let x0 = Int(floor(fx))
            let x1 = min(w - 1, x0 + 1)
            let tx = Float(fx - Double(x0))
            let a = src.px[y0 * w + x0], b = src.px[y0 * w + x1]
            let c = src.px[y1 * w + x0], d = src.px[y1 * w + x1]
            let top = a + (b - a) * tx
            let bot = c + (d - c) * tx
            out.px[oy * dw + ox] = top + (bot - top) * ty
        }
    }
    return out
}

// MARK: - Connected components (8-connectivity)

/// Minimal replacement for `cv2.connectedComponentsWithStats` on a small binary patch.
/// Labels are 1-based; label 0 is background. Only what `_radius_halfmax` reads is kept.
public struct TracerComponents {
    public var labels: [Int32]          // width*height, 0 = background
    public var count: Int               // number of foreground components
    public var area: [Int]              // index 0 unused
    public var centroidX: [Double]
    public var centroidY: [Double]
}

public func tracerConnectedComponents(_ mask: [Bool], width: Int, height: Int) -> TracerComponents {
    var labels = [Int32](repeating: 0, count: max(0, width * height))
    var area: [Int] = [0]
    var cx: [Double] = [0]
    var cy: [Double] = [0]
    var next: Int32 = 0
    var stack: [Int] = []
    stack.reserveCapacity(64)
    for y in 0..<height {
        for x in 0..<width {
            let i = y * width + x
            if !mask[i] || labels[i] != 0 { continue }
            next += 1
            var a = 0
            var sx = 0.0, sy = 0.0
            labels[i] = next
            stack.removeAll(keepingCapacity: true)
            stack.append(i)
            while let cur = stack.popLast() {
                let py = cur / width, px = cur % width
                a += 1
                sx += Double(px)
                sy += Double(py)
                var dy = -1
                while dy <= 1 {
                    var dx = -1
                    while dx <= 1 {
                        if dx != 0 || dy != 0 {
                            let ny = py + dy, nx = px + dx
                            if ny >= 0, ny < height, nx >= 0, nx < width {
                                let j = ny * width + nx
                                if mask[j] && labels[j] == 0 {
                                    labels[j] = next
                                    stack.append(j)
                                }
                            }
                        }
                        dx += 1
                    }
                    dy += 1
                }
            }
            area.append(a)
            cx.append(sx / Double(a))
            cy.append(sy / Double(a))
        }
    }
    return TracerComponents(labels: labels, count: Int(next), area: area, centroidX: cx, centroidY: cy)
}

// MARK: - Blob primitives (lab `_radius_halfmax`, `_refine_abs_centroid`, `_local_offset`)

/// Result of `_radius_halfmax`: radius from the area above half the peak contrast, plus the
/// shape/contrast features the scorers read.
public struct TracerHalfMax {
    public var r: Double
    public var contrast: Double
    public var aniso: Double
    public var cxOffset: Double
    public var cyOffset: Double
}

/// [det-bg-kalman] Radius from the area above half of the peak contrast in a positive-part
/// difference patch, with the component's anisotropy and intensity-weighted centre offset.
/// `dp` is the POSITIVE PART of `polarity * d` — never the DoG response and never the raw frame.
public func tracerRadiusHalfMax(dp: PlaneF, cx: Int, cy: Int, sigma: Double, u: Double) -> TracerHalfMax? {
    let R = Int(3 * sigma + 3 * u)
    let y0 = max(0, cy - R), y1 = min(dp.height, cy + R + 1)
    let x0 = max(0, cx - R), x1 = min(dp.width, cx + R + 1)
    if y1 - y0 <= 0 || x1 - x0 <= 0 { return nil }
    let patch = dp.crop(x0: x0, y0: y0, x1: x1, y1: y1)
    let pw = patch.width, ph = patch.height
    let sm = tracerGaussianBlur(patch, sigma: max(0.7, 0.35 * sigma))
    let c = cy - y0, d = cx - x0
    let rGuess = 1.75 * sigma
    let innerR = max(1.0, 0.8 * rGuess)

    var innerSum = 0.0
    var innerN = 0
    for y in 0..<ph {
        let dy = Double(y - c)
        for x in 0..<pw {
            let dx = Double(x - d)
            if (dx * dx + dy * dy).squareRoot() <= innerR {
                innerSum += Double(sm.px[y * pw + x])
                innerN += 1
            }
        }
    }
    if innerN == 0 { return nil }
    let level = innerSum / Double(innerN)
    if level <= 0 { return nil }

    var mask = [Bool](repeating: false, count: pw * ph)
    let cut = Float(0.5 * level)
    for i in 0..<(pw * ph) { mask[i] = sm.px[i] >= cut }
    let cc = tracerConnectedComponents(mask, width: pw, height: ph)
    if cc.count == 0 { return nil }

    // OpenCV reads the label under the peak; when that is background it falls back to the
    // component whose CENTROID is nearest the peak (not the nearest pixel) — keep that.
    var li = Int(cc.labels[min(c, ph - 1) * pw + min(d, pw - 1)])
    if li == 0 {
        var bestD = Double.greatestFiniteMagnitude
        for i in 1...cc.count {
            let dx = cc.centroidX[i] - Double(d)
            let dy = cc.centroidY[i] - Double(c)
            let dd = (dx * dx + dy * dy).squareRoot()
            if dd < bestD { bestD = dd; li = i }
        }
    }
    if li == 0 { return nil }

    let area = Double(cc.area[li])
    var r = (area / Double.pi).squareRoot()
    r = min(max(r, 0.4 * rGuess), 2.5 * rGuess)

    var xs: [Double] = []
    var ys: [Double] = []
    var contrastSum = 0.0
    var wSum = 0.0
    var wx = 0.0, wy = 0.0
    xs.reserveCapacity(Int(area))
    ys.reserveCapacity(Int(area))
    for y in 0..<ph {
        for x in 0..<pw where Int(cc.labels[y * pw + x]) == li {
            let v = Double(patch.px[y * pw + x])
            xs.append(Double(x))
            ys.append(Double(y))
            contrastSum += v
            wSum += v
            wx += Double(x) * v
            wy += Double(y) * v
        }
    }
    let n = xs.count
    if n == 0 { return nil }
    var aniso = 1.0
    if n >= 3 {
        // numpy `np.cov` uses ddof=1; the ratio of eigenvalues is unaffected but keep it exact.
        let mx = xs.reduce(0, +) / Double(n)
        let my = ys.reduce(0, +) / Double(n)
        var sxx = 0.0, syy = 0.0, sxy = 0.0
        for i in 0..<n {
            let ax = xs[i] - mx, ay = ys[i] - my
            sxx += ax * ax; syy += ay * ay; sxy += ax * ay
        }
        let dd = Double(n - 1)
        sxx /= dd; syy /= dd; sxy /= dd
        // Closed-form eigenvalues of a symmetric 2x2, ascending like np.linalg.eigvalsh.
        let tr = sxx + syy
        let disc = max(0.0, (sxx - syy) * (sxx - syy) + 4 * sxy * sxy).squareRoot()
        let e0 = 0.5 * (tr - disc)
        let e1 = 0.5 * (tr + disc)
        aniso = (max(e1, 1e-6) / max(e0, 1e-6)).squareRoot()
    }
    let contrast = contrastSum / Double(n)
    var cxo = 0.0, cyo = 0.0
    if wSum > 0 && n >= 3 {
        cxo = wx / wSum - Double(d)
        cyo = wy / wSum - Double(c)
        let lim = 0.8 * r
        cxo = max(-lim, min(lim, cxo))
        cyo = max(-lim, min(lim, cyo))
    }
    return TracerHalfMax(r: r, contrast: contrast, aniso: aniso, cxOffset: cxo, cyOffset: cyo)
}

/// [judge] Intensity-weighted centroid of |d| (BOTH polarities) above `refineFrac` of its peak
/// inside a disc of 1.5r + u, shift clamped to r. This is the change that fixed the ~5-8 px
/// lit-side bias on backlit balls (IMG_3649): the shaded half of the ball is darker than the
/// grass and falls outside a positive-polarity blob.
/// Returns (x, y, shift). `x`/`y` are in `d`'s own coordinates.
public func tracerRefineAbsCentroid(d: PlaneF, x: Double, y: Double, r: Double, u: Double,
                                    params: TracerParams) -> (Double, Double, Double) {
    let R = Int(ceil(1.5 * r + 2 * u))
    let xi = Int(x.rounded()), yi = Int(y.rounded())
    let y0 = max(0, yi - R), y1 = min(d.height, yi + R + 1)
    let x0 = max(0, xi - R), x1 = min(d.width, xi + R + 1)
    if y1 - y0 < 3 || x1 - x0 < 3 { return (x, y, 0.0) }
    let discR = 1.5 * r + 1.0 * u
    var peak = 0.0
    for yy in y0..<y1 {
        let dy = Double(yy) - y
        for xx in x0..<x1 {
            let dx = Double(xx) - x
            if (dx * dx + dy * dy).squareRoot() <= discR {
                let v = abs(Double(d.px[yy * d.width + xx]))
                if v > peak { peak = v }
            }
        }
    }
    if peak <= 0 { return (x, y, 0.0) }
    let floorV = params.refineFrac * peak
    var s = 0.0, sx = 0.0, sy = 0.0
    for yy in y0..<y1 {
        let dy = Double(yy) - y
        for xx in x0..<x1 {
            let dx = Double(xx) - x
            if (dx * dx + dy * dy).squareRoot() <= discR {
                let w = max(abs(Double(d.px[yy * d.width + xx])) - floorV, 0.0)
                if w > 0 {
                    s += w
                    sx += w * Double(xx)
                    sy += w * Double(yy)
                }
            }
        }
    }
    if s <= 0 { return (x, y, 0.0) }
    var dx = sx / s - x
    var dy = sy / s - y
    var sh = (dx * dx + dy * dy).squareRoot()
    if sh > r {
        dx *= r / sh
        dy *= r / sh
        sh = r
    }
    return (x + dx, y + dy, sh)
}

/// [detect2 (d)] Coarse local median of a difference map — the illumination / auto-exposure
/// offset between the background frames and the flight frames. Subtracting it is what stopped
/// the candidate list being flooded by static scene on backlit clips (IMG_5516, IMG_7721).
/// 13 px at a 4-fold downsample is 52 px at full resolution: larger than any ball, so the ball
/// itself survives the subtraction.
public func tracerLocalOffset(_ d: PlaneF, params: TracerParams) -> PlaneF {
    let w = d.width, h = d.height
    let s = params.localBgScale
    if min(h, w) < 4 * s {
        let med = tracerMedian(d.px)
        return PlaneF(width: w, height: h, value: med)
    }
    let small = tracerResizeArea(d, toWidth: max(1, w / s), toHeight: max(1, h / s))
    var u8 = PlaneU8(width: small.width, height: small.height)
    for i in 0..<small.px.count {
        u8.px[i] = UInt8(max(0.0, min(255.0, Double(small.px[i]) + 128.0)))
    }
    let med = tracerMedianBlurU8(u8, k: params.localBgK)
    var medF = PlaneF(width: med.width, height: med.height)
    for i in 0..<med.px.count { medF.px[i] = Float(med.px[i]) - 128.0 }
    return tracerResizeBilinear(medF, toWidth: w, toHeight: h)
}

// MARK: - Blob candidates (lab `_blob_candidates`)

/// One DoG blob candidate with every feature the scorers read. Coordinates are RELATIVE to
/// the ROI the candidate was found in; the caller adds the ROI origin.
public struct BlobCandidate {
    public var x = 0.0
    public var y = 0.0
    public var r = 0.0
    public var resp = 0.0
    public var snr = 0.0
    public var contrast = 0.0
    /// Mean of `polarity * d2` over the candidate's box; NaN when no previous frame was given.
    public var c2 = Double.nan
    public var S = 0.0
    public var V = 0.0
    public var vMax = 0.0
    public var iso = 0.0
    public var aniso = 1.0
    public var polarity = 1
    public var shift = 0.0
    /// [detect2 (c)] number of comparable candidates within `crowdRadius`. Filled by the caller.
    public var crowd = 0
    /// Which map produced it in the address ROI finder ("lum+", "lum-", "chroma"); "" elsewhere.
    public var chan = ""
}

/// [det-bg-kalman + judge refinement] Multi-scale DoG peaks on the positive part of
/// `polarity * d` (or on `dmap`, a non-negative map supplied by the caller — the launch seed
/// uses `min(|d|, |d2|)`), with radius/contrast/isolation/anisotropy/motion features.
///
/// `allowed` is an optional ROI-shaped mask; `satur`/`value` are the HSV S and V planes over
/// the same ROI. All three must have `d`'s dimensions.
public func tracerBlobCandidates(d: PlaneF,
                                 d2: PlaneF?,
                                 satur: PlaneU8,
                                 value: PlaneU8,
                                 u: Double,
                                 polarity: Int,
                                 sigmas: [Double],
                                 thr: Double,
                                 maxPeaks: Int,
                                 allowed: [Bool]?,
                                 refine: Bool,
                                 params: TracerParams,
                                 dmap: PlaneF? = nil) -> [BlobCandidate] {
    let w = d.width, h = d.height
    if w <= 0 || h <= 0 || sigmas.isEmpty { return [] }
    let pol = Float(polarity)
    var dp = PlaneF(width: w, height: h)
    for i in 0..<(w * h) { dp.px[i] = max(pol * d.px[i], 0) }
    let pkSrc = dmap ?? dp

    // Scale-space maximum: for every pixel, the largest DoG response over the sigma list and
    // which sigma produced it (the sigma sets the radius estimator's scale below).
    var best = [Float](repeating: -1.0, count: w * h)
    var bestI = [Int](repeating: 0, count: w * h)
    for (i, s) in sigmas.enumerated() {
        let g1 = tracerGaussianBlur(pkSrc, sigma: s)
        let g2 = tracerGaussianBlur(pkSrc, sigma: params.dogK * s)
        for j in 0..<(w * h) {
            let r = g1.px[j] - g2.px[j]
            if r > best[j] { best[j] = r; bestI[j] = i }
        }
    }
    let bestPlane = PlaneF(width: w, height: h, px: best)
    let k = Int(2 * (3 * u).rounded()) + 1
    let dil = tracerDilateRect(bestPlane, k: k)

    // Noise floor from a stride-4 subsample of the positive responses — the SNR denominator.
    var pos: [Float] = []
    var yy = 0
    while yy < h {
        var xx = 0
        while xx < w {
            let v = best[yy * w + xx]
            if v > 0 { pos.append(v) }
            xx += 4
        }
        yy += 4
    }
    let noise = max(pos.isEmpty ? 1.0 : Double(tracerMedian(pos)), 0.3)

    // Strict local maxima above the threshold, inside the allowed mask.
    var peaks: [(Int, Int, Float)] = []
    for y in 0..<h {
        for x in 0..<w {
            let i = y * w + x
            if let a = allowed, !a[i] { continue }
            let v = best[i]
            if v > Float(thr) && v >= dil.px[i] { peaks.append((x, y, v)) }
        }
    }
    if peaks.count > maxPeaks {
        peaks.sort { $0.2 > $1.2 }
        peaks.removeLast(peaks.count - maxPeaks)
    }

    var out: [BlobCandidate] = []
    out.reserveCapacity(peaks.count)
    for (px, py, resp) in peaks {
        let s = sigmas[bestI[py * w + px]]
        guard let hm = tracerRadiusHalfMax(dp: dp, cx: px, cy: py, sigma: s, u: u) else { continue }
        let r = hm.r
        if r < 0.6 * u || r > 22 * u { continue }
        let rr = max(1, Int(r.rounded()))
        let ya = max(0, py - rr), yb = min(h, py + rr + 1)
        let xa = max(0, px - rr), xb = min(w, px + rr + 1)
        if yb <= ya || xb <= xa { continue }
        var sSum = 0.0, vSum = 0.0, vMax = 0.0, c2Sum = 0.0
        var boxN = 0
        for by in ya..<yb {
            for bx in xa..<xb {
                let i = by * w + bx
                sSum += Double(satur.px[i])
                let vv = Double(value.px[i])
                vSum += vv
                if vv > vMax { vMax = vv }
                if let dd2 = d2 { c2Sum += Double(pol * dd2.px[i]) }
                boxN += 1
            }
        }
        let bn = Double(boxN)
        let c2 = d2 == nil ? Double.nan : c2Sum / bn

        // Isolation: the fraction of the surrounding annulus that is itself bright. A ball on
        // grass is alone; a canopy glint or a sand splash is not.
        let ra = Int(1.6 * r + 2 * u)
        let rb = Int(3.2 * r + 4 * u)
        let ya2 = max(0, py - rb), yb2 = min(h, py + rb + 1)
        let xa2 = max(0, px - rb), xb2 = min(w, px + rb + 1)
        var annN = 0, annHit = 0
        let cutoff = Float(0.4 * hm.contrast)
        for by in ya2..<yb2 {
            let dy = Double(by - py)
            for bx in xa2..<xb2 {
                let dx = Double(bx - px)
                let rad = (dx * dx + dy * dy).squareRoot()
                if rad >= Double(ra) && rad <= Double(rb) {
                    annN += 1
                    if dp.px[by * w + bx] > cutoff { annHit += 1 }
                }
            }
        }
        let iso = annN > 0 ? Double(annHit) / Double(annN) : 0.0

        var cx = Double(px) + hm.cxOffset
        var cy = Double(py) + hm.cyOffset
        var shift = 0.0
        if refine && params.refine {
            let (nx, ny, sh) = tracerRefineAbsCentroid(d: d, x: cx, y: cy, r: r, u: u, params: params)
            cx = nx; cy = ny; shift = sh
        }
        var cand = BlobCandidate()
        cand.x = cx
        cand.y = cy
        cand.r = r
        cand.resp = Double(resp)
        cand.snr = Double(resp) / noise
        cand.contrast = hm.contrast
        cand.c2 = c2
        cand.S = sSum / bn
        cand.V = vSum / bn
        cand.vMax = vMax
        cand.iso = iso
        cand.aniso = hm.aniso
        cand.polarity = polarity
        cand.shift = shift
        out.append(cand)
    }
    out.sort { $0.resp > $1.resp }
    return out
}

// MARK: - Colour (OpenCV 8-bit conversions, reproduced so thresholds keep their meaning)

/// A display-oriented BGRA8 frame exactly as `kCVPixelFormatType_32BGRA` delivers it
/// (byte order B, G, R, A), already rotated into display orientation by the driver.
public struct TracerBGRA {
    public var width: Int
    public var height: Int
    public var px: [UInt8]      // width * height * 4

    public init(width: Int, height: Int, px: [UInt8]) {
        self.width = width
        self.height = height
        self.px = px
    }
}

/// `cv2.cvtColor(BGR2GRAY)` in OpenCV's exact fixed point, so the greys are the same integers
/// the lab's thresholds (`peak_thr` = 4 grey levels, `contrast` gates at 6/8/20/25) were set
/// against. Returned as Float because every downstream map is float32.
public func tracerLumaPlane(_ f: TracerBGRA, x0: Int, y0: Int, x1: Int, y1: Int) -> PlaneF {
    let w = max(0, x1 - x0), h = max(0, y1 - y0)
    var out = PlaneF(width: w, height: h)
    if w == 0 || h == 0 { return out }
    for y in 0..<h {
        var si = ((y0 + y) * f.width + x0) * 4
        var di = y * w
        for _ in 0..<w {
            let b = Int(f.px[si]), g = Int(f.px[si + 1]), r = Int(f.px[si + 2])
            out.px[di] = Float((r * 4899 + g * 9617 + b * 1868 + (1 << 13)) >> 14)
            si += 4
            di += 1
        }
    }
    return out
}

/// `cv2.cvtColor(BGR2HSV)` saturation and value channels (8-bit). Hue is never read by the
/// detector, so it is not computed.
public func tracerSaturationValuePlanes(_ f: TracerBGRA, x0: Int, y0: Int, x1: Int, y1: Int) -> (PlaneU8, PlaneU8) {
    let w = max(0, x1 - x0), h = max(0, y1 - y0)
    var s = PlaneU8(width: w, height: h)
    var v = PlaneU8(width: w, height: h)
    if w == 0 || h == 0 { return (s, v) }
    for y in 0..<h {
        var si = ((y0 + y) * f.width + x0) * 4
        var di = y * w
        for _ in 0..<w {
            let b = Int(f.px[si]), g = Int(f.px[si + 1]), r = Int(f.px[si + 2])
            let mx = max(r, max(g, b))
            let mn = min(r, min(g, b))
            v.px[di] = UInt8(mx)
            s.px[di] = mx == 0 ? 0 : UInt8(min(255, (( (mx - mn) * 255 + mx / 2) / mx)))
            si += 4
            di += 1
        }
    }
    return (s, v)
}

/// `cv2.cvtColor(BGR2LAB)` for 8-bit input: sRGB gamma, D65 white point, then OpenCV's 8-bit
/// packing (L * 255/100, a + 128, b + 128). The address ROI finder's thresholds (`max(cs_) < 6`,
/// DoG threshold 2.5 on the chroma map) are in THESE units, so the packing has to be right.
/// Returned as three float planes over the requested rectangle.
public func tracerLabPlanes(_ f: TracerBGRA, x0: Int, y0: Int, x1: Int, y1: Int) -> (PlaneF, PlaneF, PlaneF) {
    let w = max(0, x1 - x0), h = max(0, y1 - y0)
    var lp = PlaneF(width: w, height: h)
    var ap = PlaneF(width: w, height: h)
    var bp = PlaneF(width: w, height: h)
    if w == 0 || h == 0 { return (lp, ap, bp) }

    // sRGB -> linear, tabulated once: 256 entries beats a pow() per channel per pixel.
    var lin = [Double](repeating: 0, count: 256)
    for i in 0..<256 {
        let c = Double(i) / 255.0
        lin[i] = c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
    let xn = 0.950456, yn = 1.0, zn = 1.088754
    @inline(__always) func fLab(_ t: Double) -> Double {
        return t > 0.008856 ? pow(t, 1.0 / 3.0) : (7.787 * t + 16.0 / 116.0)
    }
    for y in 0..<h {
        var si = ((y0 + y) * f.width + x0) * 4
        var di = y * w
        for _ in 0..<w {
            let b = lin[Int(f.px[si])], g = lin[Int(f.px[si + 1])], r = lin[Int(f.px[si + 2])]
            let X = (0.412453 * r + 0.357580 * g + 0.180423 * b) / xn
            let Y = (0.212671 * r + 0.715160 * g + 0.072169 * b) / yn
            let Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / zn
            let fy = fLab(Y)
            let L = Y > 0.008856 ? (116.0 * fy - 16.0) : (903.3 * Y)
            let A = 500.0 * (fLab(X) - fy)
            let B = 200.0 * (fy - fLab(Z))
            lp.px[di] = Float(max(0.0, min(255.0, (L * 255.0 / 100.0).rounded())))
            ap.px[di] = Float(max(0.0, min(255.0, (A + 128.0).rounded())))
            bp.px[di] = Float(max(0.0, min(255.0, (B + 128.0).rounded())))
            si += 4
            di += 1
        }
    }
    return (lp, ap, bp)
}

// MARK: - Pose geometry and the skeleton veto (lab `golfer_geometry`, `golfer_mask`)

/// COCO-17 keypoints in the order Vision's `VNDetectHumanBodyPoseRequest` also provides them
/// (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles), in display-oriented
/// TOP-LEFT pixels. `conf[i] < 0` means "not reported".
public struct TracerPose {
    public var x: [Double]      // 17
    public var y: [Double]      // 17
    public var conf: [Double]   // 17
    public var box: (Double, Double, Double, Double)   // x0, y0, x1, y1

    public init(x: [Double], y: [Double], conf: [Double], box: (Double, Double, Double, Double)) {
        self.x = x
        self.y = y
        self.conf = conf
        self.box = box
    }
}

/// COCO-17 skeleton edges used for the veto mask, copied from the lab's `LIMBS`.
public let tracerLimbs: [(Int, Int)] = [
    (5, 7), (7, 9), (6, 8), (8, 10), (11, 13), (13, 15), (12, 14), (14, 16),
    (5, 6), (11, 12), (5, 11), (6, 12)
]
public let tracerHeadKeypoints = [0, 1, 2, 3, 4]

/// Consensus geometry over the address-frame poses.
public struct GolferGeometry {
    public var ankleX = 0.0
    public var ankleY = 0.0
    public var hipX: Double?
    public var hipY: Double?
    public var headX: Double?
    public var headY: Double?
    /// Leg length in px (world ~0.9 m) — the unit every ROI and mask constant is expressed in.
    public var legLength = 0.0
    /// +1 = ball to the RIGHT of the golfer in the image, -1 = left, 0 = unknown.
    public var side = 0
    public var box: (Double, Double, Double, Double) = (0, 0, 0, 0)
    public var poseCount = 0
}

public func tracerGolferGeometry(poses: [TracerPose?], params: TracerParams) -> GolferGeometry? {
    var ankX: [Double] = [], ankY: [Double] = []
    var hipX: [Double] = [], hipY: [Double] = []
    var headX: [Double] = [], headY: [Double] = []
    var b0: [Double] = [], b1: [Double] = [], b2: [Double] = [], b3: [Double] = []
    for case let p? in poses {
        func mean(_ idx: [Int]) -> (Double, Double)? {
            var sx = 0.0, sy = 0.0, n = 0
            for i in idx where p.conf[i] >= params.kpConf {
                sx += p.x[i]; sy += p.y[i]; n += 1
            }
            return n == 0 ? nil : (sx / Double(n), sy / Double(n))
        }
        if let a = mean([15, 16]) { ankX.append(a.0); ankY.append(a.1) }
        if let hp = mean([11, 12]) { hipX.append(hp.0); hipY.append(hp.1) }
        if let hd = mean(tracerHeadKeypoints) { headX.append(hd.0); headY.append(hd.1) }
        b0.append(p.box.0); b1.append(p.box.1); b2.append(p.box.2); b3.append(p.box.3)
    }
    if ankX.isEmpty || b0.isEmpty { return nil }
    var g = GolferGeometry()
    g.ankleX = tracerMedian(ankX)
    g.ankleY = tracerMedian(ankY)
    g.box = (tracerMedian(b0), tracerMedian(b1), tracerMedian(b2), tracerMedian(b3))
    let bh = g.box.3 - g.box.1
    var L = 0.0
    if !hipX.isEmpty {
        let hx = tracerMedian(hipX), hy = tracerMedian(hipY)
        g.hipX = hx; g.hipY = hy
        L = abs(hy - g.ankleY)
    }
    // Bent-over or occluded hips: fall back to a fraction of the person's box height.
    if L < 0.25 * bh { L = 0.45 * bh }
    g.legLength = max(L, 20.0)
    if !headX.isEmpty {
        let hx = tracerMedian(headX)
        g.headX = hx
        g.headY = tracerMedian(headY)
        let dx = hx - g.ankleX
        if abs(dx) > 0.12 * g.legLength { g.side = dx > 0 ? 1 : -1 }
    }
    g.poseCount = b0.count
    return g
}

/// [detect2 (b)] The golfer's skeleton as a set of capsules, discs and one torso polygon, all
/// grown by the dilation margin. Containment is tested analytically rather than rasterised:
/// the lab dilates a drawn mask with an elliptical structuring element, which IS the union of
/// the primitives grown by the margin, and only a few hundred points are ever queried per frame.
///
/// It is deliberately NOT a convex hull. The hull spans the gap between the raised arms and the
/// torso, which is exactly where the ball flies — it took IMG_3652 from 45 detections to 0.
public struct GolferSkeleton {
    struct Capsule { var ax: Double; var ay: Double; var bx: Double; var by: Double; var r: Double }
    struct Disc { var x: Double; var y: Double; var r: Double }
    var capsules: [Capsule] = []
    var discs: [Disc] = []
    var torso: [(Double, Double)] = []
    var margin: Double = 0

    public func contains(_ x: Double, _ y: Double) -> Bool {
        for d in discs {
            let dx = x - d.x, dy = y - d.y
            if dx * dx + dy * dy <= d.r * d.r { return true }
        }
        for c in capsules {
            let vx = c.bx - c.ax, vy = c.by - c.ay
            let len2 = vx * vx + vy * vy
            var t = 0.0
            if len2 > 1e-9 { t = max(0.0, min(1.0, ((x - c.ax) * vx + (y - c.ay) * vy) / len2)) }
            let px = c.ax + t * vx - x, py = c.ay + t * vy - y
            if px * px + py * py <= c.r * c.r { return true }
        }
        if torso.count >= 3 {
            if tracerPointInPolygon(x: x, y: y, poly: torso) { return true }
            if margin > 0 && tracerDistanceToPolygonEdge(x: x, y: y, poly: torso) <= margin { return true }
        }
        return false
    }
}

func tracerPointInPolygon(x: Double, y: Double, poly: [(Double, Double)]) -> Bool {
    var inside = false
    var j = poly.count - 1
    for i in 0..<poly.count {
        let (xi, yi) = poly[i]
        let (xj, yj) = poly[j]
        if (yi > y) != (yj > y) {
            let xc = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xc { inside.toggle() }
        }
        j = i
    }
    return inside
}

func tracerDistanceToPolygonEdge(x: Double, y: Double, poly: [(Double, Double)]) -> Double {
    var best = Double.greatestFiniteMagnitude
    var j = poly.count - 1
    for i in 0..<poly.count {
        let (xi, yi) = poly[i]
        let (xj, yj) = poly[j]
        let vx = xj - xi, vy = yj - yi
        let len2 = vx * vx + vy * vy
        var t = 0.0
        if len2 > 1e-9 { t = max(0.0, min(1.0, ((x - xi) * vx + (y - yi) * vy) / len2)) }
        let dx = xi + t * vx - x, dy = yi + t * vy - y
        best = min(best, (dx * dx + dy * dy).squareRoot())
        j = i
    }
    return best
}

/// Build the veto skeleton. `L` is the leg length from the ADDRESS-frame geometry (the lab
/// passes `geom["L"]`, not a per-frame value, so a mid-swing pose cannot rescale the mask).
public func tracerGolferSkeleton(pose: TracerPose?, legLength L: Double, u: Double,
                                 params: TracerParams) -> GolferSkeleton? {
    guard let p = pose else { return nil }
    var sk = GolferSkeleton()
    let mg = Double(Int((params.vetoMargin * u).rounded()))
    sk.margin = mg
    func ok(_ i: Int) -> Bool { return p.conf[i] >= params.kpConf }

    // OpenCV draws a thickness-t line as a band of half-width t/2. PORT: rendered here as a
    // capsule (round caps) rather than OpenCV's flat ends; the difference is a half-disc at
    // each joint, and the joints are shared between adjacent limbs anyway.
    let tLimb = Double(max(Int((params.limbFrac * L).rounded()), Int((6 * u).rounded())))
    for (a, b) in tracerLimbs where ok(a) && ok(b) {
        sk.capsules.append(.init(ax: p.x[a], ay: p.y[a], bx: p.x[b], by: p.y[b], r: tLimb / 2 + mg))
    }
    let torsoIdx = [5, 6, 12, 11].filter { ok($0) }
    if torsoIdx.count >= 3 {
        sk.torso = torsoIdx.map { (p.x[$0], p.y[$0]) }
    }
    let headIdx = tracerHeadKeypoints.filter { ok($0) }
    if !headIdx.isEmpty {
        let hx = headIdx.map { p.x[$0] }.reduce(0, +) / Double(headIdx.count)
        let hy = headIdx.map { p.y[$0] }.reduce(0, +) / Double(headIdx.count)
        // headFrac was raised 0.16 -> 0.22 in the lab because the face keypoints sit mid-head
        // and a white cap's top is ~0.15 L above them (IMG_6150 seeded on the cap edge).
        let rad = Double(Int(max(params.headFrac * L, 14 * u).rounded()))
        sk.discs.append(.init(x: hx, y: hy, r: rad + mg))
        if ok(5) && ok(6) {
            // Neck / collar stroke at TWICE the limb thickness: the collar sits between the
            // head disc and the shoulder line and produced the IMG_3640 f221/222 detections.
            let smx = 0.5 * (p.x[5] + p.x[6]), smy = 0.5 * (p.y[5] + p.y[6])
            sk.capsules.append(.init(ax: smx, ay: smy, bx: hx, by: hy, r: tLimb + mg))
        }
    }
    for i in [9, 10] where ok(i) {
        let rad = Double(Int(max(params.handFrac * L, 8 * u).rounded()))
        sk.discs.append(.init(x: p.x[i], y: p.y[i], r: rad + mg))
    }
    if sk.capsules.isEmpty && sk.discs.isEmpty && sk.torso.isEmpty { return nil }
    return sk
}

// MARK: - Address finding (lab `address_roi`, `roi_address_candidates`, `address_candidates`)

/// One static-ball candidate at address.
public struct AddressCandidate {
    public var x = 0.0
    public var y = 0.0
    public var r = 0.0
    public var prior = 0.0
    /// "yolo" (the Core ML ball model), "blob" (bright round static blob), "pose_roi"
    /// (colour-agnostic finder inside the pose ROI).
    public var source = ""
    public var nFrames = 0
    public var inRoi = false
    public var roiChan: String?
    public var chan = ""
}

/// A single Core ML ball detection on one address frame, in display-oriented pixels.
public struct TracerYoloDetection {
    public var x: Double
    public var y: Double
    public var r: Double
    public var conf: Double
    public init(x: Double, y: Double, r: Double, conf: Double) {
        self.x = x; self.y = y; self.r = r; self.conf = conf
    }
}

/// [detect2 (a)] Ground rectangle(s) where the address ball can lie: ahead of the ankles on
/// the side the head leans to, at ankle height. Both sides when the lean is inconclusive.
public func tracerAddressROIs(geom: GolferGeometry, width W: Int, height H: Int,
                              params: TracerParams) -> [(Int, Int, Int, Int)] {
    let L = geom.legLength
    let dy = params.roiDy * L
    var rois: [(Int, Int, Int, Int)] = []
    let sides: [Double] = geom.side != 0 ? [Double(geom.side)] : [1, -1]
    for sd in sides {
        let xa = geom.ankleX + sd * params.roiDxLo * L
        let xb = geom.ankleX + sd * params.roiDxHi * L
        let x0 = Int(max(0, min(xa, xb)))
        let x1 = Int(min(Double(W), max(xa, xb)))
        let y0 = Int(max(0, geom.ankleY - dy))
        let y1 = Int(min(Double(H), geom.ankleY + dy))
        if x1 - x0 > 20 && y1 - y0 > 20 { rois.append((x0, y0, x1, y1)) }
    }
    return rois
}

/// [detect2 (a)] Colour-agnostic static round blobs inside the pose ROI: a luma DoG in BOTH
/// polarities plus a Lab-chroma DoG, each against a local median background. A yellow ball is
/// invisible to a "bright white blob" finder and to a golf-ball model trained on white ones;
/// what it is not invisible to is "a small round thing whose Lab contrast against its
/// surround persists on every address frame". The persistence is measured in Lab, not
/// brightness, because the golfer's shadow moves across the ball between frames.
public func tracerRoiAddressCandidates(frames: [TracerBGRA], geom: GolferGeometry, u: Double,
                                       rois: [(Int, Int, Int, Int)],
                                       params: TracerParams) -> [AddressCandidate] {
    guard let ref = frames.last else { return [] }
    let W = ref.width, H = ref.height
    let L = geom.legLength
    let rExp = min(max(params.rExpFrac * L, 1.5 * u), 25 * u)
    var out: [AddressCandidate] = []

    for (x0, y0, x1, y1) in rois {
        let sw = x1 - x0, sh = y1 - y0
        if sw <= 0 || sh <= 0 { continue }
        let (lc, ac, bc) = tracerLabPlanes(ref, x0: x0, y0: y0, x1: x1, y1: y1)
        let (satur, value) = tracerSaturationValuePlanes(ref, x0: x0, y0: y0, x1: x1, y1: y1)
        var k = Int(2 * (4 * rExp).rounded()) + 1
        k = max(5, min(k, 151))
        func medianOf(_ p: PlaneF) -> PlaneF {
            var u8 = PlaneU8(width: p.width, height: p.height)
            for i in 0..<p.px.count { u8.px[i] = UInt8(max(0.0, min(255.0, Double(p.px[i])))) }
            let m = tracerMedianBlurU8(u8, k: k)
            var f = PlaneF(width: p.width, height: p.height)
            for i in 0..<m.px.count { f.px[i] = Float(m.px[i]) }
            return f
        }
        let lm = medianOf(lc), am = medianOf(ac), bm = medianOf(bc)
        var dL = PlaneF(width: sw, height: sh)
        var dChroma = PlaneF(width: sw, height: sh)
        for i in 0..<(sw * sh) {
            dL.px[i] = lc.px[i] - lm.px[i]
            let da = Double(ac.px[i] - am.px[i]), db = Double(bc.px[i] - bm.px[i])
            dChroma.px[i] = Float((da * da + db * db).squareRoot())
        }
        let sig = [0.6, 0.8, 1.0, 1.25, 1.6].map { rExp / 1.75 * $0 }
        var cands: [BlobCandidate] = []
        let passes: [(PlaneF, Int, String, Double)] = [
            (dL, 1, "lum+", 3.0), (dL, -1, "lum-", 3.0), (dChroma, 1, "chroma", 2.5)
        ]
        for (mp, pol, ch, thr) in passes {
            var cs = tracerBlobCandidates(d: mp, d2: nil, satur: satur, value: value, u: u,
                                          polarity: pol, sigmas: sig, thr: thr, maxPeaks: 150,
                                          allowed: nil, refine: false, params: params)
            for i in cs.indices { cs[i].chan = ch }
            cands += cs
        }
        for c in cands {
            if !(0.45 * rExp <= c.r && c.r <= 1.8 * rExp) { continue }
            if c.aniso > 1.7 || c.iso > 0.3 { continue }
            let X = c.x + Double(x0), Y = c.y + Double(y0)
            let R = Int(3 * c.r + 6)
            let ya = Int(max(0, Y - Double(R))), yb = Int(min(Double(H), Y + Double(R) + 1))
            let xa = Int(max(0, X - Double(R))), xb = Int(min(Double(W), X + Double(R) + 1))
            if yb - ya < 5 || xb - xa < 5 { continue }
            let bw = xb - xa, bh = yb - ya
            var discIdx: [Int] = [], annIdx: [Int] = []
            let discR = max(1.0, 0.7 * c.r)
            for by in 0..<bh {
                let dy = Double(ya + by) - Y
                for bx in 0..<bw {
                    let dx = Double(xa + bx) - X
                    let rad = (dx * dx + dy * dy).squareRoot()
                    if rad <= discR { discIdx.append(by * bw + bx) }
                    if rad >= 1.6 * c.r && rad <= 2.6 * c.r { annIdx.append(by * bw + bx) }
                }
            }
            if discIdx.isEmpty || annIdx.isEmpty { continue }
            // Lab contrast of the disc against its annulus, on EVERY address frame.
            var series: [Double] = []
            for f in frames {
                let (fl, fa, fb) = tracerLabPlanes(f, x0: xa, y0: ya, x1: xb, y1: yb)
                var ml = 0.0, ma = 0.0, mb = 0.0
                for i in discIdx { ml += Double(fl.px[i]); ma += Double(fa.px[i]); mb += Double(fb.px[i]) }
                let dn = Double(discIdx.count)
                ml /= dn; ma /= dn; mb /= dn
                let gl = tracerMedian(annIdx.map { Double(fl.px[$0]) })
                let ga = tracerMedian(annIdx.map { Double(fa.px[$0]) })
                let gb = tracerMedian(annIdx.map { Double(fb.px[$0]) })
                let d0 = ml - gl, d1 = ma - ga, d2 = mb - gb
                series.append((d0 * d0 + d1 * d1 + d2 * d2).squareRoot())
            }
            guard let mn = series.min(), let mx = series.max() else { continue }
            if mn < params.roiPresenceFrac * mx || mx < 6 { continue }
            // Position prior: the ball sits ~0.8 leg-lengths from the ankles, at ankle height.
            let sideSign = geom.side != 0 ? Double(geom.side) : (X > geom.ankleX ? 1.0 : -1.0)
            let dx = (X - geom.ankleX) * sideSign / L
            let dy = (Y - geom.ankleY) / L
            let pos = exp(-0.5 * pow((dx - 0.8) / 0.5, 2)) * exp(-0.5 * pow(dy / 0.3, 2))
            let qv = tracerSoft(c.snr, 3, 12) * tracerFSize(c.r, rExp, 0.5)
                / (1 + abs(c.aniso - 1)) * (1 - c.iso) * (0.4 + 0.6 * pos)
            var a = AddressCandidate()
            a.x = X; a.y = Y; a.r = c.r
            a.prior = min(0.75, 0.75 * qv)
            a.source = "pose_roi"
            a.chan = c.chan
            a.inRoi = true
            out.append(a)
        }
    }
    out.sort { $0.prior > $1.prior }
    var dedup: [AddressCandidate] = []
    for c in out {
        if !dedup.contains(where: { hypot($0.x - c.x, $0.y - c.y) < 3 * u }) { dedup.append(c) }
    }
    if dedup.count > 12 { dedup.removeLast(dedup.count - 12) }
    return dedup
}

/// [det-bg-kalman + detect2] The full address candidate list: Core ML ball detections that are
/// stable across frames (or one confident one), bright round static blobs in the lower centre,
/// and — when a pose was found — the colour-agnostic ROI candidates, with every prior
/// re-weighted by whether it lies in the ROI. Best prior first.
///
/// `yoloPerFrame` is one array of detections per address frame, in the same order as `frames`;
/// pass all-empty arrays when the model is unavailable (the finder then degrades to blob+ROI,
/// which is the required graceful failure, not a crash and not a fabricated ball).
public func tracerAddressCandidates(frames: [TracerBGRA],
                                    yoloPerFrame: [[TracerYoloDetection]],
                                    geom: GolferGeometry?,
                                    u: Double,
                                    params: TracerParams) -> [AddressCandidate] {
    guard let ref = frames.last else { return [] }
    let W = ref.width, H = ref.height
    var out: [AddressCandidate] = []

    // ---- Core ML ball model ----
    if !yoloPerFrame.isEmpty {
        var seen: [AddressCandidate] = []
        for pf in yoloPerFrame {
            for d in pf {
                // Ignore anything in the top third: the ball at address is on the ground.
                if d.y < 0.35 * Double(H) { continue }
                var same: [Double] = []
                var n = 0
                for pf2 in yoloPerFrame {
                    var hit = false
                    for e in pf2 where hypot(d.x - e.x, d.y - e.y) < 3 * u {
                        same.append(e.r)
                        hit = true
                    }
                    if hit { n += 1 }
                }
                if seen.contains(where: { hypot(d.x - $0.x, d.y - $0.y) < 3 * u }) { continue }
                if n >= 2 || d.conf >= 0.5 {
                    // [detect2] the box size is averaged over the frames it was seen on: a
                    // single frame's box is noisy and r0 sets every downstream size gate.
                    let rMean = same.isEmpty ? d.r : same.reduce(0, +) / Double(same.count)
                    var a = AddressCandidate()
                    a.x = d.x; a.y = d.y; a.r = rMean
                    a.prior = min(1.0, d.conf * (0.6 + 0.2 * Double(n)))
                    a.source = "yolo"
                    a.nFrames = n
                    seen.append(a)
                }
            }
        }
        out += seen
    }

    // ---- bright round static blob, lower centre of the frame ----
    let bx0 = Int(0.1 * Double(W)), bx1 = Int(0.9 * Double(W))
    let by0 = Int(0.45 * Double(H)), by1 = Int(0.95 * Double(H))
    if bx1 > bx0 && by1 > by0 {
        let grays = frames.map { tracerLumaPlane($0, x0: 0, y0: 0, x1: W, y1: H) }
        let g = grays[grays.count - 1].crop(x0: bx0, y0: by0, x1: bx1, y1: by1)
        var g8 = PlaneU8(width: g.width, height: g.height)
        for i in 0..<g.px.count { g8.px[i] = UInt8(max(0.0, min(255.0, Double(g.px[i])))) }
        let bgl = tracerMedianBlurU8(g8, k: Int(2 * (10 * u).rounded()) + 1)
        var d = PlaneF(width: g.width, height: g.height)
        for i in 0..<g.px.count { d.px[i] = g.px[i] - Float(bgl.px[i]) }
        let (satur, value) = tracerSaturationValuePlanes(ref, x0: bx0, y0: by0, x1: bx1, y1: by1)
        let sig = [1.8, 2.4, 3.2, 4.3, 5.7, 7.6].map { $0 * u }
        let cs = tracerBlobCandidates(d: d, d2: nil, satur: satur, value: value, u: u,
                                      polarity: 1, sigmas: sig, thr: 6.0, maxPeaks: 300,
                                      allowed: nil, refine: false, params: params)
        var blobs: [AddressCandidate] = []
        for c in cs {
            if c.S > 70 || c.vMax < 150 || c.V < 110 || c.r < 2.0 * u || c.r > 18 * u || c.iso > 0.15 { continue }
            let xx = Int(c.x), yy = Int(c.y)
            if xx < 0 || yy < 0 || bx0 + xx >= W || by0 + yy >= H { continue }
            // Static: the grey level under the candidate must not move across the address
            // frames (a person, a club or a shadow does; a ball on the ground does not).
            var vals: [Float] = []
            for gr in grays { vals.append(gr.px[(by0 + yy) * W + (bx0 + xx)]) }
            if let mx = vals.max(), let mn = vals.min(), mx - mn > 25 { continue }
            let score = c.snr * tracerFSize(c.r, 6 * u, 0.7) * (1 - c.iso) / (1 + abs(c.aniso - 1))
            var a = AddressCandidate()
            a.x = c.x + Double(bx0); a.y = c.y + Double(by0); a.r = c.r
            a.prior = min(0.5, score / 60)
            a.source = "blob"
            blobs.append(a)
        }
        blobs.sort { $0.prior > $1.prior }
        for b in blobs.prefix(30) {
            if !out.contains(where: { hypot(b.x - $0.x, b.y - $0.y) < 4 * u }) { out.append(b) }
        }
    }

    // ---- pose ROI re-weighting and colour-agnostic candidates ----
    if let geom = geom {
        let rois = tracerAddressROIs(geom: geom, width: W, height: H, params: params)
        if !rois.isEmpty {
            func inside(_ x: Double, _ y: Double) -> Bool {
                return rois.contains { Double($0.0) <= x && x <= Double($0.2) && Double($0.1) <= y && y <= Double($0.3) }
            }
            for i in out.indices {
                out[i].inRoi = inside(out[i].x, out[i].y)
                // Softened from the first detect2 seat's 1.3/0.35 so a pose failure cannot by
                // itself veto a confident ball from the model.
                out[i].prior *= out[i].inRoi ? params.roiInsideFactor : params.roiOutsideFactor
            }
            for b in tracerRoiAddressCandidates(frames: frames, geom: geom, u: u, rois: rois, params: params) {
                if let j = out.firstIndex(where: { hypot(b.x - $0.x, b.y - $0.y) < 4 * u }) {
                    out[j].prior = max(out[j].prior, b.prior)
                    out[j].roiChan = b.chan
                } else {
                    out.append(b)
                }
            }
        }
    }
    out.sort { $0.prior > $1.prior }
    return out
}

// MARK: - Address validation and the departure cue (lab `_ball_contrast`, `validate_address`)

/// Signed contrast of the candidate disc against its annulus IN THE BACKGROUND MODEL, plus a
/// re-measured radius. Sign matters: a dark ball on bright ground (backlit, coloured, or
/// silhouetted) gives a negative contrast, and the lab only trusts that when a ball-SHAPED
/// finder proposed the candidate.
public func tracerBallContrast(bg: PlaneF, ax: Double, ay: Double, r: Double, u: Double) -> (Double?, Double?) {
    let R = Int(3 * r + 6 * u)
    let x0 = Int(max(0, ax - Double(R))), y0 = Int(max(0, ay - Double(R)))
    let x1 = min(bg.width, Int(ax + Double(R) + 1)), y1 = min(bg.height, Int(ay + Double(R) + 1))
    if x1 <= x0 || y1 <= y0 { return (nil, nil) }
    let patch = bg.crop(x0: x0, y0: y0, x1: x1, y1: y1)
    let pw = patch.width, ph = patch.height
    let cx = ax - Double(x0), cy = ay - Double(y0)
    var annVals: [Double] = []
    var discSum = 0.0, discN = 0
    for y in 0..<ph {
        let dy = Double(y) - cy
        for x in 0..<pw {
            let dx = Double(x) - cx
            let rad = (dx * dx + dy * dy).squareRoot()
            if rad >= 1.6 * r && rad <= 2.6 * r { annVals.append(Double(patch.px[y * pw + x])) }
            if rad <= 0.7 * r { discSum += Double(patch.px[y * pw + x]); discN += 1 }
        }
    }
    if annVals.isEmpty || discN == 0 { return (nil, nil) }
    let ground = tracerMedian(annVals)
    let contrast = discSum / Double(discN) - ground
    var dp = PlaneF(width: pw, height: ph)
    for i in 0..<(pw * ph) { dp.px[i] = max(patch.px[i] - Float(ground), 0) }
    let hm = tracerRadiusHalfMax(dp: dp, cx: Int(cx.rounded()), cy: Int(cy.rounded()),
                                 sigma: max(1.0, r / 1.5), u: u)
    return (contrast, hm?.r)
}

/// [detect2 (f)] The departure test, isolated so it can be unit-tested against hand-made series.
///
/// A departure is a one-frame STEP in the candidate disc's mean difference-to-background that
/// then PERSISTS and does not drift. Three shapes must fail and all three are real clips:
///   * already changed on the first scan frame (the golfer's shadow or the club sitting over
///     the ball at address — IMG_3632 (605,1069));
///   * a gradual ramp with no step (a shadow edge crossing the disc — IMG_8116 (542,1188));
///   * a change that only starts inside the last `persist` frames (nothing left to confirm it).
/// Measuring against the PRE-STEP level rather than against the background is what makes it
/// immune to an illumination change between the background frames and impact.
///
/// Returns the launch frame and the pre-step level, or nil when nothing departs.
public func tracerDepartureFrame(series: [(k: Int, v: Double)], cRef: Double, persist: Int,
                                 params: TracerParams) -> (launch: Int, preLevel: Double)? {
    let vals = series.map { $0.v }
    let n = vals.count
    if n < 2 { return nil }
    let need = params.departFrac * cRef
    for i in 0..<n {
        if i == 0 || (n - 1 - i) < persist { continue }
        let pre = tracerMedian(Array(vals[0..<i]))
        let step = abs(vals[i] - vals[i - 1])
        if step < need { continue }
        var persistent = true
        var drift = 0.0
        for j in i..<n {
            if abs(vals[j] - pre) < need { persistent = false; break }
            drift = max(drift, abs(vals[j] - vals[i]))
        }
        if !persistent { continue }
        if drift > params.departDriftMax * step { continue }
        return (series[i].k, pre)
    }
    return nil
}

/// One address candidate carried through validation.
public struct AddressInfo {
    public var cand: AddressCandidate
    /// Signed background contrast, nil when it could not be measured.
    public var C: Double?
    public var rMeasured: Double?
    /// (frame, mean difference to background over the candidate disc), one per scan frame.
    public var series: [(k: Int, v: Double)] = []
    public var launchFrame: Int?
    public var change = 0.0
    public var score = 0.0
}

/// [det-bg-kalman + detect2] Finish `validate_address` once the driver has filled every
/// candidate's disc series over the scan window.
public func tracerFinishAddressValidation(_ infos: inout [AddressInfo], impactFrame fi: Int,
                                          fpsRatio fr: Double, params: TracerParams) {
    let persist = Int((Double(params.departPersist) * fr).rounded())
    for i in infos.indices {
        // Contrast validity: bright-on-ground always counts; a DARK ball only counts when a
        // ball-shaped finder proposed it. Letting the generic bright-blob finder score a
        // negative contrast fully flipped the address pick on IMG_3632 and IMG_3650.
        let raw = infos[i].C
        var C: Double? = nil
        if let v = raw {
            let src = infos[i].cand.source
            if v > 6 || (v < -6 && (src == "yolo" || src == "pose_roi")) { C = v }
        }
        let cRef = C.map { abs($0) } ?? 30.0
        let ser = infos[i].series
        var launch: Int? = nil
        var preLevel = 0.0
        if let dep = tracerDepartureFrame(series: ser, cRef: cRef, persist: persist, params: params) {
            launch = dep.launch
            preLevel = dep.preLevel
        }
        let vals = ser.map { $0.v }
        // `change` = how much the patch stays changed just after the departure (launch+1..+3).
        // Extending this tail to the end of the window let the sand settling under a departed
        // ball shrink the true ball's score (IMG_3632).
        let kTail = launch.map { $0 + 1 } ?? (fi + Int((2 * fr).rounded()))
        if launch == nil {
            preLevel = tracerMedian(Array(vals[0..<max(1, vals.count / 3)]))
        }
        let hi = kTail + Int((2 * fr).rounded())
        let tail = ser.filter { $0.k >= kTail && $0.k <= hi }.map { abs($0.v - preLevel) }
        let change = tail.isEmpty ? 0.0 : (tail.min() ?? 0.0) / cRef
        infos[i].launchFrame = launch
        infos[i].change = change
        infos[i].score = infos[i].cand.prior * (0.3 + min(2.0, change)) * (C != nil ? 1.0 : 0.5)
    }
}

// MARK: - Detections and the Kalman track (lab `Track`, `confidence`)

/// One accepted detection, in display-oriented pixels, plus the features the confidence
/// heuristic and the debug notes read.
public struct TracerDetection {
    public var frame: Int
    public var t: Double
    public var x: Double
    public var y: Double
    public var r: Double
    public var score: Double
    public var maha: Double
    /// Index within the track (0 = the seed).
    public var idx: Int
    public var streak: Int = 0
    public var conf: Double = 0
    public var snr: Double = 0
    public var contrast: Double = 0
    public var c2: Double = Double.nan
    public var iso: Double = 0
    public var aniso: Double = 1
    public var polarity: Int = 1
    public var shift: Double = 0
}

/// [det-bg-kalman] Decaying-velocity Kalman track in pixels.
///
/// The decay `rho` is the point of the whole thing: a ball receding from the camera loses image
/// speed by 1/Z, so its per-frame step SHRINKS by a roughly constant ratio (measured 0.42, 0.55,
/// 0.64 over the first three steps of a close-camera driver). A constant-velocity filter puts
/// the second detection 2.5 sigma from its prediction and drops the track.
public final class TracerTrack {
    public private(set) var dets: [TracerDetection] = []
    public private(set) var u: Double
    public private(set) var px = 0.0
    public private(set) var py = 0.0
    public private(set) var vx: Double?
    public private(set) var vy: Double?
    /// 4x4 row-major state covariance, nil until the second detection.
    public private(set) var pcov: [Double]?
    public private(set) var rho = 0.75
    public private(set) var rPred = 0.0
    public private(set) var rRatio = 0.85
    public var misses = 0
    public var alive = true
    public private(set) var streak = 0
    private var params: TracerParams

    public init(u: Double, params: TracerParams) {
        self.u = u
        self.params = params
    }

    public var n: Int { return dets.count }
    public var speed: Double? {
        guard let vx = vx, let vy = vy else { return nil }
        return (vx * vx + vy * vy).squareRoot()
    }

    /// A miss breaks the run of consecutive detections that feeds the confidence support term.
    public func clearStreak() { streak = 0 }

    /// Back to a fresh track, keeping `u` and the parameters. The lab writes `track = Track(u)`
    /// at the two places a seed is abandoned (the second-chance re-seed and the seed switch);
    /// resetting in place keeps the driver from having to thread a new object through the loop.
    public func reset() {
        dets.removeAll()
        px = 0; py = 0
        vx = nil; vy = nil
        pcov = nil
        rho = 0.75
        rPred = 0
        rRatio = 0.85
        misses = 0
        alive = true
        streak = 0
    }

    public func add(_ det: TracerDetection) {
        var d = det
        if let prev = dets.last {
            let dk = Double(max(1, det.frame - prev.frame))
            let dispX = (det.x - prev.x) / dk
            let dispY = (det.y - prev.y) / dk
            if dets.count >= 2, let ovx = vx, let ovy = vy {
                let old = (ovx * ovx + ovy * ovy).squareRoot()
                var ratio = (dispX * dispX + dispY * dispY).squareRoot() / max(old, 1e-6)
                ratio = min(1.05, max(0.4, ratio))
                rho = 0.5 * rho + 0.5 * ratio
            }
            vx = dispX
            vy = dispY
            let rr = det.r / max(prev.r, 1e-3)
            rRatio = 0.5 * rRatio + 0.5 * min(1.0, max(0.6, rr))
        }
        streak = misses == 0 ? streak + 1 : 1
        d.streak = streak
        dets.append(d)
        px = det.x
        py = det.y
        rPred = tracerMedian(dets.suffix(3).map { $0.r })
        misses = 0
        if dets.count >= 2 {
            let cv = dets.count <= 3 ? params.youngVelNoise : params.velNoise
            let sv = cv * (speed ?? 0) + 2 * u
            let sp = 1.5 * u
            pcov = tracerDiag4(sp * sp, sp * sp, sv * sv, sv * sv)
        }
    }

    /// One decaying-velocity prediction step. Returns the predicted position, the 2x2 position
    /// covariance and the predicted radius.
    public func predict() -> (x: Double, y: Double, s: (Double, Double, Double, Double), rPred: Double) {
        guard var P = pcov, let ovx = vx, let ovy = vy else {
            return (px, py, (0, 0, 0, 0), rPred)
        }
        let r = rho
        let nx = px + r * ovx
        let ny = py + r * ovy
        let nvx = r * ovx
        let nvy = r * ovy
        let vn = (nvx * nvx + nvy * nvy).squareRoot()
        let cv = dets.count <= 3 ? params.youngVelNoise : params.velNoise
        let sv = cv * vn + 2 * u
        let sp = 1.5 * u
        // F P F^T for F = [[1,0,r,0],[0,1,0,r],[0,0,r,0],[0,0,0,r]]
        let F: [Double] = [1, 0, r, 0,
                           0, 1, 0, r,
                           0, 0, r, 0,
                           0, 0, 0, r]
        P = tracerMatMul4(tracerMatMul4(F, P), tracerTranspose4(F))
        P[0] += sp * sp
        P[5] += sp * sp
        P[10] += sv * sv
        P[15] += sv * sv
        pcov = P
        px = nx; py = ny; vx = nvx; vy = nvy
        rPred = max(rPred * rRatio, 0.5 * u)
        return (px, py, (P[0], P[1], P[4], P[5]), rPred)
    }

    /// Standard Kalman update against a position measurement.
    public func update(x zx: Double, y zy: Double, rMeas: Double) {
        guard let P = pcov, let ovx = vx, let ovy = vy else { return }
        let rr = max(0.5 * rMeas, 1.5 * u)
        let R = rr * rr
        // S = H P H^T + R (2x2), H selects position.
        let s00 = P[0] + R, s01 = P[1]
        let s10 = P[4], s11 = P[5] + R
        let det = s00 * s11 - s01 * s10
        if abs(det) < 1e-12 { return }
        let i00 = s11 / det, i01 = -s01 / det
        let i10 = -s10 / det, i11 = s00 / det
        // K = P H^T S^-1 → 4x2 built from the first two columns of P.
        var K = [Double](repeating: 0, count: 8)
        for row in 0..<4 {
            let a = P[row * 4 + 0], b = P[row * 4 + 1]
            K[row * 2 + 0] = a * i00 + b * i10
            K[row * 2 + 1] = a * i01 + b * i11
        }
        let ix = zx - px, iy = zy - py
        var x = [px, py, ovx, ovy]
        for row in 0..<4 { x[row] += K[row * 2 + 0] * ix + K[row * 2 + 1] * iy }
        // P = (I - K H) P
        var newP = [Double](repeating: 0, count: 16)
        for row in 0..<4 {
            for col in 0..<4 {
                let khp = K[row * 2 + 0] * P[0 * 4 + col] + K[row * 2 + 1] * P[1 * 4 + col]
                newP[row * 4 + col] = P[row * 4 + col] - khp
            }
        }
        pcov = newP
        px = x[0]; py = x[1]; vx = x[2]; vy = x[3]
    }
}

func tracerDiag4(_ a: Double, _ b: Double, _ c: Double, _ d: Double) -> [Double] {
    var m = [Double](repeating: 0, count: 16)
    m[0] = a; m[5] = b; m[10] = c; m[15] = d
    return m
}

func tracerMatMul4(_ a: [Double], _ b: [Double]) -> [Double] {
    var o = [Double](repeating: 0, count: 16)
    for i in 0..<4 {
        for k in 0..<4 {
            let av = a[i * 4 + k]
            if av == 0 { continue }
            for j in 0..<4 { o[i * 4 + j] += av * b[k * 4 + j] }
        }
    }
    return o
}

func tracerTranspose4(_ a: [Double]) -> [Double] {
    var o = [Double](repeating: 0, count: 16)
    for i in 0..<4 { for j in 0..<4 { o[j * 4 + i] = a[i * 4 + j] } }
    return o
}

/// [det-bg-kalman] Confidence: 0.6 x blob score + 0.4 x track support, capped at 0.7 for
/// sub-1.5-px specks (the labelers could not confirm those either).
///
/// This is an ORDINAL score, not a probability, and the lab says so: on the labelled set the
/// emitted detections are 182 correct and 0 wrong, so there is no negative class to fit a
/// logistic against. The lab keeps a `CALIB` hook for a calibration that has never had the data
/// to be fitted; it is not ported, because an unfitted hook is an invitation to fill it in with
/// a guess. Treat conf < 0.4 as "weight down", never as "probability 0.4".
public func tracerConfidence(_ det: TracerDetection, u: Double) -> Double {
    let support = (min(Double(det.streak), 5) / 5.0) * exp(-0.5 * pow(det.maha / 2.0, 2))
    var conf = det.idx > 0 ? (0.6 * det.score + 0.4 * support) : (0.8 * det.score)
    if det.r < 1.5 * u { conf = min(conf, 0.7) }
    return min(1.0, conf)
}

// MARK: - Launch sector search (lab `sector_search`)

/// The winning seed of one sector search.
public struct SectorHit {
    public var f: Double
    public var cand: BlobCandidate
    public var x: Double
    public var y: Double
}

/// [det-bg-kalman + detect2 pose veto] First-detection search in a sector above the address.
///
/// `luma`, `bg`, `prevLuma`, `satur`, `value` are FULL-frame planes; the ROI is derived here so
/// the geometry stays in one place. The two-polarity `min(|frame-bg|, |frame-prev|)` seed map is
/// the detect2 (d) change: a ball leaving grass for bright sky turns DARK, and requiring it to be
/// new against both the background and the previous frame is what stops an exposure shift
/// flooding the candidate list.
public func tracerSectorSearch(luma: PlaneF, bg: PlaneF, prevLuma: PlaneF,
                               satur: PlaneU8, value: PlaneU8,
                               ax: Double, ay: Double, r0: Double,
                               frame k: Int, impactFrame fi: Int, steps: Int,
                               u: Double, q: Double, sigAll: [Double], thr thrIn: Double,
                               skeleton: GolferSkeleton?,
                               params: TracerParams) -> (best: SectorHit?, vetoes: Int) {
    let W = luma.width, H = luma.height
    let dmin = params.sectorDistMin * u * q
    let dmax = params.sectorDistMax * u * q * Double(min(steps, 3))
    let x0 = Int(max(0, ax - dmax)), x1 = Int(min(Double(W), ax + dmax))
    let y0 = Int(max(0, ay - dmax)), y1 = Int(min(Double(H), ay + 20 * u))
    if x1 - x0 < 8 || y1 - y0 < 8 { return (nil, 0) }
    let rw = x1 - x0, rh = y1 - y0

    var d = PlaneF(width: rw, height: rh)
    var d2 = PlaneF(width: rw, height: rh)
    for y in 0..<rh {
        let srcRow = (y0 + y) * W + x0
        let dstRow = y * rw
        for x in 0..<rw {
            let g = luma.px[srcRow + x]
            d.px[dstRow + x] = g - bg.px[srcRow + x]
            d2.px[dstRow + x] = g - prevLuma.px[srcRow + x]
        }
    }
    if params.localBg {
        let off = tracerLocalOffset(d, params: params)
        for i in 0..<d.px.count { d.px[i] -= off.px[i] }
    }
    var sRoi = PlaneU8(width: rw, height: rh)
    var vRoi = PlaneU8(width: rw, height: rh)
    for y in 0..<rh {
        let srcRow = (y0 + y) * W + x0
        let dstRow = y * rw
        for x in 0..<rw {
            sRoi.px[dstRow + x] = satur.px[srcRow + x]
            vRoi.px[dstRow + x] = value.px[srcRow + x]
        }
    }

    var sig = sigAll.filter { 0.2 * r0 <= 1.75 * $0 && 1.75 * $0 <= 1.5 * r0 }
    if sig.isEmpty { sig = [max(0.8 * u, r0 * 0.5 / 1.75)] }

    // Sector mask: an angular wedge above the address ball, at a plausible distance for the
    // number of frames since launch.
    var allowed = [Bool](repeating: false, count: rw * rh)
    for y in 0..<rh {
        let gy = Double(y0 + y)
        for x in 0..<rw {
            let gx = Double(x0 + x)
            let dist = hypot(gx - ax, gy - ay)
            if dist < dmin || dist > dmax { continue }
            let ang = atan2(gx - ax, -(gy - ay)) * 180.0 / Double.pi
            if abs(ang) <= params.sectorHalfAngleDeg { allowed[y * rw + x] = true }
        }
    }

    var cands: [BlobCandidate] = []
    for pol in params.seedPolarities {
        var dmap = PlaneF(width: rw, height: rh)
        let p = Float(pol)
        for i in 0..<dmap.px.count {
            dmap.px[i] = min(max(p * d.px[i], 0), max(p * d2.px[i], 0))
        }
        cands += tracerBlobCandidates(d: d, d2: d2, satur: sRoi, value: vRoi, u: u,
                                      polarity: pol, sigmas: sig, thr: params.peakThr,
                                      maxPeaks: 200, allowed: allowed, refine: true,
                                      params: params, dmap: dmap)
    }
    var thr = thrIn
    if k < fi { thr = max(thr, 0.6) }

    // [detect2 (c)] crowd count. Shipped with crowdK = 0 — the lab MEASURED k=0.1 costing
    // IMG_3640 its whole track — but kept so the measurement can be repeated.
    if cands.count > 1 {
        let rad2 = pow(params.crowdRadius * u, 2)
        for i in cands.indices {
            var near = 0
            for j in cands.indices {
                let dx = cands[j].x - cands[i].x, dy = cands[j].y - cands[i].y
                if dx * dx + dy * dy <= rad2 && cands[j].resp >= params.crowdRel * cands[i].resp { near += 1 }
            }
            cands[i].crowd = near - 1
        }
    }

    var best: SectorHit?
    var vetoes = 0
    for c in cands {
        let X = c.x + Double(x0), Y = c.y + Double(y0)
        let dx = X - ax, dy = Y - ay
        let dist = hypot(dx, dy)
        let ang = atan2(dx, -dy) * 180.0 / Double.pi
        if dist < dmin || dist > dmax || abs(ang) > params.sectorHalfAngleDeg { continue }
        // First-step size gate. Raised from 1.15 to 1.3 x r0 in the lab because the address
        // radius is measured on other frames and varies ~20 % (it silenced IMG_3652 at -3).
        if c.r > params.seedRMax * r0 || c.r < 0.25 * r0 { continue }
        if let sk = skeleton, sk.contains(X, Y) { vetoes += 1; continue }
        let rExp = steps == 1 ? r0 * 0.65 : r0 * 0.45
        var f = tracerSoft(c.snr, 3, 9) * tracerFSize(c.r, rExp, 0.8) * tracerSoft(110 - c.S, 0, 60)
        f *= tracerSoft(c.contrast, 8, 25)
        f *= exp(-0.5 * pow(ang / 30.0, 2))
        let m = c.c2.isNaN ? 1.0 : c.c2 / max(c.contrast, 1e-3)
        f *= tracerSoft(m, 0.15, 0.6)
        f *= 1 - min(0.85, c.iso / 0.3)
        f *= exp(-pow(max(0.0, c.aniso - 2.6) / 0.6, 2))
        if c.polarity < 0 { f *= 0.8 }
        f /= (1.0 + params.crowdK * Double(c.crowd))
        if best == nil || f > best!.f {
            best = SectorHit(f: f, cand: c, x: X, y: Y)
        }
    }
    if let b = best, b.f < thr { best = nil }
    return (best, vetoes)
}

// MARK: - Per-frame tracking step (the body of the lab `detect()` loop's `else` branch)

public enum TracerTrackStep {
    case detected(TracerDetection)
    case missed
    case stopped(String)
}

/// One tracking frame: predict, build the search ROI, find blob candidates, gate them, and
/// either accept the best or record a miss.
///
/// Two gates here are worth naming because they are the ones that stop a shirt fragment being
/// promoted to a ball:
///   * the SECOND step is confined to a straight cone from the address through the seed — a
///     ball leaves in a straight line for the first frames, a divot or a club head does not;
///   * while the track is young AND fast, the candidate must also be new against the PREVIOUS
///     frame (`c2 / contrast`). The ball moves several radii per frame at that point; a cap or
///     collar sitting still does not.
public func tracerTrackFrame(track: TracerTrack,
                             luma: PlaneF, bg: PlaneF, prevLuma: PlaneF,
                             satur: PlaneU8, value: PlaneU8,
                             frame k: Int, fps: Double,
                             addressX ax: Double, addressY ay: Double,
                             launchFrame kLaunch: Int,
                             sigAll: [Double], u: Double,
                             skeleton: GolferSkeleton?,
                             params: TracerParams) -> (step: TracerTrackStep, vetoes: Int) {
    let W = luma.width, H = luma.height
    var cx = 0.0, cy = 0.0, pad = 0.0, rPred = 0.0
    var s2: (Double, Double, Double, Double)? = nil
    // Cone geometry, only meaningful while the track has exactly one detection.
    var p1x = 0.0, p1y = 0.0, dirX = 0.0, dirY = 0.0, stepLen = 0.0, lo = 0.0, hi = 0.0

    if track.n == 1 {
        let d0 = track.dets[0]
        p1x = d0.x; p1y = d0.y
        let dkFirst = Double(max(1, d0.frame - kLaunch))
        let sx = (p1x - ax) / dkFirst
        let sy = (p1y - ay) / dkFirst
        let gap = Double(k - d0.frame)
        stepLen = hypot(sx, sy)
        dirX = sx / max(stepLen, 1e-6)
        dirY = sy / max(stepLen, 1e-6)
        // A wider band when the seed itself came a frame or more after launch: the first step
        // was then not observed, so its length is a weaker predictor of the second.
        if dkFirst > 1 { lo = 0.3; hi = 2.5 } else { lo = params.step2AlongLo; hi = params.step2AlongHi }
        lo *= gap; hi *= gap
        cx = p1x + dirX * stepLen * 0.5 * (lo + hi)
        cy = p1y + dirY * stepLen * 0.5 * (lo + hi)
        let half = 0.5 * (hi - lo) * stepLen
        let cross = max(0.12 * hi * stepLen, 8 * u)
        pad = half + 2 * cross + 20 * u
        rPred = d0.r * 0.8
    } else {
        let p = track.predict()
        cx = p.x; cy = p.y; rPred = p.rPred
        s2 = p.s
        let sd = max(p.s.0, p.s.3).squareRoot()
        pad = 3.5 * sd + 6 * rPred + 12 * u
    }

    if rPred < params.minRadius * u {
        track.alive = false
        return (.stopped("predicted radius \(String(format: "%.2f", rPred)) px"), 0)
    }
    let x0 = Int(max(0, cx - pad)), x1 = Int(min(Double(W), cx + pad))
    let y0 = Int(max(0, cy - pad)), y1 = Int(min(Double(H), cy + pad))
    if x1 - x0 < 8 || y1 - y0 < 8 {
        track.alive = false
        return (.stopped("left frame"), 0)
    }
    let rw = x1 - x0, rh = y1 - y0

    var d = PlaneF(width: rw, height: rh)
    var d2 = PlaneF(width: rw, height: rh)
    var sRoi = PlaneU8(width: rw, height: rh)
    var vRoi = PlaneU8(width: rw, height: rh)
    for y in 0..<rh {
        let srcRow = (y0 + y) * W + x0
        let dstRow = y * rw
        for x in 0..<rw {
            let g = luma.px[srcRow + x]
            d.px[dstRow + x] = g - bg.px[srcRow + x]
            d2.px[dstRow + x] = g - prevLuma.px[srcRow + x]
            sRoi.px[dstRow + x] = satur.px[srcRow + x]
            vRoi.px[dstRow + x] = value.px[srcRow + x]
        }
    }
    if params.localBg {
        let off = tracerLocalOffset(d, params: params)
        for i in 0..<d.px.count { d.px[i] -= off.px[i] }
    }

    var sig = sigAll.filter { 0.35 * rPred <= 1.75 * $0 && 1.75 * $0 <= 3.0 * rPred + 2 * u }
    if sig.isEmpty { sig = [max(0.8 * u, rPred / 1.75)] }

    var allowed: [Bool]? = nil
    var npk = 60
    if track.n == 1 {
        var mask = [Bool](repeating: false, count: rw * rh)
        for y in 0..<rh {
            let rely = Double(y0 + y) - p1y
            for x in 0..<rw {
                let relx = Double(x0 + x) - p1x
                let along = relx * dirX + rely * dirY
                let cross = abs(relx * dirY - rely * dirX)
                if along >= lo * stepLen && along <= hi * stepLen && cross <= 0.35 * abs(along) + 12 * u {
                    mask[y * rw + x] = true
                }
            }
        }
        allowed = mask
        npk = 150
    }

    var cands = tracerBlobCandidates(d: d, d2: d2, satur: sRoi, value: vRoi, u: u,
                                     polarity: 1, sigmas: sig, thr: params.peakThr,
                                     maxPeaks: npk, allowed: allowed, refine: true, params: params)
    if track.n >= 2 {
        // From the second detection on, the ball may be DARK against bright cloud — search the
        // negative polarity too. (Not before: the cone stage would then admit shadows.)
        cands += tracerBlobCandidates(d: d, d2: d2, satur: sRoi, value: vRoi, u: u,
                                      polarity: -1, sigmas: sig, thr: params.peakThr,
                                      maxPeaks: npk, allowed: nil, refine: true, params: params)
    }

    var bestF = -1.0
    var bestC: BlobCandidate? = nil
    var bestX = 0.0, bestY = 0.0, bestM2 = 0.0
    var vetoes = 0
    for c in cands {
        let X = c.x + Double(x0), Y = c.y + Double(y0)
        var fPose = 1.0
        if let sk = skeleton, sk.contains(X, Y) {
            if track.n <= params.vetoHardN { vetoes += 1; continue }
            fPose = 0.5
        }
        var fGate = 0.0, fSz = 0.0, m2 = 0.0
        if track.n == 1 {
            let relx = X - p1x, rely = Y - p1y
            let along = relx * dirX + rely * dirY
            let crs = abs(relx * dirY - rely * dirX)
            if along < lo * stepLen || along > hi * stepLen { continue }
            let crTol = 0.12 * along + 6 * u
            fGate = exp(-0.5 * pow(crs / crTol, 2))
            if c.r > 1.1 * track.dets[0].r || c.r < 0.3 * track.dets[0].r { continue }
            fSz = tracerFSize(c.r, rPred, 0.7)
            m2 = pow(crs / crTol, 2)
        } else {
            guard let S = s2 else { continue }
            let rr = max(0.5 * c.r, 1.5 * u)
            let a = S.0 + rr * rr, b = S.1
            let cc = S.2, dd = S.3 + rr * rr
            let det = a * dd - b * cc
            if abs(det) < 1e-12 { continue }
            let ix = X - cx, iy = Y - cy
            // innov^T Sfull^-1 innov
            let sx = (dd * ix - b * iy) / det
            let sy = (-cc * ix + a * iy) / det
            m2 = ix * sx + iy * sy
            if m2 > 12.0 { continue }
            fGate = exp(-0.5 * m2 / 2.0)
            fSz = tracerFSize(c.r, rPred, 0.45)
        }
        var f = fGate * fSz * tracerSoft(c.snr, 2.5, 8) * tracerSoft(110 - c.S, 0, 60)
        f *= tracerSoft(c.contrast, 6, 20)
        if !c.c2.isNaN {
            let m = c.c2 / max(c.contrast, 1e-3)
            let vNow = track.speed ?? stepLen
            let youngFast = track.n <= params.motionYoungN && vNow > params.motionMinStepR * max(rPred, 1.0)
            f *= (track.n <= 1 || youngFast) ? tracerSoft(m, 0.1, 0.5) : (0.5 + 0.5 * tracerSoft(m, -0.2, 0.4))
        }
        f *= 1 - min(0.85, c.iso / 0.3)
        let anThr = track.n <= 2 ? 2.6 : 2.0
        f *= exp(-pow(max(0.0, c.aniso - anThr) / 0.7, 2))
        if c.polarity < 0 { f *= 0.8 }
        f *= fPose
        if f > bestF {
            bestF = f; bestC = c; bestX = X; bestY = Y; bestM2 = m2
        }
    }

    var thrK = params.acceptScore
    // A near-perfect prediction in an otherwise empty ROI is allowed a lower bar: at that point
    // the geometry, not the appearance, is the evidence.
    if bestC != nil && track.n >= 2 && bestM2 < 1.0 && cands.count <= 3 { thrK *= 0.5 }
    if let c = bestC, bestF >= thrK {
        var det = TracerDetection(frame: k, t: Double(k) / fps, x: bestX, y: bestY, r: c.r,
                                  score: bestF, maha: bestM2.squareRoot(), idx: track.n)
        det.snr = c.snr; det.contrast = c.contrast; det.c2 = c.c2
        det.iso = c.iso; det.aniso = c.aniso; det.polarity = c.polarity; det.shift = c.shift
        if track.n >= 2 { track.update(x: bestX, y: bestY, rMeas: c.r) }
        track.add(det)
        return (.detected(track.dets[track.dets.count - 1]), vetoes)
    }

    // NB: the miss is NOT accounted here. The lab gives an unconfirmed seed a chance to be
    // REPLACED by a better one before the miss counts against it (`tracerRegisterMiss` below),
    // and counting the miss first would retire seeds the contest would have rescued.
    return (.missed, vetoes)
}

/// Account one frame with no accepted detection. Returns a stop reason when the track dies.
/// Split out of `tracerTrackFrame` because the seed-switch contest runs between the two.
public func tracerRegisterMiss(track: TracerTrack, params: TracerParams) -> String? {
    track.misses += 1
    track.clearStreak()
    let lim = track.n < 4 ? params.maxMissEarly : params.maxMissLate
    if track.misses >= lim {
        track.alive = false
        return "\(track.misses) misses"
    }
    return nil
}

// MARK: - Emission rule (lab: `min_track_emit` + `conf_floor`)

public struct TracerEmission {
    public var detections: [TracerDetection]
    public var confMean: Double
    public var suppressed: Bool
}

/// >= 3 detections AND mean confidence >= 0.4, else emit NOTHING.
///
/// This is the rule that makes the detector safe to ship. Every wrong output the lab's vision
/// skeptic found had confidence <= 0.33, and the emission floor swallowed five wrong 1-2
/// detection seeds (two white caps, a turf clump, two injected-address seeds) on unseen footage.
/// A missing trace is a shrug; a fabricated arc over a shot that never flew is a lie the golfer
/// can see. When in doubt this returns nothing.
public func tracerApplyEmissionRule(_ dets: [TracerDetection], u: Double,
                                    params: TracerParams) -> TracerEmission {
    var scored = dets
    for i in scored.indices { scored[i].conf = tracerConfidence(scored[i], u: u) }
    let confMean = scored.isEmpty ? 0.0 : scored.map { $0.conf }.reduce(0, +) / Double(scored.count)
    let ok = scored.count >= params.minTrackEmit && confMean >= params.confFloor
    return TracerEmission(detections: ok ? scored : [], confMean: confMean, suppressed: !ok && !scored.isEmpty)
}
