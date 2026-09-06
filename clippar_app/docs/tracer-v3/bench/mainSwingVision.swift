//
//  mainSwingVision.swift — runs the app's PRIMARY impact estimator, unmodified.
//
//  `constants/config.ts` has `detection.swingVision: true`, and both import call
//  sites in hooks/useEditorState.ts do
//      (await visionDetectAndTrim(...)) ?? (await detectAndTrim(...))
//  so SwingVisionModule.localizeSwing is what actually decides where the app
//  thinks impact is on an imported clip. shot-detector is only the fallback.
//
//  This file registers the module's real definition() and invokes the real
//  registered "localizeSwing" closure. It does not reimplement anything.
//
//  Usage: ./svharness <clip.mov>
//  Prints one JSON object — the module's own payload plus harnessWallMs.
//
import Foundation
import ExpoModulesCore

func jsonQuoted(_ s: String) -> String {
  guard let d = try? JSONSerialization.data(withJSONObject: [s], options: []),
        var t = String(data: d, encoding: .utf8) else { return "\"\"" }
  t.removeFirst(); t.removeLast()
  return t
}

func emitAndExit(_ obj: [String: Any], _ code: Int32) -> Never {
  let safe = obj.mapValues { v -> Any in JSONSerialization.isValidJSONObject([v]) ? v : String(describing: v) }
  if let d = try? JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]),
     let s = String(data: d, encoding: .utf8) { print(s) }
  exit(code)
}

let args = CommandLine.arguments
if args.count < 2 { emitAndExit(["error": "usage: svharness <clip>"], 2) }
let uri = URL(fileURLWithPath: args[1]).absoluteString

_ = ExpoShimRegistry.boot(SwingVisionModule())

guard let isAvail = ExpoShimRegistry.fn("isAvailable", as: (() -> Bool).self),
      let localize = ExpoShimRegistry.fn("localizeSwing", as: ((String, Promise) -> Void).self) else {
  emitAndExit(["error": "module did not register its functions",
               "registered": Array(ExpoShimRegistry.functions.keys).sorted()], 3)
}
if !isAvail() {
  let le = ExpoShimRegistry.fn("lastError", as: (() -> String?).self)?() ?? "unknown"
  emitAndExit(["error": "swing-vision unavailable", "lastError": le], 4)
}

let t0 = Date()
let box = ShimPromiseBox()
localize(uri, box.promise)
if !box.await(900) { emitAndExit(["error": "timeout"], 5) }
if let e = box.error { emitAndExit(["error": "\(e)"], 6) }

var out = (box.value as? [String: Any]) ?? ["error": "non-dictionary payload"]
out["harnessWallMs"] = Int(Date().timeIntervalSince(t0) * 1000)
emitAndExit(out, 0)
