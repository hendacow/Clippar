//
//  SwingVisionModule.swift
//  EXPERIMENTAL on-device zero-shot swing/putt/no-shot classifier.
//
//  Standalone Expo module — does NOT touch shot-detector. Exposes one async
//  function, `classifyClip`, that samples frames from a video, runs the bundled
//  MobileCLIP/CLIP image encoder (Core ML), and returns per-frame class scores
//  plus timing. JS pools + decides (swingVisionLogic.ts) so the policy stays
//  testable off-device.
//
//  Pipeline proven on real Clippar footage in
//  experiments/vision-swing-classifier (see FINDINGS.md).
//
import ExpoModulesCore
import AVFoundation
import CoreML
import Vision
import CoreImage

public class SwingVisionModule: Module {

  // Order MUST match class_text_embeddings.json + VISION_CLASSES in the TS.
  private let classNames = ["full_swing", "address", "putt_chip", "no_shot"]

  private var visionModel: VNCoreMLModel?
  private var classEmbeddings: [[Float]] = []
  private var loadError: String?

  public func definition() -> ModuleDefinition {
    Name("SwingVision")

    OnCreate {
      self.loadResources()
    }

    // True only when the model + embeddings loaded — the JS side gates on this
    // so the feature silently no-ops on a build without the model bundled.
    Function("isAvailable") { () -> Bool in
      return self.visionModel != nil && !self.classEmbeddings.isEmpty
    }

    Function("lastError") { () -> String? in
      return self.loadError
    }

    // Classify a clip. Returns { frames: [{full_swing,address,putt_chip,no_shot}],
    // frameCount, elapsedMs } — per-frame scores in time order + wall-clock so
    // the test screen can show real device latency.
    AsyncFunction("classifyClip") { (videoUri: String, frameCount: Int, promise: Promise) in
      self.classify(videoUri: videoUri, frameCount: max(1, frameCount), promise: promise)
    }
  }

  // MARK: - Resource loading

  /// Every bundle the resources might live in: the SwingVisionResources bundle
  /// (podspec resource_bundles), the module's own framework bundle, and main.
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

  /// Find a resource by base name across every candidate bundle + extension.
  private func findResource(_ name: String, _ exts: [String]) -> URL? {
    for b in candidateBundles() {
      for ext in exts {
        if let url = b.url(forResource: name, withExtension: ext) {
          return url
        }
      }
    }
    return nil
  }

