//
//  SwingLocalizer.swift
//  Finds WHEN the swing happens in a golf clip.
//
//  Swift port of experiments/vision-swing-classifier (see FINDINGS_V2.md).
//  Measured on 79 labelled clips: 27/28 real swings timed correctly to +/-0.15s,
//  1/25 false positives.
//
//  THE SIGNAL IS MOTION, NOT SEMANTICS.
//  Per-frame motion energy has an unmistakable golf shape: a DIP where the club
//  reverses at the top of the backswing, then the clip's sharpest SPIKE ~0.20s
//  later as it comes down. Core ML never sees most of the clip — it only judges
//  a handful of candidate moments. That split is why this is cheap: the precise
//  part is a pixel subtraction on 160x90 grayscale, and the expensive part runs
//  ~6 times per clip instead of every frame.
//
import AVFoundation
import CoreML
import Vision
import CoreGraphics

struct SwingCandidate {
  var tTop: Double
  var tImpact: Double
  var rise: Double      // valley depth, raw
  var norm: Double      // valley depth / clip motion scale — comparable across clips
  var proto: Double     // prototype evidence, filled in later
}

struct LocalizerParams {
  var minScore = -0.02
  var tieRel = 0.50
  /// Seconds trimmed off each end before candidates are considered. Recordings
  /// start before the golfer sets up and end with them walking away or picking
  /// the phone up, so both ends contain motion that is not the shot.
  ///
  /// 4.0, not the 2.5 this shipped with. On IMG_0592 the golfer walking out of
  /// the bunker at 17.02s (3.7s before the end of a 20.7s clip) beat the real
  /// shot at 7.28s — not on motion, where the shot leads 0.327 to 0.283, but on
  /// the prototype by 0.0099, which is noise on a scale where every frame is a
  /// golf course. 2.5 was validated against the experiment's k-NN ranking,
  /// which picks different candidates than the averaged prototypes that ship.
  ///
  /// Costs nothing because of the 20% cap below: for any clip under 12.5s this
  /// is a no-op, and no verified instant across the 42 labelled clips moves
  /// inside the guard. Tried first and rejected, both measured end-to-end:
  /// tightening tieRel (40/42 -> 39/42, trades this clip for putts) and making
  /// the prototype win by a margin (40/42 -> 38/42).
  var edgeGuard = 4.0
  var edgeGuardMaxFrac = 0.20
  var upWindow = 0.34
  var backWindow = 0.70
  var nmsGap = 1.20
  var nCandidates = 6
  var winBefore = 0.4
  var winAfter = 0.9
  var motionWidth = 160
  var motionHeight = 90
  var energyPercentile = 99.5
  var embedFps = 10.0
  /// Below this motion valley depth the stroke is a putt, which is left
  /// untrimmed. FALLBACK ONLY — used when Vision could not lock on to a body,
  /// because pose separates the classes far better (see SwingPose).
  ///
  /// Deliberately looser than the 0.45 that motion used when it decided alone.
  /// The two failure modes are not symmetric: trimming a putt by mistake throws
  /// away footage the user wanted, while leaving a shot whole merely fails to
  /// help. So with the better signal unavailable, lean toward leaving it alone.
  ///
  /// NOT MEASURED. On all 56 labelled clips Vision locked on to a body, so this
  /// path never executed and there is no evidence for 0.60 over any other
  /// value — it is the asymmetry argument above and nothing more. The clips
  /// that would exercise it (golfer too small or too occluded for Vision) are
  /// exactly the ones absent from the set. Treat it as a guess until a clip
  /// actually falls through here.
  var puttFallbackNormMax = 0.60
}

enum SwingLocalizer {

  // MARK: - Motion

