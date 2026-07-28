//
//  SwingVisionModule.swift
//  EXPERIMENTAL on-device swing LOCALIZER.
//
//  Standalone Expo module — does NOT touch shot-detector. Exposes one async
//  function, `localizeSwing`, that answers the question that matters for
//  trimming: at what second did the golfer swing?
//
//  This REPLACES the earlier zero-shot text-prompt classifier, which was
//  measured wrong in two ways: it called a video with no golf in it a full swing
//  (softmax over four golf classes is a forced choice), and asked for "top of the
//  backswing" it returned the held FINISH pose ~0.3s after impact. Neither is
//  fixable by prompt tweaking — see experiments/vision-swing-classifier.
//
//  The precise work is done by motion (SwingLocalizer), which is a pixel
//  subtraction on 160x90 grayscale. Core ML runs only on a handful of candidate
//  moments, to answer "is a golfer actually stroking the ball here?" — compared
//  against IMAGE prototypes averaged from verified frames, not text prompts.
//
import ExpoModulesCore
import AVFoundation
import CoreML
import Vision
import CoreGraphics

public class SwingVisionModule: Module {

  private var visionModel: VNCoreMLModel?
  private var protoSwing: [Float] = []
  private var protoPutt: [Float] = []
  private var protoNeg: [Float] = []
  private var params = LocalizerParams()
  private var loadError: String?

  public func definition() -> ModuleDefinition {
    Name("SwingVision")

    OnCreate { self.loadResources() }

    Function("isAvailable") { () -> Bool in
      return self.visionModel != nil && !self.protoSwing.isEmpty
    }

    Function("lastError") { () -> String? in self.loadError }

    // Returns { decision, tTop, tImpact, confidence, candidates[], elapsedMs }.
    // tTop is the top of the backswing; tImpact the downswing peak ~0.2s later.
    AsyncFunction("localizeSwing") { (videoUri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        self.localize(videoUri: videoUri, promise: promise)
      }
    }
  }

  // MARK: - Resource loading