  private func loadResources() {
    // The model may ship as an already-compiled .mlmodelc OR as a raw
    // .mlpackage — CocoaPods resource_bundles copies .mlpackage VERBATIM
    // (it does NOT compile it the way an app target would). Handle both:
    // load a .mlmodelc directly; compile a .mlpackage at first launch.
    var compiledURL = findResource("MobileCLIP2S2Image", ["mlmodelc"])
      ?? findResource("ClipImageEncoder", ["mlmodelc"])

    if compiledURL == nil,
       let pkg = findResource("MobileCLIP2S2Image", ["mlpackage"])
         ?? findResource("ClipImageEncoder", ["mlpackage"]) {
      do {
        // Compile once, cache in Application Support so we don't recompile.
        let cacheDir = try FileManager.default.url(
          for: .applicationSupportDirectory, in: .userDomainMask,
          appropriateFor: nil, create: true
        ).appendingPathComponent("SwingVision", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let cached = cacheDir.appendingPathComponent(pkg.deletingPathExtension().lastPathComponent + ".mlmodelc")
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
      // Report what we DID find so the failure is diagnosable from the app.
      let host = Bundle(for: type(of: self))
      let listing = (try? FileManager.default.contentsOfDirectory(atPath: host.bundlePath))?
        .prefix(20).joined(separator: ", ") ?? "n/a"
      loadError = "model not found (.mlmodelc/.mlpackage). host bundle has: \(listing)"
      return
    }
    guard let embURL = findResource("class_text_embeddings", ["json"]) else {
      loadError = "class_text_embeddings.json not found in any bundle"
      return
    }
    do {
      let config = MLModelConfiguration()
      config.computeUnits = .all
      let core = try MLModel(contentsOf: modelURL, configuration: config)
      self.visionModel = try VNCoreMLModel(for: core)

      let data = try Data(contentsOf: embURL)
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      guard let classes = json?["classes"] as? [String: [Double]] else {
        loadError = "bad embeddings json shape"
        return
      }
      self.classEmbeddings = classNames.map { (classes[$0] ?? []).map { Float($0) } }
      let dim = classEmbeddings.first?.count ?? 0
      if dim == 0 || !classEmbeddings.allSatisfy({ $0.count == dim }) {
        loadError = "embedding dim mismatch"
        self.classEmbeddings = []
      }
    } catch {
      loadError = "model load failed: \(error.localizedDescription)"
    }
  }

  // MARK: - Classification

  private func classify(videoUri: String, frameCount: Int, promise: Promise) {
    guard let model = visionModel, !classEmbeddings.isEmpty else {
      promise.reject("E_UNAVAILABLE", loadError ?? "vision model not loaded")
      return
    }
    guard let url = URL(string: videoUri) ?? URL(fileURLWithPath: videoUri) as URL? else {
      promise.reject("E_URI", "bad video uri")
      return
    }

    let asset = AVURLAsset(url: url)
    let started = CFAbsoluteTimeGetCurrent()
    let durationSec = CMTimeGetSeconds(asset.duration)
    guard durationSec.isFinite, durationSec > 0 else {
      promise.reject("E_DURATION", "clip has no duration")
      return
    }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    generator.maximumSize = CGSize(width: 512, height: 512)

    var frames: [[String: Float]] = []
    var sims: [[String: Float]] = []
    for i in 0..<frameCount {
      let t = durationSec * (Double(i) + 0.5) / Double(frameCount)
      let time = CMTime(seconds: t, preferredTimescale: 600)
      guard let cg = try? generator.copyCGImage(at: time, actualTime: nil) else { continue }
      if let emb = embed(cgImage: cg, model: model) {
        frames.append(scores(for: emb))
        sims.append(similarities(for: emb))
      }
    }

    let elapsedMs = (CFAbsoluteTimeGetCurrent() - started) * 1000.0
    promise.resolve([
      "frames": frames,
      // RAW cosine similarities per frame. Critical for open-set rejection:
      // softmax over only 4 golf classes is a FORCED choice, so a video with
      // no golf in it still produces a confident-looking winner. The absolute
      // similarity is what separates real golf (~0.31-0.34) from anything
      // else (~0.06-0.13). JS gates on this.
      "sims": sims,
      "frameCount": frames.count,
      "elapsedMs": elapsedMs,
    ])
  }

  private func embed(cgImage: CGImage, model: VNCoreMLModel) -> [Float]? {
    let request = VNCoreMLRequest(model: model)
    request.imageCropAndScaleOption = .centerCrop
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let obs = request.results?.first as? VNCoreMLFeatureValueObservation,
          let arr = obs.featureValue.multiArrayValue else { return nil }
    var vec = [Float](repeating: 0, count: arr.count)
    let ptr = arr.dataPointer.bindMemory(to: Float32.self, capacity: arr.count)
    for i in 0..<arr.count { vec[i] = ptr[i] }
    return l2(vec)
  }

  /// Raw cosine similarity to each class (both sides L2-normalized), WITHOUT
  /// softmax — the open-set signal.
  private func similarities(for imageEmbedding: [Float]) -> [String: Float] {
    var out: [String: Float] = [:]
    for (i, name) in classNames.enumerated() {
      out[name] = dot(imageEmbedding, classEmbeddings[i])
    }
    return out
  }

  private func scores(for imageEmbedding: [Float]) -> [String: Float] {
    var logits = classEmbeddings.map { dot(imageEmbedding, $0) * 100.0 }
    let maxL = logits.max() ?? 0
    var sum: Float = 0
    for i in logits.indices { logits[i] = expf(logits[i] - maxL); sum += logits[i] }
    var out: [String: Float] = [:]
    for (i, name) in classNames.enumerated() { out[name] = sum > 0 ? logits[i] / sum : 0 }
    return out
  }

  private func dot(_ a: [Float], _ b: [Float]) -> Float {
    var s: Float = 0
    let n = min(a.count, b.count)
    for i in 0..<n { s += a[i] * b[i] }
    return s
  }

  private func l2(_ v: [Float]) -> [Float] {
    var n: Float = 0
    for x in v { n += x * x }
    n = sqrtf(n)
    return n > 0 ? v.map { $0 / n } : v
  }
}