  /// Decode the whole clip as tiny grayscale frames and return, per frame pair,
  /// the motion energy plus an accumulated per-pixel heat map.
  ///
  /// Energy is a HIGH PERCENTILE, not a mean: a golfer occupies a small part of
  /// the frame, so a mean is swamped by static grass and the swing barely
  /// registers. The 99.5th percentile tracks the fastest-moving pixels, which
  /// are the club and hands.
  ///
  /// Reads the luma plane of 420f directly — no colour conversion, no CIContext.
  static func motionProfile(
    asset: AVAsset, params: LocalizerParams
  ) -> (energy: [Double], fps: Double, heat: [Double], w: Int, h: Int)? {
    guard let track = asset.tracks(withMediaType: .video).first else { return nil }
    let w = params.motionWidth, h = params.motionHeight

    // Phone clips are portrait video stored as landscape plus a rotation flag.
    // The offline reference auto-rotates BEFORE squashing to 160x90, so a
    // portrait clip gets a very different resampling than the raw landscape
    // buffer would. Reading raw and squashing to 160x90 produced a different
    // energy curve and mis-ranked IMG_0592. So for a rotated track, request the
    // SWAPPED size and transpose — that reproduces rotate-then-resize.
    //
    // (The energy value itself is invariant to any permutation of pixels; what
    // matters here is that the RESAMPLING matches. The transpose is for the heat
    // map, which must come out in display orientation for the crop to be right.)
    let rotation = rotationDegrees(track.preferredTransform)
    let swapped = rotation == 90 || rotation == 270
    let reqW = swapped ? h : w
    let reqH = swapped ? w : h
    let settings: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange),
      kCVPixelBufferWidthKey as String: reqW,
      kCVPixelBufferHeightKey as String: reqH,
    ]
    guard let reader = try? AVAssetReader(asset: asset) else { return nil }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }

    let n = w * h
    var prev = [UInt8](repeating: 0, count: n)
    var cur = [UInt8](repeating: 0, count: n)
    var havePrev = false
    var energy: [Double] = []
    var heat = [Double](repeating: 0, count: n)
    var frameCount = 0

    while let sample = output.copyNextSampleBuffer() {
      guard let px = CMSampleBufferGetImageBuffer(sample) else { continue }
      CVPixelBufferLockBaseAddress(px, .readOnly)
      defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
      guard let base = CVPixelBufferGetBaseAddressOfPlane(px, 0) else { continue }
      let stride = CVPixelBufferGetBytesPerRowOfPlane(px, 0)
      let src = base.assumingMemoryBound(to: UInt8.self)
      let srcH = min(reqH, CVPixelBufferGetHeightOfPlane(px, 0))
      let srcW = min(reqW, CVPixelBufferGetWidthOfPlane(px, 0))
      if swapped {
        // Rotate into display orientation while copying. src is reqW x reqH
        // (portrait); dst is w x h (landscape).
        for sy in 0..<srcH {
          let rowStart = sy * stride
          for sx in 0..<srcW {
            let v = src[rowStart + sx]
            // 90 CW: dst(x,y) = src(y, H-1-x)  ->  x = H-1-sy, y = sx
            // 270  : dst(x,y) = src(W-1-y, x)  ->  x = sy,      y = W-1-sx
            let dx = rotation == 90 ? (srcH - 1 - sy) : sy
            let dy = rotation == 90 ? sx : (srcW - 1 - sx)
            if dx >= 0 && dx < w && dy >= 0 && dy < h { cur[dy * w + dx] = v }
          }
        }
      } else {
        for y in 0..<srcH {
          let rowStart = y * stride
          let dstStart = y * w
          for x in 0..<srcW { cur[dstStart + x] = src[rowStart + x] }
        }
      }
      frameCount += 1

      if havePrev {
        // 256-bin histogram gives the exact percentile in one pass — no sort.
        var hist = [Int](repeating: 0, count: 256)
        for i in 0..<n {
          let d = Int(cur[i]) &- Int(prev[i])
          let a = d < 0 ? -d : d
          hist[a] += 1
          heat[i] += Double(a)
        }
        let target = Int((1.0 - params.energyPercentile / 100.0) * Double(n))
        var seen = 0
        var value = 0
        for v in stride2(from: 255, through: 0, by: -1) {
          seen += hist[v]
          if seen >= max(1, target) { value = v; break }
        }
        energy.append(Double(value))
      }
      swap(&prev, &cur)
      havePrev = true
    }
    reader.cancelReading()
    guard energy.count >= 3, frameCount > 1 else { return nil }

    let dur = CMTimeGetSeconds(asset.duration)
    guard dur.isFinite, dur > 0 else { return nil }
    let fps = Double(frameCount) / dur
    let denom = Double(max(1, energy.count))
    for i in 0..<n { heat[i] /= denom }
    return (energy, fps, heat, w, h)
  }

  private static func stride2(from: Int, through: Int, by: Int) -> StrideThrough<Int> {
    return Swift.stride(from: from, through: through, by: by)
  }

  static func smooth(_ v: [Double], _ k: Int = 3) -> [Double] {
    guard v.count >= k, k > 1 else { return v }
    var out = [Double](repeating: 0, count: v.count)
    let half = k / 2
    for i in 0..<v.count {
      var s = 0.0, c = 0.0
      for j in max(0, i - half)...min(v.count - 1, i + half) { s += v[j]; c += 1 }
      out[i] = s / c
    }
    return out
  }

  // MARK: - Candidates

  /// Find the VALLEY BETWEEN TWO PEAKS — backswing before, downswing after.
  ///
  ///     score = min(peak_before, peak_after) - energy_here
  ///
  /// The naive `peak_after - energy_here` is WRONG and was measured failing: it
  /// rewards any transition out of stillness, so it locks onto ADDRESS (which is
  /// perfectly still, followed by the takeaway). Requiring motion on BOTH sides
  /// encodes the actual physics — the club is swinging up before the top and
  /// down after it — and address has nothing before it.
  static func candidates(
    energy: [Double], fps: Double, duration: Double, params: LocalizerParams
  ) -> [SwingCandidate] {
    let e = smooth(energy, 3)
    guard e.count >= 4, fps > 0 else { return [] }
    let dt = 1.0 / fps
    let wUp = max(2, Int((params.upWindow / dt).rounded()))
    let wBk = max(2, Int((params.backWindow / dt).rounded()))

    var scores = [Double](repeating: 0, count: e.count)
    var peaks = [Int](repeating: 0, count: e.count)
    for i in 0..<e.count {
      let aLo = i + 1, aHi = min(e.count, i + wUp + 1)
      let bLo = max(0, i - wBk), bHi = i
      if aLo >= aHi || bLo >= bHi { continue }
      var pk = aLo
      for j in aLo..<aHi where e[j] > e[pk] { pk = j }
      var before = e[bLo]
      for j in bLo..<bHi where e[j] > before { before = e[j] }
      peaks[i] = pk
      scores[i] = min(before, e[pk]) - e[i]
    }

    // Scale-free: a golfer 40m away moves far fewer pixels than one at 5m, but
    // the SHAPE of the valley is identical. Normalising is what lets one
    // threshold serve a close-up 1080p clip and a distant 4K one.
    let sorted = e.sorted()
    func pct(_ p: Double) -> Double {
      let idx = min(sorted.count - 1, max(0, Int(p * Double(sorted.count))))
      return sorted[idx]
    }
    let scale = max(pct(0.95) - pct(0.05), 1e-3)

    // Recordings start before the golfer sets up and end with walking away or
    // picking the phone up, so both ends contain phone handling — the largest
    // motion in some clips is the end-of-clip pickup, not the swing. Capped at a
    // fraction of duration because putt clips run 4-9s and a flat guard removed
    // every candidate from the shortest ones.
    let guardSec = min(params.edgeGuard, duration * params.edgeGuardMaxFrac)

    var order = Array(0..<e.count)
    order.sort { scores[$0] > scores[$1] }
    var used = [Bool](repeating: false, count: e.count)
    var out: [SwingCandidate] = []
    let nmsHalf = Int(params.nmsGap / dt)
    for i in order {
      if scores[i] <= 0 || used[i] { continue }
      let tTop = (Double(i) + 0.5) / fps
      if tTop < guardSec || tTop > duration - guardSec { continue }
      out.append(SwingCandidate(
        tTop: tTop,
        tImpact: (Double(peaks[i]) + 0.5) / fps,
        rise: scores[i],
        norm: scores[i] / scale,
        proto: 0
      ))
      for j in max(0, i - nmsHalf)..<min(e.count, i + nmsHalf) { used[j] = true }
      if out.count >= params.nCandidates { break }
    }
    return out
  }

  // MARK: - Golfer crop

  /// Square crop centred on where the motion is — that's the golfer. Lets a
  /// golfer who is a few percent of a 4K frame fill the model's 256px input.
  ///
  /// Returns a rect in NORMALISED coordinates of the *decoded* (untransformed)
  /// frame; the caller maps it through the track's preferred transform.
  static func golferBox(heat: [Double], w: Int, h: Int, pad: Double = 2.6) -> CGRect {
    guard heat.count == w * h else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
    let sorted = heat.sorted()
    let p75 = sorted[min(sorted.count - 1, Int(0.75 * Double(sorted.count)))]
    var total = 0.0, cx = 0.0, cy = 0.0
    for y in 0..<h {
      for x in 0..<w {
        let m = max(0, heat[y * w + x] - p75)
        if m <= 0 { continue }
        total += m; cx += m * Double(x); cy += m * Double(y)
      }
    }
    if total <= 0 { return CGRect(x: 0, y: 0, width: 1, height: 1) }
    cx /= total; cy /= total
    var vx = 0.0, vy = 0.0
    for y in 0..<h {
      for x in 0..<w {
        let m = max(0, heat[y * w + x] - p75)
        if m <= 0 { continue }
        vx += m * (Double(x) - cx) * (Double(x) - cx)
        vy += m * (Double(y) - cy) * (Double(y) - cy)
      }
    }
    let sx = (vx / total).squareRoot(), sy = (vy / total).squareRoot()
    // Normalised against the SHORT side so the box stays square in real pixels.
    let half = max(max(sx, sy) * pad, Double(min(w, h)) * 0.22)
    return CGRect(x: (cx - half) / Double(w), y: (cy - half) / Double(h),
                  width: 2 * half / Double(w), height: 2 * half / Double(h))
  }

  /// Rotation the track's preferred transform applies, in degrees (0/90/180/270).
  static func rotationDegrees(_ t: CGAffineTransform) -> Int {
    let angle = atan2(t.b, t.a) * 180 / .pi
    let r = Int((angle < 0 ? angle + 360 : angle).rounded())
    switch r {
    case 80...100: return 90
    case 170...190: return 180
    case 260...280: return 270
    default: return 0
    }
  }

  /// Map a normalised point from decoded-frame space into display space.
  /// The motion pass reads raw buffers (untransformed) but Core ML must see an
  /// upright golfer, so the crop centre has to be rotated to match.
  static func mapNormalized(_ p: CGPoint, rotation: Int) -> CGPoint {
    switch rotation {
    case 90:  return CGPoint(x: 1 - p.y, y: p.x)
    case 180: return CGPoint(x: 1 - p.x, y: 1 - p.y)
    case 270: return CGPoint(x: p.y, y: 1 - p.x)
    default:  return p
    }
  }
}
