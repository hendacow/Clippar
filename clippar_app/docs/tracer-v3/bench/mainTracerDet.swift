import Foundation
let a = CommandLine.arguments
guard a.count >= 3, let impactMs = Double(a[2]) else { exit(2) }
let out = TracerDetect.detect(assetURL: URL(fileURLWithPath: a[1]), impactTimeMs: impactMs,
                              optionsJson: a.count > 3 ? a[3] : "{}")
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
