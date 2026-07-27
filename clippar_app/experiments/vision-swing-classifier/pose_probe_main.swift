// Pose probe: does Apple Vision body pose separate a full swing from a putt?
//
// The appearance features do not — a trained probe on the CLIP embeddings scores
// 64%, worse than a single motion threshold. Pose is a different KIND of signal:
// wrist height relative to the shoulders is geometric, so it should not care
// about camera angle, which way the golfer faces, or the light — the things that
// break appearance matching.
//
// Prints, per clip, the peak normalised wrist height over a window around the
// detected swing, plus how often pose locked on at all (the expected failure
// mode is a golfer too small in frame).
import Foundation
import AVFoundation
import Vision
import CoreGraphics

struct Args {
  var path = ""
  var t = 0.0
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: pose <clip> <tTopSeconds>\n".data(using: .utf8)!)
  exit(2)
}
let path = args[1]
let tTop = Double(args[2]) ?? 0

let asset = AVURLAsset(url: URL(fileURLWithPath: path))
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
gen.maximumSize = CGSize(width: 1280, height: 1280)

// Sample across the stroke: a full swing's hands peak at the top, a putt's never
// leave waist height.
// Tight around the stroke itself. A wider window let post-shot movement — a
// putter shouldered, a ball picked out of the hole — set the maximum, which is
// what made IMG_0558 read as wrists-above-shoulders during a putt.
let winBefore = Double(ProcessInfo.processInfo.environment["POSE_BEFORE"] ?? "") ?? 0.3
let winAfter  = Double(ProcessInfo.processInfo.environment["POSE_AFTER"]  ?? "") ?? 0.4
let times = stride(from: tTop - winBefore, through: tTop + winAfter, by: 0.05)

var best = -9.0          // highest wrist, relative to shoulder->hip span
var detected = 0
var attempted = 0
var bestConf: Float = 0

for t in times {
  guard t >= 0 else { continue }
  attempted += 1
  guard let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600),
                                      actualTime: nil) else { continue }
  let req = VNDetectHumanBodyPoseRequest()
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  guard (try? handler.perform([req])) != nil,
        let all = req.results, !all.isEmpty else { continue }
  // Pick the LARGEST person, not the first Vision happens to return. A green
  // usually has several golfers on it, and results.first picked a playing
  // partner on IMG_0558 — reporting wrists above the shoulders during a putt,
  // which is physically impossible. The golfer taking the shot is the one
  // nearest the camera, hence the biggest torso.
  func torsoSpan(_ o: VNHumanBodyPoseObservation) -> Double {
    guard let ls = try? o.recognizedPoint(.leftShoulder),
          let rs = try? o.recognizedPoint(.rightShoulder),
          let lh = try? o.recognizedPoint(.leftHip),
          let rh = try? o.recognizedPoint(.rightHip),
          ls.confidence > 0.1, rs.confidence > 0.1,
          lh.confidence > 0.1, rh.confidence > 0.1 else { return 0 }
    return abs((ls.location.y + rs.location.y) / 2 - (lh.location.y + rh.location.y) / 2)
  }
  guard let obs = all.max(by: { torsoSpan($0) < torsoSpan($1) }) else { continue }

  func pt(_ j: VNHumanBodyPoseObservation.JointName) -> VNRecognizedPoint? {
    guard let p = try? obs.recognizedPoint(j), p.confidence > 0.15 else { return nil }
    return p
  }
  // Vision's y increases UPWARD in normalised image coords.
  guard let ls = pt(.leftShoulder), let rs = pt(.rightShoulder),
        let lh = pt(.leftHip), let rh = pt(.rightHip) else { continue }
  let shoulderY = (ls.location.y + rs.location.y) / 2
  let hipY = (lh.location.y + rh.location.y) / 2
  let shoulderX = (ls.location.x + rs.location.x) / 2
  let hipX = (lh.location.x + rh.location.x) / 2
  // TRUE torso length, not its vertical component. A golfer bent over a putt has
  // shoulders and hips at nearly the same HEIGHT, so the vertical distance
  // collapses toward zero and the ratio explodes — which is why IMG_0558 read
  // +1.12 (wrists a torso above the shoulders) during a putt. The Euclidean
  // length is the same whether the golfer is upright or folded in half.
  let torso = (pow(shoulderY - hipY, 2) + pow(shoulderX - hipX, 2)).squareRoot()
  guard torso > 0.01 else { continue }

  let wrists = [pt(.leftWrist), pt(.rightWrist)].compactMap { $0 }
  guard !wrists.isEmpty else { continue }
  detected += 1
  // 0 = wrists at shoulder height, +1 = one torso-length ABOVE the shoulders
  // (club up at the top of a backswing). A putt should sit well below 0.
  for w in wrists {
    let rel = (w.location.y - shoulderY) / torso
    if rel > best { best = rel; bestConf = w.confidence }
  }
}

let name = URL(fileURLWithPath: path).lastPathComponent
if detected == 0 {
  print("\(name)\tPOSE_FAILED\tdetected 0/\(attempted)")
} else {
  print(String(format: "%@\t%.3f\tdetected %d/%d\tconf %.2f",
               name, best, detected, attempted, bestConf))
}
