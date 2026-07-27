//
//  SwingVisionClassifier.swift
//  EXPERIMENTAL — on-device zero-shot swing/putt/no-shot classifier.
//
//  ⚠️ Not wired into the app. Lives in experiments/ on purpose so it touches
//  NOTHING in the live shot-detector. To activate later: move this file into
//  modules/shot-detector/ios/, drop MobileCLIP2S2Image.mlpackage +
//  class_text_embeddings.json into the module bundle, and register the
//  `classifySwingVision` AsyncFunction (see README.md). Until then it is inert.
//
//  Pipeline (mirrors the desktop proof in verify_pipeline.py, which ran on real
//  Clippar footage):
//    sample N frames from the clip
//      → MobileCLIP2 image encoder (Core ML) → 512-d embedding per frame
//      → cosine similarity to the BAKED class text embeddings → softmax
//      → return per-frame class scores to JS, which pools + decides
//        (swingVisionLogic.ts).
//
//  The text embeddings are precomputed offline (dump_embeds.py), so the device
//  ships ONLY the image encoder — no text tower, no tokenizer.
//
import Foundation
import AVFoundation
import CoreML
import Vision
import CoreImage

@available(iOS 15.0, *)
final class SwingVisionClassifier {

    // Order MUST match class_text_embeddings.json and VISION_CLASSES in the TS.
    static let classNames = ["full_swing", "address", "putt_chip", "no_shot"]

    private let model: VNCoreMLModel
    private let classEmbeddings: [[Float]]   // [C][512], L2-normalized
    private let temperature: Float

    /// - Parameters:
    ///   - modelURL: compiled MobileCLIP2 image-encoder (.mlmodelc).
    ///   - embeddingsURL: class_text_embeddings.json produced by dump_embeds.py.
    init(modelURL: URL, embeddingsURL: URL, temperature: Float = 100) throws {
        let config = MLModelConfiguration()
        config.computeUnits = .all  // ANE when available; falls back gracefully.
        let core = try MLModel(contentsOf: modelURL, configuration: config)
        self.model = try VNCoreMLModel(for: core)
        self.temperature = temperature

        let data = try Data(contentsOf: embeddingsURL)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let classes = json?["classes"] as? [String: [Double]] else {
            throw NSError(domain: "SwingVision", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "bad embeddings json"])
        }
        self.classEmbeddings = SwingVisionClassifier.classNames.map { name in
            (classes[name] ?? []).map { Float($0) }
        }
        // Sanity: every class vector present and same length.
        let dim = classEmbeddings.first?.count ?? 0
        guard dim > 0, classEmbeddings.allSatisfy({ $0.count == dim }) else {
            throw NSError(domain: "SwingVision", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "embedding dim mismatch"])
        }
    }

    /// Classify a clip. Returns one [class: score] dictionary per sampled frame,
    /// in time order. JS pools + decides (keeps the policy testable off-device).
    func classify(videoURL: URL, frameCount: Int = 8) async throws -> [[String: Float]] {
        let asset = AVURLAsset(url: videoURL)
        let duration = try await asset.load(.duration)
        let seconds = CMTimeGetSeconds(duration)
        guard seconds > 0 else { return [] }

        // Evenly spaced samples across the clip. The finish pose is held ~1s, so
        // 8 samples across a typical 5–20s clip reliably lands on swing/finish.
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        generator.maximumSize = CGSize(width: 512, height: 512)

        var results: [[String: Float]] = []
        for i in 0..<frameCount {
            let t = seconds * (Double(i) + 0.5) / Double(frameCount)
            let time = CMTime(seconds: t, preferredTimescale: 600)
            guard let cg = try? generator.copyCGImage(at: time, actualTime: nil) else {
                continue
            }
            if let emb = try embed(cgImage: cg) {
                results.append(scores(for: emb))
            }
        }
        return results
    }

    // MARK: - Core ML image embedding

    private func embed(cgImage: CGImage) throws -> [Float]? {
        let request = VNCoreMLRequest(model: model)
        request.imageCropAndScaleOption = .centerCrop
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try handler.perform([request])

        guard let obs = request.results?.first as? VNCoreMLFeatureValueObservation,
              let arr = obs.featureValue.multiArrayValue else {
            return nil
        }
        var vec = [Float](repeating: 0, count: arr.count)
        for i in 0..<arr.count { vec[i] = arr[i].floatValue }
        return l2normalize(vec)
    }

    // MARK: - Zero-shot scoring

    private func scores(for imageEmbedding: [Float]) -> [String: Float] {
        // Cosine similarity (both sides already normalized) → softmax.
        var logits = classEmbeddings.map { dot(imageEmbedding, $0) * temperature }
        let maxL = logits.max() ?? 0
        var expSum: Float = 0
        for i in logits.indices { logits[i] = expf(logits[i] - maxL); expSum += logits[i] }
        var out: [String: Float] = [:]
        for (i, name) in SwingVisionClassifier.classNames.enumerated() {
            out[name] = expSum > 0 ? logits[i] / expSum : 0
        }
        return out
    }

    private func dot(_ a: [Float], _ b: [Float]) -> Float {
        var s: Float = 0
        let n = min(a.count, b.count)
        for i in 0..<n { s += a[i] * b[i] }
        return s
    }

    private func l2normalize(_ v: [Float]) -> [Float] {
        var norm: Float = 0
        for x in v { norm += x * x }
        norm = sqrtf(norm)
        guard norm > 0 else { return v }
        return v.map { $0 / norm }
    }
}
