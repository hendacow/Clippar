//
//  mainShotDetector.swift — runs the app's FALLBACK impact estimator, unmodified.
//
//  ShotDetectorModule.swift `import UIKit` and calls `os_proc_available_memory()`,
//  neither of which exists on macOS. Rather than shim those (a shim on the
//  detection path is exactly the kind of substitution this bench is supposed to
//  refuse), the target is built for the **iOS Simulator** and run with
//  `xcrun simctl spawn`. That needs no UIKit stand-in and no `os` stand-in: the
//  file compiles against the real iOS SDK, byte-for-byte as shipped. Only
//  ExpoModulesCore is stood in for.
//
//  The arguments are the ones the JS wrapper passes on the import path
//  (hooks/useEditorState.ts -> modules/shot-detector/index.ts):
//    strategy    = config.detection.strategy      = "baseline"
//    optionsJson = config.detection.options       = {"puttPostRollMs":0}
//    recentShotTypes = []                          (the import-retrim call site)
//  preRoll/postRoll only size the trim window; they do not enter the impact
//  estimate. 2500/1500 is the app's own default.
//
//  Usage: ./sdharness <clip.mov> [preRollMs] [postRollMs]
//  Prints one JSON object — the module's own payload plus harnessWallMs.
//
import Foundation
import ExpoModulesCore

func emitAndExit(_ obj: [String: Any], _ code: Int32) -> Never {
  let safe = obj.mapValues { v -> Any in JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v) }
  if let d = try? JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]),
     let s = String(data: d, encoding: .utf8) { print("@@JSON@@" + s) }
  exit(code)
}

let args = CommandLine.arguments
if args.count < 2 { emitAndExit(["error": "usage: sdharness <clip> [preRollMs] [postRollMs]"], 2) }
let uri = URL(fileURLWithPath: args[1]).absoluteString
let preRoll = args.count > 2 ? (Double(args[2]) ?? 2500) : 2500
let postRoll = args.count > 3 ? (Double(args[3]) ?? 1500) : 1500

_ = ExpoShimRegistry.boot(ShotDetectorModule())

typealias DetectAndTrim = (String, Double, Double, [String], String, String, Promise) -> Void
guard let detectAndTrim = ExpoShimRegistry.fn("detectAndTrim", as: DetectAndTrim.self) else {
  emitAndExit(["error": "detectAndTrim not registered",
               "registered": Array(ExpoShimRegistry.functions.keys).sorted()], 3)
}

let t0 = Date()
let box = ShimPromiseBox()
detectAndTrim(uri, preRoll, postRoll, [], "baseline", "{\"puttPostRollMs\":0}", box.promise)
if !box.await(1800) { emitAndExit(["error": "timeout"], 5) }
if let e = box.error { emitAndExit(["error": "\(e)"], 6) }

var out = (box.value as? [String: Any]) ?? ["error": "non-dictionary payload"]
out["harnessWallMs"] = Int(Date().timeIntervalSince(t0) * 1000)
// The trimmed file is a side effect of the real path; the bench does not use it.
if let t = out["trimmedUri"] as? String {
  try? FileManager.default.removeItem(at: URL(fileURLWithPath: t.replacingOccurrences(of: "file://", with: "")))
}
emitAndExit(out, 0)
