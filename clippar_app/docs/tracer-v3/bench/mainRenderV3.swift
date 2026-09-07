//
//  mainRenderV3.swift — runs the shipped V3 renderer, unmodified.
//
//  TracerRenderV3.swift `import UIKit`, so this is built for the iOS SIMULATOR
//  and run with `xcrun simctl spawn`, exactly as sdharness is. The file is
//  compiled from the checked-in source, copied not edited; nothing on the
//  render path is stood in for.
//
//  Usage: ./renderv3 <clip.mov> <spec.json> <out.mp4>
//  Prints the renderer's own payload as JSON, or the error it threw.
//
import Foundation

let a = CommandLine.arguments
guard a.count >= 4 else {
    print("{\"error\":\"usage: renderv3 <clip> <spec.json> <out.mp4>\"}"); exit(2)
}
let videoURL = URL(fileURLWithPath: a[1])
let outURL = URL(fileURLWithPath: a[3])
guard let specJson = try? String(contentsOf: URL(fileURLWithPath: a[2]), encoding: .utf8) else {
    print("{\"error\":\"cannot read spec\"}"); exit(3)
}
try? FileManager.default.removeItem(at: outURL)
let t0 = Date()
do {
    var r = try TracerRenderV3.render(videoURL: videoURL, specJson: specJson, outputURL: outURL)
    r["harnessWallMs"] = Int(Date().timeIntervalSince(t0) * 1000)
    let safe = r.mapValues { v -> Any in JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v) }
    print(String(data: try! JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]), encoding: .utf8)!)
} catch let e as TracerRenderV3Error {
    print("{\"error\":\"\(e.code)\",\"message\":\"\(e.message)\"}"); exit(4)
} catch {
    print("{\"error\":\"unknown\",\"message\":\"\(error.localizedDescription)\"}"); exit(5)
}
