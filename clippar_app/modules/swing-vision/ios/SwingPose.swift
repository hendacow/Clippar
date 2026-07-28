//
//  SwingPose.swift
//  Full swing vs putt from body geometry — Apple Vision, no model to ship.
//
//  WHY THIS EXISTS
//  Appearance cannot do this job. A trained linear probe on the MobileCLIP2
//  embedding of the golfer crop scores 64% (n=53, leave-one-clip-out) — worse
//  than a single motion threshold, and it adds nothing on top of one. The
//  putt-vs-swing information simply is not in those features at this crop and
//  resolution. Embedding the whole frame instead reaches 77%, which says the
//  useful cue was the SCENE (green, flag, players) that the golfer crop throws
//  away — but that still adds nothing over motion, so it is not worth 2x the
//  Core ML cost.
//
//  Pose is a different KIND of signal: wrist height relative to the shoulders,
//  normalised by torso length. Motion amplitude is DISTANCE-DEPENDENT — a full
//  swing filmed from 40m away moves fewer pixels than a putt filmed from 3m,
//  which is precisely the "any angle, any distance" failure. Pose is normalised
//  by the golfer's own torso, so it is invariant to how far away the golfer is
//  and which way round they stand.
//
//  WHY IT IS NOW THE PRIMARY SIGNAL, NOT AN ADVISOR
//  Chips proved the old arrangement wrong. Motion used to decide and pose was
//  only allowed to demote a swing to a putt — so a chip, whose amplitude looks
//  like a putt's, was called a putt and pose was never asked. On 56 clips
//  (25 putts, 21 full swings, 10 chips): motion-decides 49/56 with 6/10 chips;
//  pose-decides-motion-falls-back 52/56 with 9/10.
//
//  KNOWN LIMITS, all measured and all left in place:
//   - Overlapping bodies. On IMG_0558 two golfers stand almost on top of each
//     other and Vision returns a blended skeleton — wrists apparently above the
//     shoulders during a putt. Picking the largest person does not fix it.
//   - IMG_0582 (+0.055) and IMG_0579 (-0.243), putts that read too high. The
//     first is the one clip this rule loses that the old one kept.
//   - IMG_0592, a chip read at -0.762. NOT a pose failure: the localizer picks
//     17.02s, which is not the shot, so pose is asked about the wrong instant
//     and answers correctly about it. No threshold here can fix that clip.
//
//  A tighter bar does not help. Moving it to -0.22 rescues IMG_0579 but loses
//  IMG_0596, a genuine full swing at -0.438 — net zero, and it trades a putt
//  for a swing, which is the worse direction.
//
import AVFoundation
import Vision
import CoreGraphics

enum SwingPose {

  /// Sampled around the stroke. Wide enough to catch the top of a backswing and
  /// the finish, both of which put the hands high on a full swing.
  static let winBefore = 0.5
  static let winAfter = 0.9
  static let step = 0.05

  /// Above this the hands left putting height, so a SHOT was played and the
  /// clip is worth trimming. Below it, the stroke was a putt and the whole clip
  /// is the highlight. Units are torso lengths above the shoulder line.
  ///
  /// Set from the measured gap between the two classes, not guessed:
  ///     putts   -0.79 .. -0.53   (n=12 of 14; two outliers, see below)
  ///     chips   -0.21 .. +0.14   (n=9 of 10)
  ///     swings  -0.44 .. +0.69   (n=20)
  /// so putts top out at -0.532 and shots bottom out at -0.438. This sits at
  /// the midpoint of that gap.
  ///
  /// Note the name: a CHIP is a shot, and chips sit nowhere near full swings on
  /// this scale (-0.21..+0.14 against +0.55..+0.69). Calling the bar
  /// "fullSwingMin" invited the mistake of raising it to exclude chips, which
  /// is exactly backwards — chips must land ABOVE it.
  static let shotMinWristHeight = -0.485

  /// Peak wrist height over the stroke, in torso lengths above the shoulders.
  /// Returns nil when pose never locked on — the caller must then fall back to
  /// motion rather than guess.
  static func peakWristHeight(asset: AVAsset, tTop: Double) -> Double? {
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero
    gen.maximumSize = CGSize(width: 1280, height: 1280)

    var best: Double?
    var t = max(0, tTop - winBefore)
    let end = tTop + winAfter
    while t <= end {
      defer { t += step }
      guard let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600),
                                          actualTime: nil) else { continue }
      let req = VNDetectHumanBodyPoseRequest()
      guard (try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])) != nil,
            let all = req.results, !all.isEmpty else { continue }

      // The golfer taking the shot is the one nearest the camera, so the biggest
      // torso. (Does not rescue overlapping bodies — see the note above.)
      guard let obs = all.max(by: { torso($0) < torso($1) }), torso(obs) > 0.01 else { continue }

      func pt(_ j: VNHumanBodyPoseObservation.JointName) -> VNRecognizedPoint? {
        guard let p = try? obs.recognizedPoint(j), p.confidence > 0.15 else { return nil }
        return p
      }
      guard let ls = pt(.leftShoulder), let rs = pt(.rightShoulder) else { continue }
      let shoulderY = (ls.location.y + rs.location.y) / 2
      let span = torso(obs)
      // Vision's y increases UPWARD in normalised image coordinates.
      for w in [pt(.leftWrist), pt(.rightWrist)].compactMap({ $0 }) {
        let rel = (w.location.y - shoulderY) / span
        if best == nil || rel > best! { best = rel }
      }
    }
    return best
  }

  /// TRUE torso length, not its vertical component.
  ///
  /// Using the vertical distance is wrong and was measured failing: a golfer
  /// bent over a putt has shoulders and hips at nearly the same HEIGHT, so the
  /// divisor collapses toward zero and the ratio explodes. The Euclidean length
  /// is the same whether the golfer is upright or folded in half.
  private static func torso(_ o: VNHumanBodyPoseObservation) -> Double {
    guard let ls = try? o.recognizedPoint(.leftShoulder),
          let rs = try? o.recognizedPoint(.rightShoulder),
          let lh = try? o.recognizedPoint(.leftHip),
          let rh = try? o.recognizedPoint(.rightHip),
          ls.confidence > 0.1, rs.confidence > 0.1,
          lh.confidence > 0.1, rh.confidence > 0.1 else { return 0 }
    let sx = (ls.location.x + rs.location.x) / 2, sy = (ls.location.y + rs.location.y) / 2
    let hx = (lh.location.x + rh.location.x) / 2, hy = (lh.location.y + rh.location.y) / 2
    return ((sx - hx) * (sx - hx) + (sy - hy) * (sy - hy)).squareRoot()
  }
}