  private func candidateBundles() -> [Bundle] {
    var bundles: [Bundle] = []
    let host = Bundle(for: type(of: self))
    for b in [host, Bundle.main] {
      if let url = b.url(forResource: "SwingVisionResources", withExtension: "bundle"),
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

  private func loadResources() {
    // CocoaPods resource_bundles copies a .mlpackage VERBATIM — it does NOT
    // compile it the way an app target would — so handle both forms: load a
    // .mlmodelc directly, or compile a .mlpackage once and cache the result.
    var compiledURL = findResource("MobileCLIP2S2Image", ["mlmodelc"])
    if compiledURL == nil, let pkg = findResource("MobileCLIP2S2Image", ["mlpackage"]) {
      do {
        let cacheDir = try FileManager.default.url(
          for: .applicationSupportDirectory, in: .userDomainMask,
          appropriateFor: nil, create: true
        ).appendingPathComponent("SwingVision", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let cached = cacheDir.appendingPathComponent("MobileCLIP2S2Image.mlmodelc")
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
      let host = Bundle(for: type(of: self))
      let listing = (try? FileManager.default.contentsOfDirectory(atPath: host.bundlePath))?
        .prefix(20).joined(separator: ", ") ?? "n/a"
      loadError = "model not found (.mlmodelc/.mlpackage). host bundle has: \(listing)"
      return
    }
    guard let protoURL = findResource("swing_prototypes", ["json"]) else {
      loadError = "swing_prototypes.json not found in any bundle"
      return
    }
    do {
      let config = MLModelConfiguration()
      config.computeUnits = .all
      visionModel = try VNCoreMLModel(for: try MLModel(contentsOf: modelURL, configuration: config))

      let json = try JSONSerialization.jsonObject(
        with: try Data(contentsOf: protoURL)) as? [String: Any]
      guard let protos = json?["prototypes"] as? [String: [Double]],
            let s = protos["swing"], let p = protos["putt"], let n = protos["negative"],
            !s.isEmpty, s.count == p.count, s.count == n.count else {
        loadError = "bad swing_prototypes.json shape"
        return
      }
      protoSwing = s.map { Float($0) }
      protoPutt = p.map { Float($0) }
      protoNeg = n.map { Float($0) }

      // Every tuned constant travels with the vectors so Swift and the Python
      // reference cannot silently drift apart.
      if let pr = json?["params"] as? [String: Double] {
        params.minScore = pr["minScore"] ?? params.minScore
        params.tieRel = pr["tieRel"] ?? params.tieRel
        params.edgeGuard = pr["edgeGuard"] ?? params.edgeGuard
        params.edgeGuardMaxFrac = pr["edgeGuardMaxFrac"] ?? params.edgeGuardMaxFrac
        params.upWindow = pr["upWindow"] ?? params.upWindow
        params.backWindow = pr["backWindow"] ?? params.backWindow
        params.nmsGap = pr["nmsGap"] ?? params.nmsGap
        params.winBefore = pr["winBefore"] ?? params.winBefore
        params.winAfter = pr["winAfter"] ?? params.winAfter
        params.embedFps = pr["embedFps"] ?? params.embedFps
        // Read the old key too: a bundle exported before pose became the
        // primary signal only carries `puttNormMax`, and silently falling back
        // to the built-in default would hide that the file is stale.
        params.puttFallbackNormMax = pr["puttFallbackNormMax"]
          ?? pr["puttNormMax"] ?? params.puttFallbackNormMax
        if let n = pr["nCandidates"] { params.nCandidates = Int(n) }
        if let w = pr["motionWidth"] { params.motionWidth = Int(w) }
        if let h = pr["motionHeight"] { params.motionHeight = Int(h) }
        params.energyPercentile = pr["energyPercentile"] ?? params.energyPercentile
      }
    } catch {
      loadError = "model load failed: \(error.localizedDescription)"
    }
  }

  // MARK: - Localization

  private func localize(videoUri: String, promise: Promise) {
    // One pool around the whole call. Decoded frames, Vision request handlers
    // and Core ML feature values are autoreleased, and a GCD block's implicit
    // pool is only drained when the block ENDS — so without this, ~110 decoded
    // frames' worth of temporaries pile up for the whole clip. That peak is
    // what caps how many clips can run at once; the batch below adds a second,
    // tighter pool per frame. shot-detector wraps detectAndTrim for exactly
    // this reason (see ShotDetectorModule.detectAndTrimVideo).
    autoreleasepool {
    guard let model = visionModel, !protoSwing.isEmpty else {
      promise.reject("E_UNAVAILABLE", loadError ?? "swing localizer not loaded")
      return
    }
    let url = URL(string: videoUri).flatMap { $0.scheme != nil ? $0 : nil }
      ?? URL(fileURLWithPath: videoUri)
    let asset = AVURLAsset(url: url)
    let started = CFAbsoluteTimeGetCurrent()
    let duration = CMTimeGetSeconds(asset.duration)
    guard duration.isFinite, duration > 0 else {
      promise.reject("E_DURATION", "clip has no duration")
      return
    }

    guard let profile = SwingLocalizer.motionProfile(asset: asset, params: params) else {
      promise.reject("E_DECODE", "could not read video frames")
      return
    }
    var cands = SwingLocalizer.candidates(
      energy: profile.energy, fps: profile.fps, duration: duration, params: params)
    if cands.isEmpty {
      promise.resolve(result(decision: "NO_SWING", best: nil, cands: [],
                             started: started, motionFps: profile.fps, duration: duration))
      return
    }

    // Crop to where the motion is. The prototypes were built from exactly this
    // crop (clip-level, motion-guided), so matching it here is what keeps the
    // device scores comparable to the offline ones.
    let boxRaw = SwingLocalizer.golferBox(heat: profile.heat, w: profile.w, h: profile.h)
    let rotation = asset.tracks(withMediaType: .video).first
      .map { SwingLocalizer.rotationDegrees($0.preferredTransform) } ?? 0
    let centre = SwingLocalizer.mapNormalized(
      CGPoint(x: boxRaw.midX, y: boxRaw.midY), rotation: rotation)

    // ONE generator for BOTH the Core ML pass and the pose pass below.
    let generator = SwingLocalizer.makeFrameGenerator(asset: asset)

    // One embedding per distinct sample time — candidate windows can overlap.
    var times: [Double] = []
    for c in cands {
      var t = max(0, c.tTop - params.winBefore)
      let end = min(duration, c.tTop + params.winAfter)
      while t <= end {
        let snapped = (t * params.embedFps).rounded() / params.embedFps
        if !times.contains(where: { abs($0 - snapped) < 1e-6 }) { times.append(snapped) }
        t += 1.0 / params.embedFps
      }
    }
    times.sort()

    // `times` is already sorted, which is what lets the generator serve the
    // whole list from one forward decode pass instead of ~80 exact-frame seeks,
    // and lets that decoding overlap with Core ML on the ANE. Frames, crops and
    // times are identical to the copyCGImage loop this replaces.
    var scoreAt: [Double: Double] = [:]
    SwingLocalizer.forEachFrame(generator: generator, times: times) { t, cg in
      guard let cropped = squareCrop(cg, centreNormalized: centre, boxRaw: boxRaw) else { return }
      guard let emb = embed(cgImage: cropped, model: model) else { return }
      // max(swing, putt) - negative. A putt looks nothing like a full swing —
      // no club above the head — so scoring putt frames against a swing-only
      // prototype makes them NEGATIVE and one gate rejects them all.
      scoreAt[t] = Double(max(dot(emb, protoSwing), dot(emb, protoPutt)) - dot(emb, protoNeg))
    }

    for i in cands.indices {
      let lo = cands[i].tTop - params.winBefore, hi = cands[i].tTop + params.winAfter
      let inWindow = times.filter { $0 >= lo - 1e-6 && $0 <= hi + 1e-6 }
        .compactMap { scoreAt[$0] }.sorted(by: >)
      cands[i].proto = inWindow.isEmpty ? -9
        : inWindow.prefix(3).reduce(0, +) / Double(min(3, inWindow.count))
    }

    let ok = cands.filter { $0.proto >= params.minScore }
    guard !ok.isEmpty else {
      promise.resolve(result(decision: "NO_SWING", best: nil, cands: cands,
                             started: started, motionFps: profile.fps, duration: duration))
      return
    }
    // MOTION DECIDES, THE PROTOTYPE BREAKS TIES. Ranking purely by prototype is
    // worse — it peaks on the held finish pose. Ranking purely by motion loses
    // genuine ties arbitrarily, and on putts the stroke is NOT the largest
    // motion in the clip (walking is), so the prototype needs real latitude.
    let bestNorm = ok.map { $0.norm }.max() ?? 0
    let near = ok.filter { $0.norm >= bestNorm * (1 - params.tieRel) }
    let best = near.max(by: { $0.proto < $1.proto })

    // STROKE TYPE — POSE DECIDES, motion is only the fallback.
    //
    // "swing" here means A SHOT WORTH TRIMMING, which includes chips, pitches
    // and bunker shots. The only question the trim policy asks is shot-or-putt.
    //
    // This used to be the other way round: motion decided and pose could only
    // DEMOTE a swing to a putt. That structure could never classify a chip.
    // A chip's motion amplitude is modest, so motion called it a putt, and pose
    // — the one signal that gets chips right — was never consulted at all.
    //
    // Measured on 56 clips (25 putts, 21 full swings, 10 chips), with both the
    // instant AND the wrist height taken from THIS code path rather than the
    // experiment's k-NN ranking, which picks different instants:
    //     motion decides, pose demotes  49/56   chips 6/10   swings 20/21
    //     pose decides, motion fallback 52/56   chips 9/10   swings 21/21
    // It costs one putt (IMG_0582, +0.055) and wins four.
    //
    // Pose is the better signal because motion amplitude is DISTANCE-dependent
    // — a full swing filmed from 40m moves fewer pixels than a putt filmed from
    // 3m — while wrist height is normalised by the golfer's own torso and so is
    // invariant to distance and camera angle. Motion still decides when Vision
    // cannot lock on to a body at all (golfer too small in frame), and it uses
    // a deliberately conservative bar there — see puttFallbackNormMax.
    //
    // Cost: pose now runs on putts too, which it previously skipped. That is
    // ~29 body-pose requests, around 0.7s, on clips that used to skip them.
    var wristHeight: Double? = nil
    if let b = best {
      wristHeight = SwingPose.peakWristHeight(asset: asset, tTop: b.tTop, generator: generator)
    }
    let strokeType: String
    if let wh = wristHeight {
      strokeType = wh < SwingPose.shotMinWristHeight ? "putt" : "swing"
    } else {
      strokeType = (best.map { $0.norm < params.puttFallbackNormMax } ?? true)
        ? "putt" : "swing"
    }
    promise.resolve(result(decision: "SWING", best: best, cands: cands,
                           started: started, motionFps: profile.fps,
                           duration: duration, strokeType: strokeType,
                           wristHeight: wristHeight))
    } // autoreleasepool
  }

  private func result(decision: String, best: SwingCandidate?, cands: [SwingCandidate],
                      started: CFAbsoluteTime, motionFps: Double,
                      duration: Double, strokeType: String = "swing",
                      wristHeight: Double? = nil) -> [String: Any] {
    var out: [String: Any] = [
      "decision": decision,
      "elapsedMs": (CFAbsoluteTimeGetCurrent() - started) * 1000.0,
      "motionFps": motionFps,
      "durationSec": duration,
      "candidates": cands.map {
        ["tTop": $0.tTop, "tImpact": $0.tImpact, "norm": $0.norm, "proto": $0.proto]
      },
    ]
    if let b = best {
      out["tTop"] = b.tTop
      out["tImpact"] = b.tImpact
      out["confidence"] = b.proto
      out["norm"] = b.norm
      out["strokeType"] = strokeType
      // Surfaced so the dev harness can show WHY a clip was called a putt, and
      // distinguish "pose said so" from "pose never locked on".
      if let wh = wristHeight { out["wristHeight"] = wh }
    }
    return out
  }

  /// Crop a square around the golfer, clamped inside the image.
  private func squareCrop(_ cg: CGImage, centreNormalized c: CGPoint,
                          boxRaw: CGRect) -> CGImage? {
    let W = CGFloat(cg.width), H = CGFloat(cg.height)
    // Box size is expressed against the short side so it stays square in pixels.
    let side = min(W, H) * max(boxRaw.width, boxRaw.height)
    let s = min(max(side, 32), min(W, H))
    let x = min(max(c.x * W - s / 2, 0), W - s)
    let y = min(max(c.y * H - s / 2, 0), H - s)
    return cg.cropping(to: CGRect(x: x, y: y, width: s, height: s))
  }

  private func embed(cgImage: CGImage, model: VNCoreMLModel) -> [Float]? {
    let request = VNCoreMLRequest(model: model)
    // The image is already square, so scaleFill introduces no distortion and
    // matches the offline pipeline (crop square, then resize to 256).
    request.imageCropAndScaleOption = .scaleFill
    guard (try? VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])) != nil,
          let obs = request.results?.first as? VNCoreMLFeatureValueObservation,
          let arr = obs.featureValue.multiArrayValue else { return nil }
    var vec = [Float](repeating: 0, count: arr.count)
    let ptr = arr.dataPointer.bindMemory(to: Float32.self, capacity: arr.count)
    for i in 0..<arr.count { vec[i] = ptr[i] }
    return l2(vec)
  }

  private func dot(_ a: [Float], _ b: [Float]) -> Float {
    var s: Float = 0
    for i in 0..<min(a.count, b.count) { s += a[i] * b[i] }
    return s
  }

  private func l2(_ v: [Float]) -> [Float] {
    var n: Float = 0
    for x in v { n += x * x }
    n = sqrtf(n)
    return n > 0 ? v.map { $0 / n } : v
  }
}
