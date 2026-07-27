// Parity harness: runs the SHIPPED SwingLocalizer motion+candidate code on a
// clip and prints the result, so the Swift can be diffed against the Python
// reference without needing a device build.
import Foundation
import AVFoundation

let args = CommandLine.arguments
guard args.count > 1 else {
  FileHandle.standardError.write("usage: parity <clip> [clip...]\n".data(using: .utf8)!)
  exit(2)
}

let params = LocalizerParams()
for path in args.dropFirst() {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  let duration = CMTimeGetSeconds(asset.duration)
  guard duration.isFinite, duration > 0,
        let prof = SwingLocalizer.motionProfile(asset: asset, params: params) else {
    print("\(URL(fileURLWithPath: path).lastPathComponent)\tERROR")
    continue
  }
  let cands = SwingLocalizer.candidates(
    energy: prof.energy, fps: prof.fps, duration: duration, params: params)
  let name = URL(fileURLWithPath: path).lastPathComponent
  let box = SwingLocalizer.golferBox(heat: prof.heat, w: prof.w, h: prof.h)
  var line = "\(name)\tdur=\(String(format: "%.2f", duration))"
    + "\tfps=\(String(format: "%.2f", prof.fps))"
    + "\tbox=\(String(format: "%.3f,%.3f,%.3f", box.midX, box.midY, box.width))"
  for c in cands.prefix(6) {
    line += "\t\(String(format: "%.2f", c.tTop))/\(String(format: "%.2f", c.tImpact))"
      + "/\(String(format: "%.3f", c.norm))"
  }
  print(line)
}
