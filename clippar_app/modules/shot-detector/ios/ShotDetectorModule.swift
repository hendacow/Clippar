import ExpoModulesCore
import Vision
import AVFoundation
import Accelerate
import UIKit
import QuartzCore
import os

// MARK: - Shot Type Classification
private enum ShotType: String {
    case swing = "swing"
    case putt  = "putt"
}

// MARK: - Swing Detection State Machine
private enum SwingState {
    case idle
    case setup       // Golfer standing, wrists low and still
    case backswing   // Wrists rising above shoulders
    case downswing   // Wrists dropping fast after peak
}

// MARK: - Pose Tracking Data
internal struct PoseFrame {
    let frameIndex: Int
    let timeMs: Double
    let leftWrist: CGPoint?
    let rightWrist: CGPoint?
    let leftElbow: CGPoint?
    let rightElbow: CGPoint?
    let leftShoulder: CGPoint?
    let rightShoulder: CGPoint?
    let leftHip: CGPoint?
    let rightHip: CGPoint?
    let nose: CGPoint?
    let confidence: Float
}

// MARK: - Detection Result
private struct SwingResult {
    let found: Bool
    let impactTimeMs: Double
    let impactFrameIndex: Int
    let confidence: Double
    let shotType: ShotType
}

public class ShotDetectorModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ShotDetector")

        Events("onStitchProgress")

        AsyncFunction("detectSwing") { (videoUri: String, promise: Promise) in
            self.processVideo(uri: videoUri, promise: promise)
        }

        // Passthrough trim — copies video bitstream without re-encoding.
        // 4K stays 4K, zero quality loss, completes in <1 second.
        AsyncFunction("trimVideo") { (videoUri: String, startMs: Double, endMs: Double, promise: Promise) in
            self.trimVideoPassthrough(uri: videoUri, startMs: startMs, endMs: endMs, promise: promise)
        }

        // Combined detect + passthrough trim in one call.
        // Returns detection result plus trimmedUri (null if no swing found).
        //
        // `strategy` selects the detection algorithm at RUNTIME (one binary holds
        // all variants): "baseline"/"default" run the byte-for-byte-unchanged
        // detectSwingEvent; "aboveShoulderGate" / "velocityPeak" / "audioFused"
        // run the additive new functions. `optionsJson` is a JSON object of
        // tunable thresholds (DetectionOptions) — empty string "{}" uses defaults.
        //
        // ARITY: Expo Modules matches AsyncFunction arity exactly. The JS wrapper
        // (modules/shot-detector/index.ts) MUST always pass all 6 args, defaulting
        // strategy/optionsJson from config — JS + native ship together.
        AsyncFunction("detectAndTrim") { (videoUri: String, preRollMs: Double, postRollMs: Double, recentShotTypes: [String], strategy: String, optionsJson: String, promise: Promise) in
            self.detectAndTrimVideo(uri: videoUri, preRollMs: preRollMs, postRollMs: postRollMs, recentShotTypes: recentShotTypes, strategy: strategy, optionsJson: optionsJson, promise: promise)
        }

        // Read-only pose timeline for the live SVG pose-overlay (analytical
        // replay). Reuses the untouched extractPoseFrames, then applies the
        // track's preferredTransform to per-joint x/y so the SVG skeleton aligns
        // with VideoView contentFit='contain'. Does NOT touch detection/trim.
        AsyncFunction("extractPoseTimeline") { (videoUri: String, promise: Promise) in
            self.extractPoseTimelinePayload(uri: videoUri, promise: promise)
        }

        // Stitch multiple clips into a single video using AVMutableComposition.
        // Passthrough when all clips share the same codec, otherwise re-encodes to H.264.
        AsyncFunction("stitchClips") { (clipUris: [String], promise: Promise) in
            self.stitchClipsOnDevice(clipUris: clipUris, promise: promise)
        }

        // Full reel composition: stitch clips + scorecard overlay + background music.
        // Uses AVVideoComposition for text overlay and AVAudioMix for music mixing.
        //
        // `clips` is an array of dictionaries: { uri: String, trimStartMs: Number?,
        //  trimEndMs: Number? }. trimEndMs = -1 (or absent) means "use full
        // duration". When the user trims a clip in the editor, JS passes those
        // bounds here so the composition uses only the trimmed time range —
        // without this, the reel concatenates full source clips and ignores
        // any user-applied trim.
        AsyncFunction("composeReel") { (clips: [[String: Any]], scorecardJson: String, musicUri: String, promise: Promise) in
            self.composeReelOnDevice(clips: clips, scorecardJson: scorecardJson, musicUri: musicUri.isEmpty ? nil : musicUri, promise: promise)
        }

        // Delete all cached trim files (trim_*.mov, trim_*.mp4) from the caches directory.
        AsyncFunction("clearTrimCache") { (promise: Promise) in
            DispatchQueue.global(qos: .utility).async {
                let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                var deletedCount = 0
                if let files = try? FileManager.default.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: nil) {
                    for file in files {
                        let name = file.lastPathComponent
                        if name.hasPrefix("trim_") && (name.hasSuffix(".mov") || name.hasSuffix(".mp4")) {
                            try? FileManager.default.removeItem(at: file)
                            deletedCount += 1
                        }
                    }
                }
                promise.resolve(["deletedCount": deletedCount])
            }
        }

        // Get current memory + disk stats for crash diagnostics.
        // Returns availableMemoryMB, usedMemoryMB, freeDiskMB, cachesDirMB.
        AsyncFunction("getMemoryStats") { (promise: Promise) in
            DispatchQueue.global(qos: .utility).async {
                let availableMB = Double(os_proc_available_memory()) / (1024.0 * 1024.0)

                // Get process memory usage
                var info = mach_task_basic_info()
                var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
                let result = withUnsafeMutablePointer(to: &info) { infoPtr in
                    infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rawPtr in
                        task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rawPtr, &count)
                    }
                }
                let usedMB = result == KERN_SUCCESS ? Double(info.resident_size) / (1024.0 * 1024.0) : -1.0

                // Get free disk space
                var freeDiskMB: Double = -1
                if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()),
                   let freeSize = attrs[.systemFreeSize] as? Int64 {
                    freeDiskMB = Double(freeSize) / (1024.0 * 1024.0)
                }

                // Get caches directory size
                var cachesMB: Double = 0
                let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                if let files = try? FileManager.default.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: [.fileSizeKey]) {
                    for file in files {
                        if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                            cachesMB += Double(size)
                        }
                    }
                }
                cachesMB /= (1024.0 * 1024.0)

                promise.resolve([
                    "availableMemoryMB": Int(availableMB),
                    "usedMemoryMB": Int(usedMB),
                    "freeDiskMB": Int(freeDiskMB),
                    "cachesDirMB": Int(cachesMB),
                ] as [String: Any])
            }
        }

        // Delete a single file by URI — allows JS to clean up picker copies after processing.
        AsyncFunction("deleteFile") { (fileUri: String, promise: Promise) in
            DispatchQueue.global(qos: .utility).async {
                let fileURL = self.resolveFileURL(fileUri)
                do {
                    try FileManager.default.removeItem(at: fileURL)
                    promise.resolve(["deleted": true])
                } catch {
                    promise.resolve(["deleted": false, "error": error.localizedDescription])
                }
            }
        }

        // ---- GPS Shot Tracer (config.tracer.enabled) ----
        // Implementations live in ShotTracer.swift (extension ShotDetectorModule).
        // Registered always; never invoked while the JS kill switch is off.
        // ARITY: Expo Modules matches AsyncFunction arity exactly — the JS
        // wrappers must always pass full positional args (modules/shot-detector/index.ts).

        // Ball-launch evidence around a known impact time (Vision trajectories).
        AsyncFunction("detectBallLaunch") { (videoUri: String, impactTimeMs: Double, optionsJson: String, promise: Promise) in
            self.detectBallLaunchImpl(videoUri: videoUri, impactTimeMs: impactTimeMs, optionsJson: optionsJson, promise: promise)
        }

        // Burn a synthesized tracer arc onto a clip -> NEW tracer_<UUID>.mp4 (original untouched).
        AsyncFunction("renderTracerOnClip") { (videoUri: String, specJson: String, promise: Promise) in
            self.renderTracerOnClipImpl(videoUri: videoUri, specJson: specJson, promise: promise)
        }

        // Back-wide-camera horizontal FOV of the 1920x1080 format (landscape long axis).
        AsyncFunction("getCameraFovDeg") { (promise: Promise) in
            self.getCameraFovDegImpl(promise: promise)
        }

        // One-shot CoreMotion pitch of the camera optical axis (deg, positive = tilted down).
        AsyncFunction("getDevicePitchDeg") { (promise: Promise) in
            self.getDevicePitchDegImpl(promise: promise)
        }
    }

    // MARK: - Passthrough Trim (zero re-encode)

    private func trimVideoPassthrough(uri: String, startMs: Double, endMs: Double, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
            print("[Clippar.Trim] enter LOCAL passthrough trim — startMs=\(startMs) endMs=\(endMs) uri=\(uri)")
            do {
                let fileURL = self.resolveFileURL(uri)

                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    print("[Clippar.Trim] FAIL file-not-found path=\(fileURL.path)")
                    promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Video file not found: \(fileURL.path)"))
                    return
                }

                let asset = AVURLAsset(url: fileURL)
                let startTime = CACurrentMediaTime()

                // Determine output file type based on input extension
                let ext = fileURL.pathExtension.lowercased()
                let outputFileType: AVFileType = (ext == "mov") ? .mov : .mp4
                let outputExt = (ext == "mov") ? "mov" : "mp4"

                guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
                    print("[Clippar.Trim] FAIL could-not-create AVAssetExportSession")
                    promise.reject(Exception(name: "ERR_EXPORT_SESSION", description: "Could not create AVAssetExportSession"))
                    return
                }

                let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                    .appendingPathComponent("trim_\(UUID().uuidString).\(outputExt)")

                // Clean up if file already exists
                try? FileManager.default.removeItem(at: outputURL)

                let startCMTime = CMTimeMakeWithSeconds(startMs / 1000.0, preferredTimescale: 600)
                let endCMTime = CMTimeMakeWithSeconds(endMs / 1000.0, preferredTimescale: 600)
                let timeRange = CMTimeRangeFromTimeToTime(start: startCMTime, end: endCMTime)

                exportSession.outputURL = outputURL
                exportSession.outputFileType = outputFileType
                exportSession.timeRange = timeRange

                let semaphore = DispatchSemaphore(value: 0)
                var exportError: Error?

                exportSession.exportAsynchronously {
                    if exportSession.status == .failed {
                        exportError = exportSession.error
                    }
                    semaphore.signal()
                }

                semaphore.wait()

                if let error = exportError {
                    print("[Clippar.Trim] FAIL export error=\(error.localizedDescription)")
                    promise.reject(Exception(name: "ERR_TRIM_FAILED", description: "Trim export failed: \(error.localizedDescription)"))
                    return
                }

                let elapsed = CACurrentMediaTime() - startTime
                print("[Clippar.Trim] OK passthrough — \(String(format: "%.2f", elapsed))s out=\(outputURL.lastPathComponent)")

                promise.resolve([
                    "trimmedUri": outputURL.absoluteString,
                ] as [String: Any])
            } catch {
                print("[Clippar.Trim] FAIL exception=\(error.localizedDescription)")
                promise.reject(Exception(name: "ERR_TRIM_FAILED", description: error.localizedDescription))
            }
            } // autoreleasepool
        }
    }

    // MARK: - Combined Detect + Trim

    private func detectAndTrimVideo(uri: String, preRollMs: Double, postRollMs: Double, recentShotTypes: [String], strategy: String, optionsJson: String, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            // Wrap entire operation in autoreleasepool to ensure AVAsset, AVAssetReader,
            // VNImageRequestHandler, pixel buffers, and AVAssetExportSession are freed
            // immediately after each call — critical for batch processing 60-100+ clips.
            autoreleasepool {
            print("[Clippar.Trim] enter LOCAL detectAndTrim — preRollMs=\(preRollMs) postRollMs=\(postRollMs) uri=\(uri)")
            let availableMB = Double(os_proc_available_memory()) / (1024.0 * 1024.0)
            print("[ShotDetector] Available memory: \(String(format: "%.0f", availableMB))MB before processing \(uri.suffix(20))")

            do {
                let fileURL = self.resolveFileURL(uri)

                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Video file not found: \(fileURL.path)"))
                    return
                }

                let asset = AVURLAsset(url: fileURL)
                let startTime = CACurrentMediaTime()

                // Step 1: Detect swing
                let poseFrames = try self.extractPoseFrames(from: asset)
                let audioTransients = try self.detectAudioTransients(from: asset)
                let options = DetectionOptions(json: optionsJson)
                var diag = DetectionDiagnostics(strategy: strategy)
                diag.poseFrameCount = poseFrames.count
                diag.hadAudioTrack = !asset.tracks(withMediaType: .audio).isEmpty
                diag.hadAnyTransient = !audioTransients.isEmpty
                let result = self.dispatchDetection(
                    strategy: strategy,
                    poseFrames: poseFrames,
                    audioTransients: audioTransients,
                    asset: asset,
                    recentShotTypes: recentShotTypes,
                    options: options,
                    diag: &diag
                )

                let detectionElapsed = CACurrentMediaTime() - startTime
                let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0

                print("[ShotDetector] Detection took \(String(format: "%.1f", detectionElapsed))s for \(String(format: "%.1f", durationMs/1000))s video (\(poseFrames.count) frames analysed)")

                self.logABHarness(diag)

                guard result.found else {
                    let availableMBAfter = Double(os_proc_available_memory()) / (1024.0 * 1024.0)
                    print("[ShotDetector] Available memory: \(String(format: "%.0f", availableMBAfter))MB after processing (delta: \(String(format: "%.0f", availableMBAfter - availableMB))MB)")
                    var payload: [String: Any] = [
                        "found": false,
                        "impactTimeMs": 0.0,
                        "trimStartMs": 0.0,
                        "trimEndMs": 0.0,
                        "confidence": 0.0,
                        "shotType": "swing",
                        "trimmedUri": NSNull(),
                    ]
                    diag.merge(into: &payload)
                    promise.resolve(payload)
                    return
                }

                print("[Classifier] clip=\(fileURL.lastPathComponent) shotType=\(result.shotType.rawValue) confidence=\(String(format: "%.2f", result.confidence)) durationMs=\(Int(durationMs)) impactMs=\(Int(result.impactTimeMs)) poseFrames=\(poseFrames.count) audioTransients=\(audioTransients.count)")

                // Always trim around the detected impact, regardless of
                // shotType. Previously putts kept the full clip — but the
                // classifier sometimes misidentifies driver swings as putts
                // with low confidence (e.g. 0.25), and skipping trim leaves
                // the user staring at a 16+ second untrimmed clip.
                //
                // Putts get a slightly longer post-roll to capture the ball
                // rolling toward the cup, but use the same trim flow as
                // swings so the file_uri is the trimmed clip and downstream
                // duration / playback work correctly.
                let effectivePreRoll = preRollMs
                let effectivePostRoll = result.shotType == .putt ? max(postRollMs, 4000.0) : postRollMs

                // Step 2: Calculate trim window with configurable pre/post roll
                let trimStart = max(0.0, result.impactTimeMs - effectivePreRoll)
                let trimEnd = min(durationMs, result.impactTimeMs + effectivePostRoll)

                // Step 3: Passthrough trim (zero re-encode)
                let ext = fileURL.pathExtension.lowercased()
                let outputFileType: AVFileType = (ext == "mov") ? .mov : .mp4
                let outputExt = (ext == "mov") ? "mov" : "mp4"

                guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
                    // Detection succeeded but trim failed — return detection result without trim
                    var payload: [String: Any] = [
                        "found": true,
                        "impactTimeMs": result.impactTimeMs,
                        "trimStartMs": trimStart,
                        "trimEndMs": trimEnd,
                        "confidence": result.confidence,
                        "shotType": result.shotType.rawValue,
                        "trimmedUri": NSNull(),
                    ]
                    diag.merge(into: &payload)
                    promise.resolve(payload)
                    return
                }

                let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                    .appendingPathComponent("trim_\(UUID().uuidString).\(outputExt)")
                try? FileManager.default.removeItem(at: outputURL)

                let startCMTime = CMTimeMakeWithSeconds(trimStart / 1000.0, preferredTimescale: 600)
                let endCMTime = CMTimeMakeWithSeconds(trimEnd / 1000.0, preferredTimescale: 600)
                let timeRange = CMTimeRangeFromTimeToTime(start: startCMTime, end: endCMTime)

                exportSession.outputURL = outputURL
                exportSession.outputFileType = outputFileType
                exportSession.timeRange = timeRange

                let semaphore = DispatchSemaphore(value: 0)
                var exportError: Error?

                exportSession.exportAsynchronously {
                    if exportSession.status == .failed {
                        exportError = exportSession.error
                    }
                    semaphore.signal()
                }

                semaphore.wait()

                let totalElapsed = CACurrentMediaTime() - startTime

                if let error = exportError {
                    print("[ShotDetector] Trim failed: \(error.localizedDescription) — returning detection result only")
                    var payload: [String: Any] = [
                        "found": true,
                        "impactTimeMs": result.impactTimeMs,
                        "trimStartMs": trimStart,
                        "trimEndMs": trimEnd,
                        "confidence": result.confidence,
                        "shotType": result.shotType.rawValue,
                        "trimmedUri": NSNull(),
                    ]
                    diag.merge(into: &payload)
                    promise.resolve(payload)
                    return
                }

                print("[ShotDetector] Detect+trim total: \(String(format: "%.2f", totalElapsed))s (detection: \(String(format: "%.1f", detectionElapsed))s, trim: \(String(format: "%.2f", totalElapsed - detectionElapsed))s)")
                print("[Clippar.Trim] OK detectAndTrim — totalSec=\(String(format: "%.2f", totalElapsed)) trimRange=\(trimStart)..\(trimEnd) out=\(outputURL.lastPathComponent)")

                let availableMBAfter = Double(os_proc_available_memory()) / (1024.0 * 1024.0)
                print("[ShotDetector] Available memory: \(String(format: "%.0f", availableMBAfter))MB after processing (delta: \(String(format: "%.0f", availableMBAfter - availableMB))MB)")

                var payload: [String: Any] = [
                    "found": true,
                    "impactTimeMs": result.impactTimeMs,
                    "trimStartMs": trimStart,
                    "trimEndMs": trimEnd,
                    "confidence": result.confidence,
                    "shotType": result.shotType.rawValue,
                    "trimmedUri": outputURL.absoluteString,
                ]
                diag.merge(into: &payload)
                promise.resolve(payload)
            } catch {
                promise.reject(Exception(name: "ERR_DETECT_TRIM_FAILED", description: error.localizedDescription))
            }
            } // autoreleasepool
        }
    }

    // MARK: - Main Processing Pipeline

    private func processVideo(uri: String, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
            do {
                let fileURL = self.resolveFileURL(uri)

                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Video file not found: \(fileURL.path)"))
                    return
                }

                let asset = AVURLAsset(url: fileURL)
                let startTime = CACurrentMediaTime()

                // Run pose detection (fast — every 6th frame at reduced resolution)
                let poseFrames = try self.extractPoseFrames(from: asset)

                // Run audio transient detection in parallel
                let audioTransients = try self.detectAudioTransients(from: asset)

                // Run the state machine to find the best swing
                let result = self.detectSwingEvent(
                    poseFrames: poseFrames,
                    audioTransients: audioTransients,
                    asset: asset,
                    recentShotTypes: []
                )

                let elapsed = CACurrentMediaTime() - startTime
                let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0

                print("[ShotDetector] Detection took \(String(format: "%.1f", elapsed))s for \(String(format: "%.1f", durationMs/1000))s video (\(poseFrames.count) frames analysed)")

                if result.found {
                    // Putts: keep full clip. Swings: trim to 5s window.
                    let trimStart: Double
                    let trimEnd: Double
                    if result.shotType == .putt {
                        trimStart = 0.0
                        trimEnd = durationMs
                    } else {
                        trimStart = max(0.0, result.impactTimeMs - 3000.0)
                        trimEnd = min(durationMs, result.impactTimeMs + 2000.0)
                    }

                    print("[Classifier] clip=\(fileURL.lastPathComponent) shotType=\(result.shotType.rawValue) confidence=\(String(format: "%.2f", result.confidence)) durationMs=\(Int(durationMs)) impactMs=\(Int(result.impactTimeMs)) poseFrames=\(poseFrames.count) audioTransients=\(audioTransients.count)")

                    promise.resolve([
                        "found": true,
                        "impactTimeMs": result.impactTimeMs,
                        "trimStartMs": trimStart,
                        "trimEndMs": trimEnd,
                        "confidence": result.confidence,
                        "shotType": result.shotType.rawValue,
                    ] as [String: Any])
                } else {
                    promise.resolve([
                        "found": false,
                        "impactTimeMs": 0.0,
                        "trimStartMs": 0.0,
                        "trimEndMs": 0.0,
                        "confidence": 0.0,
                        "shotType": "swing",
                    ] as [String: Any])
                }
            } catch {
                promise.reject(Exception(name: "ERR_DETECTION_FAILED", description: error.localizedDescription))
            }
            } // autoreleasepool
        }
    }

    // MARK: - File URL Resolution

    internal func resolveFileURL(_ uri: String) -> URL {
        if uri.hasPrefix("file://") {
            return URL(string: uri)!
        }
        if uri.hasPrefix("/") {
            return URL(fileURLWithPath: uri)
        }
        return URL(string: uri) ?? URL(fileURLWithPath: uri)
    }

    // MARK: - Pose Frame Extraction (every 6th frame for speed)

    private func extractPoseFrames(from asset: AVURLAsset) throws -> [PoseFrame] {
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            throw NSError(domain: "ShotDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: "No video track found"])
        }

        let fps = videoTrack.nominalFrameRate
        let duration = CMTimeGetSeconds(asset.duration)
        // Process every 6th frame — at 30fps this gives ~5 samples/sec (plenty for swing detection)
        let frameStep = max(6, Int(fps / 5.0))

        let reader = try AVAssetReader(asset: asset)
        let outputSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            // Request smaller frames for faster Vision processing
            kCVPixelBufferWidthKey as String: 480,
            kCVPixelBufferHeightKey as String: 640,
        ]
        let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
        trackOutput.alwaysCopiesSampleData = false
        reader.add(trackOutput)

        guard reader.startReading() else {
            throw NSError(domain: "ShotDetector", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to start reading video"])
        }

        var poseFrames: [PoseFrame] = []
        var frameIndex = 0
        var readerDone = false

        // CRITICAL: copyNextSampleBuffer() must be called INSIDE the autoreleasepool.
        // Previously it was in the `while let` binding (outside), so skipped frames'
        // CMSampleBuffers lingered in the outer scope until the next iteration,
        // causing ~5MB/frame leak for skipped frames (5 out of every 6).
        while !readerDone {
            autoreleasepool {
                guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else {
                    readerDone = true
                    return
                }
                defer { frameIndex += 1 }

                // Skip frames — only process every Nth frame
                guard frameIndex % frameStep == 0 else { return }

                let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                let timeMs = CMTimeGetSeconds(presentationTime) * 1000.0

                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

                // Create a fresh request per frame — Vision caches results on the request
                // object, so reusing one across frames leaks memory and can return stale data.
                let poseRequest = VNDetectHumanBodyPoseRequest()
                let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
                try? handler.perform([poseRequest])

                guard let observation = poseRequest.results?.first else {
                    poseFrames.append(PoseFrame(
                        frameIndex: frameIndex, timeMs: timeMs,
                        leftWrist: nil, rightWrist: nil,
                        leftElbow: nil, rightElbow: nil,
                        leftShoulder: nil, rightShoulder: nil,
                        leftHip: nil, rightHip: nil,
                        nose: nil, confidence: 0
                    ))
                    return
                }

                let overallConfidence = observation.confidence

                let frame = PoseFrame(
                    frameIndex: frameIndex,
                    timeMs: timeMs,
                    leftWrist: self.safePoint(observation, .leftWrist),
                    rightWrist: self.safePoint(observation, .rightWrist),
                    leftElbow: self.safePoint(observation, .leftElbow),
                    rightElbow: self.safePoint(observation, .rightElbow),
                    leftShoulder: self.safePoint(observation, .leftShoulder),
                    rightShoulder: self.safePoint(observation, .rightShoulder),
                    leftHip: self.safePoint(observation, .leftHip),
                    rightHip: self.safePoint(observation, .rightHip),
                    nose: self.safePoint(observation, .nose),
                    confidence: overallConfidence
                )
                poseFrames.append(frame)
            } // autoreleasepool — sampleBuffer, pixelBuffer, poseRequest ALL freed here
        }

        reader.cancelReading()
        return poseFrames
    }

    /// Safely extract a recognized point, returning nil if confidence is too low
    private func safePoint(_ obs: VNHumanBodyPoseObservation, _ name: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
        guard let point = try? obs.recognizedPoint(name), point.confidence > 0.3 else { return nil }
        return point.location
    }

    // MARK: - Audio Transient Detection

    private func detectAudioTransients(from asset: AVURLAsset) throws -> [Double] {
        guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
            return [] // No audio track — rely solely on pose
        }

        let reader = try AVAssetReader(asset: asset)
        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: 22050, // Lower sample rate — faster processing, still captures impacts
            AVNumberOfChannelsKey: 1,
        ]
        let trackOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        reader.add(trackOutput)

        guard reader.startReading() else { return [] }

        var allSamples: [Int16] = []
        var audioReaderDone = false
        while !audioReaderDone {
            autoreleasepool {
                guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else {
                    audioReaderDone = true
                    return
                }
                guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
                let length = CMBlockBufferGetDataLength(blockBuffer)
                var data = Data(count: length)
                data.withUnsafeMutableBytes { rawBuffer in
                    if let baseAddress = rawBuffer.baseAddress {
                        CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: baseAddress)
                    }
                }
                let sampleCount = length / MemoryLayout<Int16>.size
                data.withUnsafeBytes { rawBuffer in
                    if let ptr = rawBuffer.bindMemory(to: Int16.self).baseAddress {
                        allSamples.append(contentsOf: UnsafeBufferPointer(start: ptr, count: sampleCount))
                    }
                }
            }
        }

        reader.cancelReading()

        guard allSamples.count > 1000 else { return [] }

        let sampleRate: Double = 22050.0
        var floatSamples = allSamples.map { Float($0) / Float(Int16.max) }

        // Compute short-time energy in ~20ms windows
        let windowSize = 441 // ~20ms at 22050Hz
        let hopSize = 220 // ~10ms hop
        var energies: [Float] = []
        floatSamples.withUnsafeMutableBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            var i = 0
            while i + windowSize <= buffer.count {
                var energy: Float = 0
                vDSP_svesq(base + i, 1, &energy, vDSP_Length(windowSize))
                energies.append(energy / Float(windowSize))
                i += hopSize
            }
        }

        // contextWindow is used on both sides, so we need at least 2*contextWindow+1 energies
        let contextWindow = 30
        guard energies.count > contextWindow * 2 else { return [] }

        // Find sharp transients: energy > 5x local median
        var transientTimesMs: [Double] = []

        for j in contextWindow..<(energies.count - contextWindow) {
            let localSlice = Array(energies[(j - contextWindow)..<(j + contextWindow)])
            let sorted = localSlice.sorted()
            let median = sorted[sorted.count / 2]

            if median > 0 && energies[j] > median * 5.0 {
                let isPeak = energies[j] >= energies[max(0, j - 1)] && energies[j] >= energies[min(energies.count - 1, j + 1)]
                if isPeak {
                    let timeMs = Double(j * hopSize) / sampleRate * 1000.0

                    // Deduplicate: skip if too close to a previous transient
                    if transientTimesMs.isEmpty || (timeMs - transientTimesMs.last!) > 300.0 {
                        transientTimesMs.append(timeMs)
                    }
                }
            }
        }

        return transientTimesMs
    }

    // MARK: - Swing State Machine (tuned for golf)

    private func detectSwingEvent(
        poseFrames: [PoseFrame],
        audioTransients: [Double],
        asset: AVURLAsset,
        recentShotTypes: [String]
    ) -> SwingResult {
        // Pre-compute scene signal (green hue + VNClassifyImageRequest on 3 sampled frames)
        // so we can pass it to both the pose classifier and the fallback path.
        let sceneSignal = self.sceneGreenSignal(from: asset)

        guard poseFrames.count >= 5 else {
            // Not enough pose data — use duration/audio fallback so every clip
            // still gets a usable shotType for hole grouping.
            let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0
            let fallback = fallbackClassify(durationMs: durationMs, audioTransients: audioTransients, sceneSignal: sceneSignal, recentShotTypes: recentShotTypes)
            let midTimeMs = durationMs * 0.5
            let impactTimeMs = audioTransients.isEmpty
                ? midTimeMs
                : audioTransients.min(by: { abs($0 - midTimeMs) < abs($1 - midTimeMs) })!
            print("[Classifier] fallback(noPose) shotType=\(fallback.shotType.rawValue) confidence=\(String(format: "%.2f", fallback.confidence)) reason=\(fallback.reason) poseFrames=\(poseFrames.count)")
            return SwingResult(
                found: true,
                impactTimeMs: impactTimeMs,
                impactFrameIndex: 0,
                confidence: fallback.confidence,
                shotType: fallback.shotType
            )
        }

        var state: SwingState = .idle
        var backswingPeakY: CGFloat = 0
        var backswingStartIdx: Int?
        var setupStartIdx: Int?
        var stableFrames: Int = 0
        var bestImpact: (timeMs: Double, frameIndex: Int, confidence: Double, peakY: CGFloat)?

        for i in 2..<poseFrames.count {
            let prev2 = poseFrames[i - 2]
            let prev1 = poseFrames[i - 1]
            let curr = poseFrames[i]

            // Need pose data for at least current + previous frames
            guard let wristY = self.avgWristY(curr),
                  let prevWristY = self.avgWristY(prev1),
                  let prev2WristY = self.avgWristY(prev2),
                  curr.confidence > 0.3 else {
                continue
            }

            let shoulderY = self.avgShoulderY(curr) ?? 0.55
            let hipY = self.avgHipY(curr) ?? 0.35

            // Wrist velocity (positive = moving up in Vision coordinates where 0=bottom)
            let vel1 = wristY - prevWristY
            let vel2 = prevWristY - prev2WristY

            // Wrist height relative to body
            let wristAboveShoulder = wristY > shoulderY
            let wristBelowHip = wristY < hipY
            let wristInAddressZone = wristY > hipY - 0.05 && wristY < shoulderY - 0.05

            // Arm extension: elbows relative to wrists (extended arm = golf stance)
            let armExtended = self.isArmExtended(curr)

            switch state {
            case .idle:
                // Looking for address position: wrists between hip and shoulder, relatively still
                if wristInAddressZone && abs(vel1) < 0.015 {
                    stableFrames += 1
                    if stableFrames >= 2 {
                        state = .setup
                        setupStartIdx = i
                        stableFrames = 0
                    }
                } else {
                    stableFrames = 0
                }

            case .setup:
                // Backswing detection: wrists rising significantly
                if vel1 > 0.02 && vel2 > 0.01 {
                    state = .backswing
                    backswingStartIdx = i
                    backswingPeakY = wristY
                }
                // Timeout: if idle too long in setup, reset
                if let start = setupStartIdx, (i - start) > 15 {
                    state = .idle
                    stableFrames = 0
                }

            case .backswing:
                // Track the peak of the backswing
                if wristY > backswingPeakY {
                    backswingPeakY = wristY
                }

                // Transition to downswing: wrists start dropping fast after reaching above shoulders
                let peakReached = backswingPeakY > shoulderY * 0.85
                let droppingFast = vel1 < -0.03

                if peakReached && droppingFast {
                    state = .downswing
                }

                // Timeout: backswing shouldn't take too long (max ~1.5s at 5fps = ~8 frames)
                if let start = backswingStartIdx, (i - start) > 10 {
                    state = .idle
                    stableFrames = 0
                }

            case .downswing:
                // Impact detection: wrists drop to or below hip level with high velocity
                let impactZone = wristY < shoulderY * 0.7
                let fastDownswing = vel1 < -0.02

                if impactZone && fastDownswing {
                    var confidence = 0.6

                    // Higher confidence if swing arc was significant
                    let arcHeight = backswingPeakY - wristY
                    if arcHeight > 0.2 {
                        confidence += 0.1
                    }
                    if arcHeight > 0.35 {
                        confidence += 0.1
                    }

                    // Higher confidence if person was in proper address first
                    if setupStartIdx != nil {
                        confidence += 0.05
                    }

                    // Audio confirmation: is there a transient near this time?
                    let impactTimeMs = curr.timeMs
                    let audioMatch = audioTransients.first { abs($0 - impactTimeMs) < 200.0 }
                    if audioMatch != nil {
                        confidence += 0.2
                    }

                    // Pose confidence boost
                    if curr.confidence > 0.6 {
                        confidence += 0.05
                    }

                    confidence = min(1.0, confidence)

                    // Keep the best detection
                    if bestImpact == nil || confidence > bestImpact!.confidence {
                        bestImpact = (impactTimeMs, curr.frameIndex, confidence, backswingPeakY)
                    }

                    // Reset to look for more swings
                    state = .idle
                    stableFrames = 0
                }

                // Timeout: downswing is very fast, shouldn't take more than a few frames
                if let start = backswingStartIdx, (i - start) > 15 {
                    state = .idle
                    stableFrames = 0
                }
            }
        }

        if let impact = bestImpact {
            let shotType = classifyShotType(
                poseFrames: poseFrames,
                impactFrameIndex: impact.frameIndex,
                backswingPeakY: impact.peakY,
                audioTransients: audioTransients,
                impactTimeMs: impact.timeMs,
                sceneSignal: sceneSignal,
                recentShotTypes: recentShotTypes
            )
            return SwingResult(
                found: true,
                impactTimeMs: impact.timeMs,
                impactFrameIndex: impact.frameIndex,
                confidence: impact.confidence,
                shotType: shotType
            )
        }

        // Fallback path: pose-based state machine did not find a confident swing.
        // Instead of giving up (which forces JS to default to 'swing' for every
        // clip and collapse all clips into one hole), classify by duration +
        // audio transient count so every clip gets a usable shotType.
        let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0
        let fallback = fallbackClassify(durationMs: durationMs, audioTransients: audioTransients, sceneSignal: sceneSignal, recentShotTypes: recentShotTypes)

        // Pick an impact time: closest audio transient if any, else clip midpoint.
        let midTimeMs = durationMs * 0.5
        let impactTimeMs: Double
        if !audioTransients.isEmpty {
            impactTimeMs = audioTransients.min(by: { abs($0 - midTimeMs) < abs($1 - midTimeMs) })!
        } else {
            impactTimeMs = midTimeMs
        }

        print("[Classifier] fallback shotType=\(fallback.shotType.rawValue) confidence=\(String(format: "%.2f", fallback.confidence)) reason=\(fallback.reason) transients=\(audioTransients.count)")

        return SwingResult(
            found: true,
            impactTimeMs: impactTimeMs,
            impactFrameIndex: 0,
            confidence: fallback.confidence,
            shotType: fallback.shotType
        )
    }

    // MARK: - Helpers

    private func avgWristY(_ frame: PoseFrame) -> CGFloat? {
        if let left = frame.leftWrist, let right = frame.rightWrist {
            return (left.y + right.y) / 2.0
        }
        return frame.leftWrist?.y ?? frame.rightWrist?.y
    }

    private func avgShoulderY(_ frame: PoseFrame) -> CGFloat? {
        if let left = frame.leftShoulder, let right = frame.rightShoulder {
            return (left.y + right.y) / 2.0
        }
        return frame.leftShoulder?.y ?? frame.rightShoulder?.y
    }

    private func avgHipY(_ frame: PoseFrame) -> CGFloat? {
        if let left = frame.leftHip, let right = frame.rightHip {
            return (left.y + right.y) / 2.0
        }
        return frame.leftHip?.y ?? frame.rightHip?.y
    }

    /// Check if arms are extended (elbows close to line between shoulder and wrist)
    private func isArmExtended(_ frame: PoseFrame) -> Bool {
        // Check right arm (most golfers are right-handed)
        if let shoulder = frame.rightShoulder, let elbow = frame.rightElbow, let wrist = frame.rightWrist {
            let shoulderToWrist = hypot(wrist.x - shoulder.x, wrist.y - shoulder.y)
            let shoulderToElbow = hypot(elbow.x - shoulder.x, elbow.y - shoulder.y)
            let elbowToWrist = hypot(wrist.x - elbow.x, wrist.y - elbow.y)
            let fullExtension = shoulderToElbow + elbowToWrist
            if fullExtension > 0 {
                let straightness = shoulderToWrist / fullExtension
                return straightness > 0.85 // >85% straight = extended
            }
        }
        return false
    }

    // MARK: - Scene / Green Signal
    //
    // Samples 3 frames from the asset, runs VNClassifyImageRequest for a
    // "golf course / green / grass" signal, and computes dominant-green hue ratio.
    // Returns nil if sampling fails (rare). Designed to be cheap — uses
    // AVAssetImageGenerator which decodes only the requested times.
    private struct SceneSignal {
        let classifierHit: Bool   // VNClassifyImageRequest matched a golf/grass/green label >=0.3
        let greenHueRatio: Float  // 0..1 ratio of pixels with dominant green hue across sampled frames
    }

    private func sceneGreenSignal(from asset: AVURLAsset) -> SceneSignal? {
        let durationSec = CMTimeGetSeconds(asset.duration)
        guard durationSec.isFinite && durationSec > 0 else { return nil }

        // Sample 3 timestamps evenly across the clip
        let sampleSecs = [durationSec * 0.2, durationSec * 0.5, durationSec * 0.8]
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 320, height: 320) // small — we only need hue + scene
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)

        // Labels we treat as "green scene" — VNClassifyImageRequest uses these names in its taxonomy.
        let greenLabels: Set<String> = [
            "grass", "lawn", "field", "meadow", "golf_course", "golf_green",
            "putting_green", "fairway", "turf",
        ]

        var hits = 0
        var hueSamples: [Float] = []

        for secs in sampleSecs {
            autoreleasepool {
                let time = CMTimeMakeWithSeconds(secs, preferredTimescale: 600)
                guard let cgImage = try? generator.copyCGImage(at: time, actualTime: nil) else { return }

                // --- Scene classifier ---
                let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
                let sceneRequest = VNClassifyImageRequest()
                if (try? handler.perform([sceneRequest])) != nil,
                   let observations = sceneRequest.results {
                    for obs in observations {
                        if obs.confidence >= 0.3 && greenLabels.contains(obs.identifier.lowercased()) {
                            hits += 1
                            break
                        }
                    }
                }

                // --- Dominant-green hue analysis (cheap downsample) ---
                let ratio = self.greenPixelRatio(cgImage: cgImage)
                hueSamples.append(ratio)
            }
        }

        let classifierHit = hits >= 1
        let greenHueRatio = hueSamples.isEmpty ? 0 : hueSamples.reduce(0, +) / Float(hueSamples.count)
        print("[Classifier] sceneSignal classifierHit=\(classifierHit) greenHueRatio=\(String(format: "%.2f", greenHueRatio))")
        return SceneSignal(classifierHit: classifierHit, greenHueRatio: greenHueRatio)
    }

    /// Fraction of pixels in the CGImage whose hue falls in the green range (~80°..160°) and
    /// are reasonably saturated/bright. Cheap — downsamples to ~80x80 before iterating.
    private func greenPixelRatio(cgImage: CGImage) -> Float {
        let targetW = 80
        let targetH = 80
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bytesPerPixel = 4
        let bytesPerRow = targetW * bytesPerPixel
        var pixelData = [UInt8](repeating: 0, count: targetW * targetH * bytesPerPixel)

        guard let ctx = CGContext(
            data: &pixelData,
            width: targetW,
            height: targetH,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return 0 }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))

        var greenCount = 0
        let total = targetW * targetH
        for i in 0..<total {
            let offset = i * bytesPerPixel
            let r = Float(pixelData[offset]) / 255.0
            let g = Float(pixelData[offset + 1]) / 255.0
            let b = Float(pixelData[offset + 2]) / 255.0

            // Green-dominant test: G is clearly the largest channel and saturation is meaningful.
            let maxC = max(r, g, b)
            let minC = min(r, g, b)
            let delta = maxC - minC
            // Require g to be largest, meaningful saturation, and not too dark.
            if g > r && g > b && delta > 0.08 && maxC > 0.25 {
                // Hue roughly 80°..160° is "grass green" — with g dominant this is already close.
                // Filter out yellowish (r close to g) and teal (b close to g).
                if g - r > 0.04 && g - b > 0.02 {
                    greenCount += 1
                }
            }
        }
        return Float(greenCount) / Float(total)
    }

    // MARK: - Putt vs Swing Classifier (3-tier)
    //
    // Tier 1 — Wrist-relative zones (heavy weight):
    //   Avg wrist Y across backswing peak frames, compared to avg shoulder/hip Y.
    //   • wrist consistently above shoulder → +3 swing
    //   • wrist consistently below hip → +3 putt
    //   • wrist mid-waist → +2 "chip-like" → fold into swing for trim purposes
    //
    // Tier 2 — Legacy body/audio signals (supporting evidence, reduced weights):
    //   Body displacement, bbox stability, backswing arc, audio transients, pose height ratio.
    //
    // Tier 3 — Scene classification:
    //   VNClassifyImageRequest scene hit + dominant-green hue ratio → putt bias.
    //
    // Inter-clip context (recentShotTypes): last 3 classifications on this hole
    //   nudge the score when signals are ambiguous.

    private func classifyShotType(
        poseFrames: [PoseFrame],
        impactFrameIndex: Int,
        backswingPeakY: CGFloat,
        audioTransients: [Double],
        impactTimeMs: Double,
        sceneSignal: SceneSignal?,
        recentShotTypes: [String]
    ) -> ShotType {
        var puttScore: Double = 0.0
        var swingScore: Double = 0.0

        // --- Tier 1: Wrist zones across backswing peak window ---
        // Average wrist Y across a small window around the impact frame (peak happens
        // just before impact). Compare to shoulder/hip Y in the same window.
        let peakStart = max(0, impactFrameIndex - 4)
        let peakEnd = min(poseFrames.count - 1, impactFrameIndex + 1)
        var wristYs: [CGFloat] = []
        var shoulderYs: [CGFloat] = []
        var hipYs: [CGFloat] = []
        if peakEnd >= peakStart {
            for i in peakStart...peakEnd {
                if let w = avgWristY(poseFrames[i]) { wristYs.append(w) }
                if let s = avgShoulderY(poseFrames[i]) { shoulderYs.append(s) }
                if let h = avgHipY(poseFrames[i]) { hipYs.append(h) }
            }
        }

        if !wristYs.isEmpty && !shoulderYs.isEmpty && !hipYs.isEmpty {
            let avgWrist = wristYs.reduce(0, +) / CGFloat(wristYs.count)
            let avgShoulder = shoulderYs.reduce(0, +) / CGFloat(shoulderYs.count)
            let avgHip = hipYs.reduce(0, +) / CGFloat(hipYs.count)
            // Use backswingPeakY too — the single highest wrist point tracked by the state machine.
            let peakY = max(backswingPeakY, wristYs.max() ?? 0)

            if peakY > avgShoulder + 0.02 {
                swingScore += 3.0
                print("[Classifier] tier1=wristAboveShoulder +3 swing peakY=\(String(format: "%.3f", peakY)) shoulderY=\(String(format: "%.3f", avgShoulder))")
            } else if avgWrist < avgHip - 0.02 && peakY < avgHip + 0.05 {
                puttScore += 3.0
                print("[Classifier] tier1=wristBelowHip +3 putt avgWrist=\(String(format: "%.3f", avgWrist)) hipY=\(String(format: "%.3f", avgHip))")
            } else if avgWrist >= avgHip && avgWrist <= avgShoulder {
                // Mid-waist: chip-like. Plan folds chip into swing for trim purposes.
                swingScore += 2.0
                print("[Classifier] tier1=wristMidWaist +2 swing(chip-like) avgWrist=\(String(format: "%.3f", avgWrist)) hip=\(String(format: "%.3f", avgHip)) shoulder=\(String(format: "%.3f", avgShoulder))")
            }
        } else {
            print("[Classifier] tier1=insufficientPoseAtPeak window=\(peakStart)..\(peakEnd) poseFrames=\(poseFrames.count)")
        }

        // --- Tier 2: Legacy body/audio signals (reduced weights) ---
        // Signal 1: Total body displacement across all joints ---
        // Sum displacement of ALL tracked joints across a window around impact.
        // This works from any angle because a full swing moves the entire body.
        let windowStart = max(0, impactFrameIndex - 5)
        let windowEnd = min(poseFrames.count - 1, impactFrameIndex + 2)

        if windowEnd > windowStart {
            var totalDisplacement: CGFloat = 0.0
            for i in (windowStart + 1)...windowEnd {
                let prev = poseFrames[i - 1]
                let curr = poseFrames[i]
                totalDisplacement += jointDisplacement(prev, curr)
            }
            let avgDisplacement = totalDisplacement / CGFloat(windowEnd - windowStart)

            // Tier-2 weights halved vs legacy — Tier 1 (wrist zones) is the primary signal.
            if avgDisplacement < 0.10 {
                puttScore += 1.0
            } else if avgDisplacement < 0.14 {
                puttScore += 0.5
            } else if avgDisplacement > 0.15 {
                swingScore += 1.0
            } else {
                swingScore += 0.5
            }

            print("[Classifier] signal=bodyDisplacement value=\(String(format: "%.3f", avgDisplacement))")
        }

        // --- Signal 2: Skeleton bounding box stability ---
        // Measure how much the bounding box around all joints changes.
        if windowEnd > windowStart {
            var maxBBoxChange: CGFloat = 0.0
            for i in (windowStart + 1)...windowEnd {
                let prevBBox = skeletonBBox(poseFrames[i - 1])
                let currBBox = skeletonBBox(poseFrames[i])
                if let pb = prevBBox, let cb = currBBox {
                    let widthChange = abs(cb.width - pb.width)
                    let heightChange = abs(cb.height - pb.height)
                    maxBBoxChange = max(maxBBoxChange, widthChange + heightChange)
                }
            }

            // Tier-2 weights halved.
            if maxBBoxChange < 0.08 {
                puttScore += 0.75
            } else if maxBBoxChange > 0.12 {
                swingScore += 0.75
            }

            print("[Classifier] signal=bboxChange value=\(String(format: "%.3f", maxBBoxChange))")
        }

        // --- Signal 3: Backswing arc height ---
        // The backswingPeakY is already tracked by the state machine.
        // Full swings have high arcs, putts have minimal lift.
        let shoulderY = poseFrames.count > impactFrameIndex
            ? (avgShoulderY(poseFrames[min(impactFrameIndex, poseFrames.count - 1)]) ?? 0.55)
            : 0.55
        let hipY = poseFrames.count > impactFrameIndex
            ? (avgHipY(poseFrames[min(impactFrameIndex, poseFrames.count - 1)]) ?? 0.35)
            : 0.35
        let arcRelativeToBody = backswingPeakY - hipY

        // Tier-2 weights halved — arc is supporting evidence for wrist-zone tier 1.
        if arcRelativeToBody < 0.12 {
            puttScore += 1.0
        } else if arcRelativeToBody < 0.18 {
            puttScore += 0.5
        } else if arcRelativeToBody > 0.25 {
            swingScore += 1.0
        } else {
            swingScore += 0.5
        }

        print("[Classifier] signal=backswingArc value=\(String(format: "%.3f", arcRelativeToBody)) peakY=\(String(format: "%.3f", backswingPeakY))")

        // --- Signal 4: Audio transient energy ---
        // We don't have raw energy here, but we can use whether an audio match was
        // found and how many transients exist. Putts produce fewer/weaker transients.
        let nearbyTransients = audioTransients.filter { abs($0 - impactTimeMs) < 500.0 }
        let totalTransients = audioTransients.count
        // Transient count heuristic:
        //   0 transients at all -> likely a putt (quiet tap)
        //   1 transient near impact -> classic swing (loud crack)
        //   2+ transients -> swing with club waggle / multiple hits
        if totalTransients == 0 {
            puttScore += 0.75
        } else if totalTransients == 1 && !nearbyTransients.isEmpty {
            swingScore += 0.5
        } else if totalTransients >= 2 {
            swingScore += 0.25
        }
        if nearbyTransients.isEmpty && totalTransients > 0 {
            // Transients exist elsewhere but not near impact — soft sound at impact
            puttScore += 0.25
        }
        print("[Classifier] signal=audioTransients total=\(totalTransients) nearby=\(nearbyTransients.count)")

        // --- Signal 5: Pose height ratio ---
        // If the person is small in frame, they're far from the camera = likely on green.
        let poseHeight = poseHeightRatio(poseFrames, near: impactFrameIndex)
        if let ph = poseHeight {
            if ph < 0.20 {
                puttScore += 0.75  // Small in frame = far away = green
            } else if ph > 0.45 {
                swingScore += 0.5  // Large in frame = close = tee/fairway
            }
            print("[Classifier] signal=poseHeightRatio value=\(String(format: "%.3f", ph))")
        }

        // --- Tier 3: Scene classification + green hue ---
        if let scene = sceneSignal {
            // If the VNClassifyImageRequest matched a golf/grass label AND the dominant
            // green hue is >60% of pixels, this is almost certainly a putt on a green.
            if scene.classifierHit && scene.greenHueRatio > 0.60 {
                puttScore += 1.5
                print("[Classifier] tier3=sceneClassifier+greenHue +1.5 putt")
            } else if scene.greenHueRatio > 0.70 {
                // Very high green ratio alone (strong grass dominance) leans putt
                puttScore += 1.0
                print("[Classifier] tier3=greenHueHeavy +1.0 putt ratio=\(String(format: "%.2f", scene.greenHueRatio))")
            } else if scene.classifierHit {
                puttScore += 0.5
                print("[Classifier] tier3=sceneClassifierOnly +0.5 putt")
            }
        }

        // --- Inter-clip context: recent shot types on the same hole ---
        // Only applied when Tier 1 wasn't decisive (score gap < 2).
        if !recentShotTypes.isEmpty {
            let gap = abs(puttScore - swingScore)
            if gap < 2.0 {
                let recent = recentShotTypes.suffix(3)
                let swingCount = recent.filter { $0 == "swing" }.count
                let puttCount = recent.filter { $0 == "putt" }.count
                if recent.count >= 3 && swingCount == recent.count {
                    swingScore += 1.0
                    print("[Classifier] context=last3AllSwings +1 swing")
                } else if puttCount > swingCount && recent.last == "putt" {
                    puttScore += 1.0
                    print("[Classifier] context=recentPutts +1 putt")
                }
            }
        }

        let shotType: ShotType = puttScore > swingScore ? .putt : .swing
        print("[Classifier] poseClassification result=\(shotType.rawValue) puttScore=\(String(format: "%.1f", puttScore)) swingScore=\(String(format: "%.1f", swingScore)) recent=\(recentShotTypes.joined(separator: ","))")
        return shotType
    }

    // MARK: - Fallback classifier (no pose data)
    //
    // When pose detection fails (side angle, low light, long distance), we still
    // want a usable shotType so clips can be grouped into holes. Uses clip
    // duration + audio transient count. Higher recall for putts is intentional —
    // users can manually fix grouping, but a missed putt means every clip collapses
    // into one hole.
    private func fallbackClassify(
        durationMs: Double,
        audioTransients: [Double],
        sceneSignal: SceneSignal? = nil,
        recentShotTypes: [String] = []
    ) -> (shotType: ShotType, confidence: Double, reason: String) {
        let durationSec = durationMs / 1000.0
        let transientCount = audioTransients.count

        // Strong scene signal can override duration-only guesses when pose is absent.
        let strongGreenScene = (sceneSignal?.classifierHit ?? false) && (sceneSignal?.greenHueRatio ?? 0) > 0.60

        // Strong putt signals: no audio + long clip, or very long clip.
        if durationSec > 30.0 {
            return (.putt, 0.35, "durationVeryLong(\(String(format: "%.1f", durationSec))s)")
        }
        if transientCount == 0 && durationSec > 8.0 {
            return (.putt, 0.30, "noAudio+longClip(\(String(format: "%.1f", durationSec))s)")
        }
        if durationSec > 12.0 {
            return (.putt, 0.25, "durationLong(\(String(format: "%.1f", durationSec))s)")
        }

        // Strong swing signals: short clip or 1 sharp transient.
        if durationSec < 6.0 {
            // Scene override: short but clearly on a green → putt.
            if strongGreenScene {
                return (.putt, 0.35, "shortClipButGreenScene")
            }
            return (.swing, 0.30, "durationShort(\(String(format: "%.1f", durationSec))s)")
        }
        if transientCount == 1 {
            if strongGreenScene {
                return (.putt, 0.30, "singleTransientButGreenScene")
            }
            return (.swing, 0.35, "singleTransient")
        }

        // Ambiguous 6-12s range — scene + inter-clip context tip the default.
        if strongGreenScene {
            return (.putt, 0.30, "ambiguousDurationButGreenScene")
        }
        if let last = recentShotTypes.last, last == "putt" {
            return (.putt, 0.22, "ambiguousFollowingPutt")
        }
        return (.swing, 0.20, "durationMid(\(String(format: "%.1f", durationSec))s)")
    }

    /// Total displacement of all visible joints between two frames
    private func jointDisplacement(_ a: PoseFrame, _ b: PoseFrame) -> CGFloat {
        var total: CGFloat = 0.0
        var count: CGFloat = 0.0

        let pairs: [(CGPoint?, CGPoint?)] = [
            (a.leftWrist, b.leftWrist), (a.rightWrist, b.rightWrist),
            (a.leftElbow, b.leftElbow), (a.rightElbow, b.rightElbow),
            (a.leftShoulder, b.leftShoulder), (a.rightShoulder, b.rightShoulder),
            (a.leftHip, b.leftHip), (a.rightHip, b.rightHip),
            (a.nose, b.nose),
        ]

        for (pa, pb) in pairs {
            if let p1 = pa, let p2 = pb {
                total += hypot(p2.x - p1.x, p2.y - p1.y)
                count += 1.0
            }
        }

        return count > 0 ? total / count : 0.0
    }

    /// Bounding box around all visible joints in a frame
    private func skeletonBBox(_ frame: PoseFrame) -> CGRect? {
        let points = [frame.leftWrist, frame.rightWrist, frame.leftElbow, frame.rightElbow,
                      frame.leftShoulder, frame.rightShoulder, frame.leftHip, frame.rightHip, frame.nose]
            .compactMap { $0 }

        guard points.count >= 3 else { return nil }

        let minX = points.map(\.x).min()!
        let maxX = points.map(\.x).max()!
        let minY = points.map(\.y).min()!
        let maxY = points.map(\.y).max()!

        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// How much of the frame height the person occupies (0..1)
    private func poseHeightRatio(_ frames: [PoseFrame], near index: Int) -> CGFloat? {
        let start = max(0, index - 2)
        let end = min(frames.count - 1, index + 2)
        var maxHeight: CGFloat = 0.0

        for i in start...end {
            if let bbox = skeletonBBox(frames[i]) {
                maxHeight = max(maxHeight, bbox.height)
            }
        }

        return maxHeight > 0 ? maxHeight : nil
    }

    // MARK: - Stitch Clips (AVMutableComposition)

    private func stitchClipsOnDevice(clipUris: [String], promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            let startTime = CACurrentMediaTime()

            guard !clipUris.isEmpty else {
                promise.reject(Exception(name: "ERR_NO_CLIPS", description: "No clip URIs provided"))
                return
            }

            let composition = AVMutableComposition()
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                promise.reject(Exception(name: "ERR_COMPOSITION", description: "Could not create composition tracks"))
                return
            }
            // Audio track is created lazily only if at least one clip has audio.
            // An empty audio track in a composition causes AVAssetExportSession
            // to fail with AVErrorOperationNotSupportedForAsset (-11838) when a
            // custom AVVideoComposition is also set. The CameraView records
            // `mute` so source clips have no audio — keeping an empty audio
            // track in the composition is what was breaking export.
            var audioTrack: AVMutableCompositionTrack? = nil

            var insertTime = CMTime.zero
            var renderSize = CGSize(width: 1080, height: 1920) // Default portrait 1080p
            var clipSegments: [ClipSegment] = []

            for (index, uri) in clipUris.enumerated() {
                let fileURL = self.resolveFileURL(uri)
                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Clip \(index) not found: \(fileURL.path)"))
                    return
                }

                let asset = AVURLAsset(url: fileURL)
                let duration = asset.duration

                // Insert video track
                if let assetVideoTrack = asset.tracks(withMediaType: .video).first {
                    do {
                        try videoTrack.insertTimeRange(
                            CMTimeRange(start: .zero, duration: duration),
                            of: assetVideoTrack,
                            at: insertTime
                        )
                        // Determine render size from the first clip
                        if index == 0 {
                            let size = assetVideoTrack.naturalSize
                            let transform = assetVideoTrack.preferredTransform
                            let isPortrait = abs(transform.b) == 1.0 && abs(transform.c) == 1.0
                            renderSize = isPortrait ? CGSize(width: size.height, height: size.width) : size
                        }
                        // Track each clip's segment info for per-clip transforms
                        let clipTimeRange = CMTimeRange(start: insertTime, duration: duration)
                        clipSegments.append(ClipSegment(
                            timeRange: clipTimeRange,
                            naturalSize: assetVideoTrack.naturalSize,
                            transform: assetVideoTrack.preferredTransform
                        ))
                    } catch {
                        promise.reject(Exception(name: "ERR_INSERT_VIDEO", description: "Failed to insert video track \(index): \(error.localizedDescription)"))
                        return
                    }
                }

                // Insert audio track (if present). Lazily create the
                // composition's audio track on first clip that has audio so
                // we never end up with an empty audio track (see -11838 note).
                if let assetAudioTrack = asset.tracks(withMediaType: .audio).first {
                    if audioTrack == nil {
                        audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                    }
                    do {
                        try audioTrack?.insertTimeRange(
                            CMTimeRange(start: .zero, duration: duration),
                            of: assetAudioTrack,
                            at: insertTime
                        )
                    } catch {
                        // Audio insertion failure is non-fatal — some clips may not have audio
                        print("[ShotDetector] Warning: audio insert failed for clip \(index)")
                    }
                }

                insertTime = CMTimeAdd(insertTime, duration)

                self.sendEvent("onStitchProgress", [
                    "phase": "composing",
                    "current": index + 1,
                    "total": clipUris.count,
                    "percent": Double(index + 1) / Double(clipUris.count) * 50.0,
                ])
            }

            // ---- Passthrough fast path ----
            // When every clip shares dimensions + orientation (always true for
            // camera recordings and our own trim outputs, which are themselves
            // passthrough copies of camera footage), no per-clip transform is
            // needed — so skip the AVVideoComposition entirely and export with
            // Passthrough: a container-level sample copy, ZERO re-encode.
            // 100 clips stitch in seconds instead of minutes. Mixed formats
            // (e.g. imported Photos videos with different resolutions) fall
            // through to the legacy re-encode below, as does ANY passthrough
            // failure (codec quirks like -11838) — nothing is ever lost.
            let uniformFormat = !clipSegments.isEmpty && clipSegments.allSatisfy {
                $0.naturalSize == clipSegments[0].naturalSize && $0.transform == clipSegments[0].transform
            }
            if uniformFormat {
                // Composition tracks default to identity; carry the source
                // orientation so players rotate portrait footage correctly.
                videoTrack.preferredTransform = clipSegments[0].transform
                let ptURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                    .appendingPathComponent("stitch_\(UUID().uuidString).mp4")
                try? FileManager.default.removeItem(at: ptURL)
                if let ptSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) {
                    ptSession.outputURL = ptURL
                    ptSession.outputFileType = .mp4
                    ptSession.shouldOptimizeForNetworkUse = true
                    let ptSem = DispatchSemaphore(value: 0)
                    ptSession.exportAsynchronously { ptSem.signal() }
                    while ptSession.status == .waiting || ptSession.status == .exporting {
                        Thread.sleep(forTimeInterval: 0.2)
                        self.sendEvent("onStitchProgress", [
                            "phase": "exporting",
                            "current": clipUris.count,
                            "total": clipUris.count,
                            "percent": 50.0 + Double(ptSession.progress) * 50.0,
                        ])
                    }
                    ptSem.wait()
                    if ptSession.status == .completed {
                        let elapsed = CACurrentMediaTime() - startTime
                        let totalDuration = CMTimeGetSeconds(insertTime)
                        print("[Clippar.Stitch] passthrough OK clips=\(clipUris.count) durationSec=\(String(format: "%.1f", totalDuration)) elapsedSec=\(String(format: "%.2f", elapsed))")
                        promise.resolve([
                            "stitchedUri": ptURL.absoluteString,
                            "durationMs": totalDuration * 1000.0,
                            "clipCount": clipUris.count,
                        ] as [String: Any])
                        return
                    }
                    print("[Clippar.Stitch] passthrough failed (\(ptSession.error?.localizedDescription ?? "status \(ptSession.status.rawValue)")) — falling back to re-encode")
                    try? FileManager.default.removeItem(at: ptURL)
                    // Restore identity so the legacy path's per-clip transforms
                    // aren't double-applied on top of a rotated track.
                    videoTrack.preferredTransform = .identity
                }
            }

            // Build per-clip video composition with individual transforms
            let videoComposition = AVMutableVideoComposition()
            videoComposition.renderSize = renderSize
            videoComposition.frameDuration = CMTime(value: 1, timescale: 30)

            var instructions: [AVMutableVideoCompositionInstruction] = []
            for segment in clipSegments {
                let instruction = AVMutableVideoCompositionInstruction()
                instruction.timeRange = segment.timeRange

                let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
                let fillTransform = self.computeFillTransform(
                    naturalSize: segment.naturalSize,
                    preferredTransform: segment.transform,
                    renderSize: renderSize
                )
                layerInstruction.setTransform(fillTransform, at: segment.timeRange.start)
                instruction.layerInstructions = [layerInstruction]
                instructions.append(instruction)
            }
            videoComposition.instructions = instructions

            // Export stitched composition
            let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                .appendingPathComponent("stitch_\(UUID().uuidString).mp4")
            try? FileManager.default.removeItem(at: outputURL)

            // Use size-specific preset (forces H.264 1080p SDR) instead of
            // HighestQuality. With a custom AVVideoComposition on HEVC/HDR/
            // Dolby Vision source (the iPhone camera default since iOS 17+),
            // HighestQuality returns AVErrorOperationNotSupportedForAsset
            // (-11838) at export time because it can't pick an output format.
            // 1920x1080 forces a known good codec/colorspace combo and matches
            // the camera's recording resolution, so there's no visible loss.
            let presetName = AVAssetExportPreset1920x1080
            guard let exportSession = AVAssetExportSession(asset: composition, presetName: presetName) else {
                promise.reject(Exception(name: "ERR_EXPORT_SESSION", description: "Could not create export session for stitched composition"))
                return
            }

            exportSession.outputURL = outputURL
            exportSession.outputFileType = .mp4
            exportSession.videoComposition = videoComposition
            exportSession.shouldOptimizeForNetworkUse = true

            let semaphore = DispatchSemaphore(value: 0)
            var exportError: Error?

            exportSession.exportAsynchronously {
                if exportSession.status == .failed {
                    exportError = exportSession.error
                }
                semaphore.signal()
            }

            // Poll export progress instead of blocking wait
            while exportSession.status == .waiting || exportSession.status == .exporting {
                Thread.sleep(forTimeInterval: 0.5)
                let exportPercent = 50.0 + Double(exportSession.progress) * 50.0
                self.sendEvent("onStitchProgress", [
                    "phase": "exporting",
                    "current": clipUris.count,
                    "total": clipUris.count,
                    "percent": exportPercent,
                ])
            }

            semaphore.wait()

            if let error = exportError {
                let nsErr = error as NSError
                let underlying = (nsErr.userInfo[NSUnderlyingErrorKey] as? NSError).map { "code=\($0.code) domain=\($0.domain)" } ?? "none"
                print("[Clippar.Stitch] FAIL exportSession.status=\(exportSession.status.rawValue) error=\(error.localizedDescription) code=\(nsErr.code) domain=\(nsErr.domain) underlying=\(underlying) userInfo=\(nsErr.userInfo)")
                print("[Clippar.Stitch] context: clipCount=\(clipUris.count) renderSize=\(renderSize) videoCompositionInstructions=\(videoComposition.instructions.count)")
                promise.reject(Exception(name: "ERR_STITCH_FAILED", description: "Stitch export failed: \(error.localizedDescription) (code \(nsErr.code))"))
                return
            }

            let elapsed = CACurrentMediaTime() - startTime
            let totalDuration = CMTimeGetSeconds(insertTime)
            print("[ShotDetector] Stitched \(clipUris.count) clips (\(String(format: "%.1f", totalDuration))s total) in \(String(format: "%.2f", elapsed))s")

            promise.resolve([
                "stitchedUri": outputURL.absoluteString,
                "durationMs": totalDuration * 1000.0,
                "clipCount": clipUris.count,
            ] as [String: Any])
        }
    }

    // MARK: - Per-Clip Transform Helper

    private struct ClipSegment {
        let timeRange: CMTimeRange
        let naturalSize: CGSize
        let transform: CGAffineTransform
    }

    internal func computeFillTransform(
        naturalSize: CGSize,
        preferredTransform: CGAffineTransform,
        renderSize: CGSize
    ) -> CGAffineTransform {
        // Apply the preferred transform to get the "display" size
        let transformedRect = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
        let displaySize = CGSize(width: abs(transformedRect.width), height: abs(transformedRect.height))

        // Scale to fill renderSize (aspect-fill, then center)
        let scaleX = renderSize.width / displaySize.width
        let scaleY = renderSize.height / displaySize.height
        let scale = max(scaleX, scaleY) // aspect-fill

        let scaledWidth = displaySize.width * scale
        let scaledHeight = displaySize.height * scale
        let tx = (renderSize.width - scaledWidth) / 2
        let ty = (renderSize.height - scaledHeight) / 2

        // Combine: preferredTransform -> scale -> translate to center
        let transform = preferredTransform
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: tx, y: ty))

        return transform
    }

    // MARK: - Compose Reel (Stitch + Scorecard Overlay + Music)

    private struct ScorecardHole: Codable {
        let holeNumber: Int
        let par: Int
        let strokes: Int
        let startMs: Double
        let endMs: Double
    }

    private struct ScorecardData: Codable {
        let courseName: String
        let totalPar: Int
        let totalStrokes: Int
        let holes: [ScorecardHole]
    }

    // MARK: - Fast reel compose (segment-parallel + passthrough concat)
    //
    // The legacy compose path (below) exports the ENTIRE reel through one
    // AVAssetExportSession whose AVVideoCompositionCoreAnimationTool carries
    // the full-round scorecard tree — a full-screen container per hole,
    // hundreds of layers. For a 100-shot round that's ~7 minutes of video
    // re-encoded at roughly realtime: ~8 minutes of wall clock.
    //
    // Fast path:
    //   1. Group clips into per-hole segments (scorecard hole ranges;
    //      fixed-size chunks when there's no scorecard).
    //   2. Export segments CONCURRENTLY (3 at a time), each carrying only its
    //      own hole's small static card — cheap for the animation tool.
    //   3. Concatenate segments with AVAssetExportPresetPassthrough: a
    //      container-level copy, no re-encode.
    //   4. Music: audio-only mixed export (M4A honors audioMix and audio
    //      encodes at many× realtime), then a passthrough mux of untouched
    //      video + mixed audio.
    //
    // Every helper throws on failure; composeReelOnDevice falls back to the
    // legacy single-session path, so the fast path can never lose a reel.

    private struct FastParsedClip {
        let url: URL
        let sourceRange: CMTimeRange
        let naturalSize: CGSize
        let transform: CGAffineTransform
        let hasAudio: Bool
        let durationSec: Double
    }

    private struct FastComposeError: Error, CustomStringConvertible {
        let stage: String
        let message: String
        var description: String { "\(stage): \(message)" }
    }

    /// Parse the JS clip dictionaries into concrete trim ranges. Mirrors the
    /// legacy parse loop (clamping, zero-length skip, renderSize from the
    /// first usable clip) exactly.
    private func fastParseClips(_ clips: [[String: Any]]) throws -> (parsed: [FastParsedClip], renderSize: CGSize) {
        var parsed: [FastParsedClip] = []
        var renderSize = CGSize(width: 1080, height: 1920)
        for (index, clipDict) in clips.enumerated() {
            guard let uri = clipDict["uri"] as? String else {
                throw FastComposeError(stage: "parse", message: "clip \(index) missing uri")
            }
            let fileURL = resolveFileURL(uri)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                throw FastComposeError(stage: "parse", message: "clip \(index) not found: \(fileURL.path)")
            }
            let asset = AVURLAsset(url: fileURL)
            guard let videoTrack = asset.tracks(withMediaType: .video).first else {
                throw FastComposeError(stage: "parse", message: "clip \(index) has no video track")
            }
            let assetDurationMs = CMTimeGetSeconds(asset.duration) * 1000.0
            let trimStartMs = (clipDict["trimStartMs"] as? Double) ?? 0
            let rawTrimEndMs = (clipDict["trimEndMs"] as? Double) ?? -1
            let effectiveStartMs = max(0, min(trimStartMs, assetDurationMs))
            let effectiveEndMs: Double = rawTrimEndMs < 0 ? assetDurationMs : min(rawTrimEndMs, assetDurationMs)
            let trimDurationMs = max(0, effectiveEndMs - effectiveStartMs)
            if trimDurationMs <= 0 { continue }
            if parsed.isEmpty {
                let size = videoTrack.naturalSize
                let t = videoTrack.preferredTransform
                let isPortrait = abs(t.b) == 1.0 && abs(t.c) == 1.0
                renderSize = isPortrait ? CGSize(width: size.height, height: size.width) : size
            }
            parsed.append(FastParsedClip(
                url: fileURL,
                sourceRange: CMTimeRange(
                    start: CMTime(seconds: effectiveStartMs / 1000.0, preferredTimescale: 600),
                    duration: CMTime(seconds: trimDurationMs / 1000.0, preferredTimescale: 600)
                ),
                naturalSize: videoTrack.naturalSize,
                transform: videoTrack.preferredTransform,
                hasAudio: !asset.tracks(withMediaType: .audio).isEmpty,
                durationSec: trimDurationMs / 1000.0
            ))
        }
        guard !parsed.isEmpty else {
            throw FastComposeError(stage: "parse", message: "no non-empty clips")
        }
        return (parsed, renderSize)
    }

    /// Group parsed clips into per-hole segments by matching each clip's reel
    /// timeline midpoint against the scorecard's hole ranges (JS computed
    /// those ranges from the same cumulative durations). No scorecard →
    /// fixed-size chunks so parallelism still applies.
    private func fastGroupSegments(
        _ parsed: [FastParsedClip],
        scorecard: ScorecardData?
    ) -> [(holeIndex: Int?, clips: [FastParsedClip])] {
        guard let sc = scorecard, !sc.holes.isEmpty else {
            let chunkSize = 6
            var chunks: [(holeIndex: Int?, clips: [FastParsedClip])] = []
            var i = 0
            while i < parsed.count {
                let end = min(i + chunkSize, parsed.count)
                chunks.append((holeIndex: nil, clips: Array(parsed[i..<end])))
                i = end
            }
            return chunks
        }
        var perHole: [[FastParsedClip]] = Array(repeating: [], count: sc.holes.count)
        var cursorMs: Double = 0
        for clip in parsed {
            let midMs = cursorMs + clip.durationSec * 500.0
            var holeIdx = sc.holes.count - 1
            for (i, hole) in sc.holes.enumerated() where midMs >= hole.startMs && midMs < hole.endMs {
                holeIdx = i
                break
            }
            perHole[holeIdx].append(clip)
            cursorMs += clip.durationSec * 1000.0
        }
        var segments: [(holeIndex: Int?, clips: [FastParsedClip])] = []
        for (i, clips) in perHole.enumerated() where !clips.isEmpty {
            segments.append((holeIndex: i, clips: clips))
        }
        return segments
    }

    /// The full scorecard card for ONE hole's state, as a static layer tree.
    /// Layout is a line-for-line replica of the legacy whole-reel overlay —
    /// but with only this hole's dynamic layers and no cross-hole fade
    /// animations (segments cut exactly at hole boundaries, so the card
    /// state changes at the cut just like the legacy fades did).
    private func fastBuildHoleCard(sc: ScorecardData, index: Int, renderSize: CGSize) -> CALayer {
        let container = CALayer()
        container.frame = CGRect(origin: .zero, size: renderSize)

        let scale = UIScreen.main.scale
        let cardWidth: CGFloat = renderSize.width * 0.94
        let cardX: CGFloat = (renderSize.width - cardWidth) / 2
        let cardHeight: CGFloat = renderSize.height * 0.18
        let topPadding: CGFloat = renderSize.height * 0.04
        let cardY: CGFloat = renderSize.height - cardHeight - topPadding
        let inset: CGFloat = renderSize.width * 0.018
        let rowGap: CGFloat = cardHeight * 0.05
        let row1Height: CGFloat = cardHeight * 0.20
        let row2Height: CGFloat = cardHeight * 0.42
        let row3Height: CGFloat = cardHeight * 0.30
        let row1Y: CGFloat = cardY + cardHeight - row1Height - inset
        let row2Y: CGFloat = row1Y - row2Height - rowGap
        let row3Y: CGFloat = row2Y - row3Height - rowGap

        let bgLayer = CALayer()
        bgLayer.frame = CGRect(x: cardX, y: cardY, width: cardWidth, height: cardHeight)
        bgLayer.backgroundColor = UIColor(white: 0, alpha: 0.45).cgColor
        bgLayer.cornerRadius = 18
        bgLayer.borderWidth = 1
        bgLayer.borderColor = UIColor(white: 1, alpha: 0.12).cgColor
        container.addSublayer(bgLayer)

        let courseText = CATextLayer()
        courseText.string = sc.courseName
        courseText.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
        courseText.fontSize = renderSize.width * 0.022
        courseText.foregroundColor = UIColor(white: 1, alpha: 0.55).cgColor
        courseText.alignmentMode = .left
        courseText.truncationMode = .end
        courseText.contentsScale = scale
        courseText.frame = CGRect(
            x: cardX + inset, y: row1Y,
            width: cardWidth * 0.55, height: row1Height
        )
        container.addSublayer(courseText)

        let stripX = cardX + inset
        let stripWidth = cardWidth - inset * 2
        let cellWidth = stripWidth / CGFloat(max(1, sc.holes.count))
        for (cellIdx, hole) in sc.holes.enumerated() {
            let cellX = stripX + cellWidth * CGFloat(cellIdx)
            let holeNumLayer = CATextLayer()
            holeNumLayer.string = "\(hole.holeNumber)"
            holeNumLayer.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
            holeNumLayer.fontSize = renderSize.width * 0.018
            holeNumLayer.foregroundColor = UIColor(white: 1, alpha: 0.4).cgColor
            holeNumLayer.alignmentMode = .center
            holeNumLayer.contentsScale = scale
            holeNumLayer.frame = CGRect(
                x: cellX, y: row2Y + row2Height * 0.65,
                width: cellWidth, height: row2Height * 0.30
            )
            container.addSublayer(holeNumLayer)

            let parLabel = CATextLayer()
            parLabel.string = "\(hole.par)"
            parLabel.font = UIFont.systemFont(ofSize: 1, weight: .regular) as CTFont
            parLabel.fontSize = renderSize.width * 0.014
            parLabel.foregroundColor = UIColor(white: 1, alpha: 0.25).cgColor
            parLabel.alignmentMode = .center
            parLabel.contentsScale = scale
            parLabel.frame = CGRect(
                x: cellX, y: row2Y + row2Height * 0.05,
                width: cellWidth, height: row2Height * 0.25
            )
            container.addSublayer(parLabel)
        }

        let hole = sc.holes[index]
        var cumulativeScore = 0
        var cumulativePar = 0
        for i in 0...index {
            cumulativeScore += sc.holes[i].strokes
            cumulativePar += sc.holes[i].par
        }
        let cumulativeStp = cumulativeScore - cumulativePar

        let stpColor: UIColor
        if cumulativeStp < 0 {
            stpColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
        } else if cumulativeStp == 0 {
            stpColor = UIColor.white
        } else {
            stpColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
        }

        let totalLabel = CATextLayer()
        totalLabel.string = "TOTAL"
        totalLabel.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
        totalLabel.fontSize = renderSize.width * 0.018
        totalLabel.foregroundColor = UIColor(white: 1, alpha: 0.5).cgColor
        totalLabel.alignmentMode = .right
        totalLabel.contentsScale = scale
        totalLabel.frame = CGRect(
            x: cardX + cardWidth * 0.55, y: row1Y + row1Height * 0.15,
            width: cardWidth * 0.18, height: row1Height * 0.7
        )
        container.addSublayer(totalLabel)

        let totalNumber = CATextLayer()
        totalNumber.string = "\(cumulativeScore)"
        totalNumber.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
        totalNumber.fontSize = renderSize.width * 0.024
        totalNumber.foregroundColor = UIColor.white.cgColor
        totalNumber.alignmentMode = .right
        totalNumber.contentsScale = scale
        totalNumber.frame = CGRect(
            x: cardX + cardWidth * 0.74, y: row1Y + row1Height * 0.10,
            width: cardWidth * 0.10, height: row1Height * 0.85
        )
        container.addSublayer(totalNumber)

        let stpString: String
        if cumulativeStp < 0 { stpString = "\(cumulativeStp)" }
        else if cumulativeStp == 0 { stpString = "E" }
        else { stpString = "+\(cumulativeStp)" }

        let badgeWidth: CGFloat = cardWidth * 0.10
        let badgeHeight: CGFloat = row1Height * 0.85
        let badgeBG = CALayer()
        badgeBG.frame = CGRect(
            x: cardX + cardWidth - inset - badgeWidth, y: row1Y + row1Height * 0.075,
            width: badgeWidth, height: badgeHeight
        )
        badgeBG.backgroundColor = stpColor.withAlphaComponent(0.22).cgColor
        badgeBG.cornerRadius = badgeHeight / 2
        container.addSublayer(badgeBG)

        let badgeText = CATextLayer()
        badgeText.string = stpString
        badgeText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
        badgeText.fontSize = renderSize.width * 0.018
        badgeText.foregroundColor = stpColor.cgColor
        badgeText.alignmentMode = .center
        badgeText.contentsScale = scale
        badgeText.frame = CGRect(
            x: badgeBG.frame.minX, y: badgeBG.frame.minY + badgeHeight * 0.18,
            width: badgeWidth, height: badgeHeight * 0.7
        )
        container.addSublayer(badgeText)

        for (cellIdx, h) in sc.holes.enumerated() {
            let isPlayed = cellIdx <= index
            let cellX = stripX + cellWidth * CGFloat(cellIdx)
            if cellIdx == index {
                let highlight = CALayer()
                highlight.frame = CGRect(
                    x: cellX + cellWidth * 0.06, y: row2Y,
                    width: cellWidth * 0.88, height: row2Height
                )
                highlight.backgroundColor = UIColor(white: 1, alpha: 0.10).cgColor
                highlight.cornerRadius = 8
                container.addSublayer(highlight)
            }
            let cellSTP = h.strokes - h.par
            let cellColor: UIColor
            if !isPlayed {
                cellColor = UIColor(white: 1, alpha: 0.25)
            } else if cellSTP < 0 {
                cellColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
            } else if cellSTP == 0 {
                cellColor = UIColor.white
            } else {
                cellColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
            }
            let cellScore = CATextLayer()
            cellScore.string = isPlayed ? "\(h.strokes)" : "-"
            cellScore.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
            cellScore.fontSize = renderSize.width * 0.022
            cellScore.foregroundColor = cellColor.cgColor
            cellScore.alignmentMode = .center
            cellScore.contentsScale = scale
            cellScore.frame = CGRect(
                x: cellX, y: row2Y + row2Height * 0.30,
                width: cellWidth, height: row2Height * 0.40
            )
            container.addSublayer(cellScore)
        }

        let holeBigText = CATextLayer()
        holeBigText.string = "Hole \(hole.holeNumber)"
        holeBigText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
        holeBigText.fontSize = renderSize.width * 0.030
        holeBigText.foregroundColor = UIColor.white.cgColor
        holeBigText.alignmentMode = .left
        holeBigText.contentsScale = scale
        holeBigText.frame = CGRect(
            x: cardX + inset, y: row3Y + row3Height * 0.10,
            width: cardWidth * 0.30, height: row3Height * 0.85
        )
        container.addSublayer(holeBigText)

        let holeParBigText = CATextLayer()
        holeParBigText.string = "Par \(hole.par)"
        holeParBigText.font = UIFont.systemFont(ofSize: 1, weight: .medium) as CTFont
        holeParBigText.fontSize = renderSize.width * 0.020
        holeParBigText.foregroundColor = UIColor(white: 1, alpha: 0.5).cgColor
        holeParBigText.alignmentMode = .left
        holeParBigText.contentsScale = scale
        holeParBigText.frame = CGRect(
            x: cardX + cardWidth * 0.32, y: row3Y + row3Height * 0.20,
            width: cardWidth * 0.20, height: row3Height * 0.7
        )
        container.addSublayer(holeParBigText)

        let holeStp = hole.strokes - hole.par
        let holeStpColor: UIColor
        if holeStp < 0 {
            holeStpColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
        } else if holeStp == 0 {
            holeStpColor = UIColor.white
        } else {
            holeStpColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
        }
        let holeStrokesText = CATextLayer()
        holeStrokesText.string = "\(hole.strokes)"
        holeStrokesText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
        holeStrokesText.fontSize = renderSize.width * 0.034
        holeStrokesText.foregroundColor = holeStpColor.cgColor
        holeStrokesText.alignmentMode = .right
        holeStrokesText.contentsScale = scale
        holeStrokesText.frame = CGRect(
            x: cardX + cardWidth * 0.6, y: row3Y + row3Height * 0.05,
            width: cardWidth * 0.4 - inset, height: row3Height * 0.9
        )
        container.addSublayer(holeStrokesText)

        return container
    }

    /// Export one segment (a hole's clips) with its static card burned in.
    private func fastExportSegment(
        clips: [FastParsedClip],
        overlay: CALayer?,
        renderSize: CGSize,
        outputURL: URL
    ) throws {
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw FastComposeError(stage: "segment", message: "could not create video track")
        }
        var audioTrack: AVMutableCompositionTrack? = nil
        var insertTime = CMTime.zero
        var instructions: [AVMutableVideoCompositionInstruction] = []

        for clip in clips {
            let asset = AVURLAsset(url: clip.url)
            guard let srcVideo = asset.tracks(withMediaType: .video).first else { continue }
            do {
                try videoTrack.insertTimeRange(clip.sourceRange, of: srcVideo, at: insertTime)
            } catch {
                throw FastComposeError(stage: "segment", message: "insert failed: \(error.localizedDescription)")
            }
            if clip.hasAudio, let srcAudio = asset.tracks(withMediaType: .audio).first {
                if audioTrack == nil {
                    audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                }
                try? audioTrack?.insertTimeRange(clip.sourceRange, of: srcAudio, at: insertTime)
            }
            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: insertTime, duration: clip.sourceRange.duration)
            let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
            layerInstruction.setTransform(
                computeFillTransform(naturalSize: clip.naturalSize, preferredTransform: clip.transform, renderSize: renderSize),
                at: insertTime
            )
            instruction.layerInstructions = [layerInstruction]
            instructions.append(instruction)
            insertTime = CMTimeAdd(insertTime, clip.sourceRange.duration)
        }

        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
        videoComposition.instructions = instructions
        if let overlay = overlay {
            let parentLayer = CALayer()
            let videoLayer = CALayer()
            parentLayer.frame = CGRect(origin: .zero, size: renderSize)
            videoLayer.frame = CGRect(origin: .zero, size: renderSize)
            parentLayer.addSublayer(videoLayer)
            parentLayer.addSublayer(overlay)
            videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
                postProcessingAsVideoLayer: videoLayer,
                in: parentLayer
            )
        }

        try? FileManager.default.removeItem(at: outputURL)
        // Same preset rationale as the legacy path: 1920x1080 forces H.264
        // SDR — HighestQuality + animation tool on HEVC/HDR source hits
        // -11838. Segments must also be format-uniform for the passthrough
        // concat, which this preset guarantees.
        guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset1920x1080) else {
            throw FastComposeError(stage: "segment", message: "could not create export session")
        }
        session.outputURL = outputURL
        session.outputFileType = .mp4
        session.videoComposition = videoComposition
        session.shouldOptimizeForNetworkUse = false

        let sem = DispatchSemaphore(value: 0)
        session.exportAsynchronously { sem.signal() }
        sem.wait()
        guard session.status == .completed else {
            throw FastComposeError(stage: "segment", message: session.error?.localizedDescription ?? "status \(session.status.rawValue)")
        }
    }

    /// Concatenate the (format-uniform) segment files without re-encoding.
    private func fastPassthroughConcat(segmentURLs: [URL], outputURL: URL) throws -> CMTime {
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw FastComposeError(stage: "concat", message: "could not create video track")
        }
        var audioTrack: AVMutableCompositionTrack? = nil
        var insertTime = CMTime.zero
        for url in segmentURLs {
            let asset = AVURLAsset(url: url)
            guard let srcVideo = asset.tracks(withMediaType: .video).first else {
                throw FastComposeError(stage: "concat", message: "segment missing video track: \(url.lastPathComponent)")
            }
            let range = CMTimeRange(start: .zero, duration: asset.duration)
            do {
                try videoTrack.insertTimeRange(range, of: srcVideo, at: insertTime)
            } catch {
                throw FastComposeError(stage: "concat", message: "insert failed: \(error.localizedDescription)")
            }
            if let srcAudio = asset.tracks(withMediaType: .audio).first {
                if audioTrack == nil {
                    audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                }
                try? audioTrack?.insertTimeRange(range, of: srcAudio, at: insertTime)
            }
            insertTime = CMTimeAdd(insertTime, asset.duration)
        }

        try? FileManager.default.removeItem(at: outputURL)
        guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw FastComposeError(stage: "concat", message: "could not create passthrough session")
        }
        session.outputURL = outputURL
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        let sem = DispatchSemaphore(value: 0)
        session.exportAsynchronously { sem.signal() }
        sem.wait()
        guard session.status == .completed else {
            throw FastComposeError(stage: "concat", message: session.error?.localizedDescription ?? "status \(session.status.rawValue)")
        }
        return insertTime
    }

    /// Mix music under the reel audio WITHOUT re-encoding video: audio-only
    /// mixed export (M4A preset honors audioMix), then a passthrough mux of
    /// the untouched concat video + the mixed audio.
    private func fastMixMusic(concatURL: URL, musicURL: URL, totalDuration: CMTime, outputURL: URL) throws {
        let concatAsset = AVURLAsset(url: concatURL)
        let musicAsset = AVURLAsset(url: musicURL)

        let audioComp = AVMutableComposition()
        var clipAudioTrack: AVMutableCompositionTrack? = nil
        if let srcAudio = concatAsset.tracks(withMediaType: .audio).first {
            clipAudioTrack = audioComp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            try? clipAudioTrack?.insertTimeRange(
                CMTimeRange(start: .zero, duration: concatAsset.duration),
                of: srcAudio, at: .zero
            )
        }
        guard let srcMusic = musicAsset.tracks(withMediaType: .audio).first,
              let musicTrack = audioComp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw FastComposeError(stage: "music", message: "music track unavailable")
        }
        // Loop music to cover the full reel — same behavior as legacy.
        var musicInsert = CMTime.zero
        while CMTimeCompare(musicInsert, totalDuration) < 0 {
            let remaining = CMTimeSubtract(totalDuration, musicInsert)
            let insertDuration = CMTimeMinimum(musicAsset.duration, remaining)
            try? musicTrack.insertTimeRange(
                CMTimeRange(start: .zero, duration: insertDuration),
                of: srcMusic, at: musicInsert
            )
            musicInsert = CMTimeAdd(musicInsert, insertDuration)
        }
        // Same mix as legacy: clips 80%, music 30% with a 2s tail fade.
        let mix = AVMutableAudioMix()
        var params: [AVMutableAudioMixInputParameters] = []
        if let clipAudio = clipAudioTrack {
            let p = AVMutableAudioMixInputParameters(track: clipAudio)
            p.setVolume(0.8, at: .zero)
            params.append(p)
        }
        let mp = AVMutableAudioMixInputParameters(track: musicTrack)
        mp.setVolume(0.3, at: .zero)
        let fadeStart = CMTimeSubtract(totalDuration, CMTime(seconds: 2.0, preferredTimescale: 600))
        mp.setVolumeRamp(
            fromStartVolume: 0.3, toEndVolume: 0.0,
            timeRange: CMTimeRange(start: fadeStart, duration: CMTime(seconds: 2.0, preferredTimescale: 600))
        )
        params.append(mp)
        mix.inputParameters = params

        let mixedURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("reel_audio_\(UUID().uuidString).m4a")
        try? FileManager.default.removeItem(at: mixedURL)
        defer { try? FileManager.default.removeItem(at: mixedURL) }
        guard let audioSession = AVAssetExportSession(asset: audioComp, presetName: AVAssetExportPresetAppleM4A) else {
            throw FastComposeError(stage: "music", message: "could not create audio export session")
        }
        audioSession.outputURL = mixedURL
        audioSession.outputFileType = .m4a
        audioSession.audioMix = mix
        let semA = DispatchSemaphore(value: 0)
        audioSession.exportAsynchronously { semA.signal() }
        semA.wait()
        guard audioSession.status == .completed else {
            throw FastComposeError(stage: "music", message: audioSession.error?.localizedDescription ?? "audio mix failed")
        }

        let muxComp = AVMutableComposition()
        guard let vSrc = concatAsset.tracks(withMediaType: .video).first,
              let vDst = muxComp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw FastComposeError(stage: "mux", message: "video track unavailable")
        }
        do {
            try vDst.insertTimeRange(CMTimeRange(start: .zero, duration: concatAsset.duration), of: vSrc, at: .zero)
        } catch {
            throw FastComposeError(stage: "mux", message: error.localizedDescription)
        }
        let mixedAsset = AVURLAsset(url: mixedURL)
        if let aSrc = mixedAsset.tracks(withMediaType: .audio).first,
           let aDst = muxComp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            try? aDst.insertTimeRange(CMTimeRange(start: .zero, duration: mixedAsset.duration), of: aSrc, at: .zero)
        }
        try? FileManager.default.removeItem(at: outputURL)
        guard let muxSession = AVAssetExportSession(asset: muxComp, presetName: AVAssetExportPresetPassthrough) else {
            throw FastComposeError(stage: "mux", message: "could not create mux session")
        }
        muxSession.outputURL = outputURL
        muxSession.outputFileType = .mp4
        muxSession.shouldOptimizeForNetworkUse = true
        let semM = DispatchSemaphore(value: 0)
        muxSession.exportAsynchronously { semM.signal() }
        semM.wait()
        guard muxSession.status == .completed else {
            throw FastComposeError(stage: "mux", message: muxSession.error?.localizedDescription ?? "mux failed")
        }
    }

    /// Orchestrator. Throws on any failure — the caller falls back to the
    /// legacy single-session export, so this can never lose a reel.
    private func composeReelFast(
        clips: [[String: Any]],
        scorecard: ScorecardData?,
        musicUri: String?,
        promise: Promise,
        startTime: CFTimeInterval
    ) throws {
        let (parsed, renderSize) = try fastParseClips(clips)
        let segments = fastGroupSegments(parsed, scorecard: scorecard)
        print("[Clippar.Compose] FAST path: \(parsed.count) clips → \(segments.count) segments renderSize=\(renderSize)")
        sendEvent("onStitchProgress", [
            "phase": "composing", "current": 0, "total": clips.count, "percent": 10.0,
        ])

        let tmpDir = FileManager.default.temporaryDirectory
        let segmentURLs: [URL] = segments.indices.map {
            tmpDir.appendingPathComponent("reel_seg_\($0)_\(UUID().uuidString).mp4")
        }
        defer { segmentURLs.forEach { try? FileManager.default.removeItem(at: $0) } }

        // Export segments concurrently, 3 at a time. The per-frame cost is
        // the CoreAnimation overlay compositing; three sessions pipeline
        // decode/composite/encode across cores.
        let gate = DispatchSemaphore(value: 3)
        let group = DispatchGroup()
        let stateQueue = DispatchQueue(label: "clippar.fastcompose.state")
        var firstError: Error? = nil
        var completedSegments = 0

        for (i, segment) in segments.enumerated() {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                defer { group.leave() }
                gate.wait()
                defer { gate.signal() }
                if (stateQueue.sync { firstError != nil }) { return }
                autoreleasepool {
                    let overlay: CALayer?
                    if let sc = scorecard, let holeIndex = segment.holeIndex {
                        overlay = self.fastBuildHoleCard(sc: sc, index: holeIndex, renderSize: renderSize)
                    } else {
                        overlay = nil
                    }
                    do {
                        try self.fastExportSegment(
                            clips: segment.clips, overlay: overlay,
                            renderSize: renderSize, outputURL: segmentURLs[i]
                        )
                        stateQueue.sync {
                            completedSegments += 1
                            let pct = 10.0 + 75.0 * Double(completedSegments) / Double(segments.count)
                            self.sendEvent("onStitchProgress", [
                                "phase": "exporting",
                                "current": completedSegments,
                                "total": segments.count,
                                "percent": pct,
                            ])
                        }
                    } catch {
                        stateQueue.sync { if firstError == nil { firstError = error } }
                    }
                }
            }
        }
        group.wait()
        if let err = (stateQueue.sync { firstError }) { throw err }

        let concatURL = tmpDir.appendingPathComponent("reel_concat_\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: concatURL) }
        let totalDuration = try fastPassthroughConcat(segmentURLs: segmentURLs, outputURL: concatURL)
        sendEvent("onStitchProgress", [
            "phase": "exporting", "current": segments.count, "total": segments.count, "percent": 92.0,
        ])

        let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("reel_\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outputURL)

        var hasMusic = false
        if let musicUriStr = musicUri, !musicUriStr.isEmpty {
            let musicURL = resolveFileURL(musicUriStr)
            if FileManager.default.fileExists(atPath: musicURL.path) {
                try fastMixMusic(concatURL: concatURL, musicURL: musicURL, totalDuration: totalDuration, outputURL: outputURL)
                hasMusic = true
            }
        }
        if !hasMusic {
            do {
                try FileManager.default.moveItem(at: concatURL, to: outputURL)
            } catch {
                throw FastComposeError(stage: "finalize", message: error.localizedDescription)
            }
        }

        let elapsed = CACurrentMediaTime() - startTime
        let durationSec = CMTimeGetSeconds(totalDuration)
        print("[Clippar.Compose] FAST OK clips=\(parsed.count) segments=\(segments.count) durationSec=\(String(format: "%.1f", durationSec)) music=\(hasMusic) elapsedSec=\(String(format: "%.1f", elapsed)) out=\(outputURL.lastPathComponent)")
        sendEvent("onStitchProgress", [
            "phase": "exporting", "current": segments.count, "total": segments.count, "percent": 100.0,
        ])
        promise.resolve([
            "reelUri": outputURL.absoluteString,
            "durationMs": durationSec * 1000.0,
            "clipCount": parsed.count,
            "hasOverlay": scorecard != nil,
            "hasMusic": hasMusic,
        ] as [String: Any])
    }

    private func composeReelOnDevice(clips: [[String: Any]], scorecardJson: String, musicUri: String?, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            let startTime = CACurrentMediaTime()

            print("[Clippar.Compose] enter LOCAL composeReel — clips=\(clips.count) hasMusic=\(musicUri != nil)")

            guard !clips.isEmpty else {
                print("[Clippar.Compose] FAIL no clips")
                promise.reject(Exception(name: "ERR_NO_CLIPS", description: "No clips provided"))
                return
            }

            // Parse scorecard data
            var scorecard: ScorecardData?
            if let jsonData = scorecardJson.data(using: .utf8) {
                scorecard = try? JSONDecoder().decode(ScorecardData.self, from: jsonData)
            }

            // ---- FAST PATH ----
            // Segment-parallel export + passthrough concat (helpers above).
            // Falls back to the legacy single-session export below on ANY
            // error, so the fast path can never lose a reel.
            do {
                try self.composeReelFast(
                    clips: clips,
                    scorecard: scorecard,
                    musicUri: musicUri,
                    promise: promise,
                    startTime: startTime
                )
                return
            } catch {
                print("[Clippar.Compose] fast path failed — falling back to legacy single-session export. error=\(error)")
            }

            // Build the composition
            let composition = AVMutableComposition()
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                promise.reject(Exception(name: "ERR_COMPOSITION", description: "Could not create composition tracks"))
                return
            }
            // Audio track is created lazily only if at least one clip has audio
            // OR music is provided. An empty audio track in a composition causes
            // AVAssetExportSession to fail with AVErrorOperationNotSupportedForAsset
            // (-11838) when a custom AVVideoComposition is also set. CameraView
            // records `mute` by default so source clips have no audio.
            var audioTrack: AVMutableCompositionTrack? = nil


            var insertTime = CMTime.zero
            var renderSize = CGSize(width: 1080, height: 1920) // Default portrait 1080p
            var clipSegments: [ClipSegment] = []

            for (index, clipDict) in clips.enumerated() {
                guard let uri = clipDict["uri"] as? String else {
                    promise.reject(Exception(name: "ERR_INVALID_CLIP", description: "Clip \(index) missing uri"))
                    return
                }
                let fileURL = self.resolveFileURL(uri)
                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    promise.reject(Exception(name: "ERR_FILE_NOT_FOUND", description: "Clip \(index) not found: \(fileURL.path)"))
                    return
                }

                let asset = AVURLAsset(url: fileURL)
                let assetDuration = asset.duration

                // Compute the trim time range. trimStartMs / trimEndMs come from
                // the user's edits in the trim modal. trimEndMs == -1 (or
                // missing) means "use full clip from this start point".
                let trimStartMs = (clipDict["trimStartMs"] as? Double) ?? 0
                let rawTrimEndMs = (clipDict["trimEndMs"] as? Double) ?? -1
                let assetDurationMs = CMTimeGetSeconds(assetDuration) * 1000.0
                let effectiveStartMs = max(0, min(trimStartMs, assetDurationMs))
                let effectiveEndMs: Double = {
                    if rawTrimEndMs < 0 { return assetDurationMs }
                    return min(rawTrimEndMs, assetDurationMs)
                }()
                let trimDurationMs = max(0, effectiveEndMs - effectiveStartMs)
                if trimDurationMs <= 0 {
                    // Skip clips trimmed to zero length — would error in insertTimeRange
                    print("[ShotDetector] Skipping clip \(index): zero-length trim range")
                    continue
                }
                let trimStart = CMTime(seconds: effectiveStartMs / 1000.0, preferredTimescale: 600)
                let trimDuration = CMTime(seconds: trimDurationMs / 1000.0, preferredTimescale: 600)
                let sourceRange = CMTimeRange(start: trimStart, duration: trimDuration)

                if let assetVideoTrack = asset.tracks(withMediaType: .video).first {
                    do {
                        try videoTrack.insertTimeRange(
                            sourceRange,
                            of: assetVideoTrack,
                            at: insertTime
                        )
                        // Determine render size from the first clip
                        if index == 0 {
                            let size = assetVideoTrack.naturalSize
                            let transform = assetVideoTrack.preferredTransform
                            let isPortrait = abs(transform.b) == 1.0 && abs(transform.c) == 1.0
                            renderSize = isPortrait ? CGSize(width: size.height, height: size.width) : size
                        }
                        // Track each clip's segment info for per-clip transforms.
                        // The segment time range is in the COMPOSITION timeline
                        // (insertTime onwards), not the source asset timeline.
                        let clipTimeRange = CMTimeRange(start: insertTime, duration: trimDuration)
                        clipSegments.append(ClipSegment(
                            timeRange: clipTimeRange,
                            naturalSize: assetVideoTrack.naturalSize,
                            transform: assetVideoTrack.preferredTransform
                        ))
                    } catch {
                        promise.reject(Exception(name: "ERR_INSERT_VIDEO", description: "Failed inserting video \(index): \(error.localizedDescription)"))
                        return
                    }
                }

                if let assetAudioTrack = asset.tracks(withMediaType: .audio).first {
                    if audioTrack == nil {
                        audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                    }
                    try? audioTrack?.insertTimeRange(
                        sourceRange,
                        of: assetAudioTrack,
                        at: insertTime
                    )
                }

                insertTime = CMTimeAdd(insertTime, trimDuration)

                self.sendEvent("onStitchProgress", [
                    "phase": "composing",
                    "current": index + 1,
                    "total": clips.count,
                    "percent": Double(index + 1) / Double(clips.count) * 50.0,
                ])
            }

            let totalDuration = insertTime

            // ---- Scorecard overlay using AVVideoComposition + CALayer ----
            let parentLayer = CALayer()
            let videoLayer = CALayer()
            parentLayer.frame = CGRect(origin: .zero, size: renderSize)
            videoLayer.frame = CGRect(origin: .zero, size: renderSize)
            parentLayer.addSublayer(videoLayer)

            // Add persistent scorecard overlay with per-hole text updates
            if let sc = scorecard {
                let overlayContainer = CALayer()
                overlayContainer.frame = CGRect(origin: .zero, size: renderSize)

                // Match in-app preview scorecard (app/round/preview.tsx):
                //   row 1: course (left) + TOTAL N + score-to-par badge (right)
                //   row 2: hole strip (one cell per hole, current highlighted)
                //   row 3: Hole N (left) + Par M (center) + hole strokes (right)
                //
                // AVVideoCompositionCoreAnimationTool uses bottom-left origin
                // (Y goes up), so a top-anchored card means cardY = renderSize.height
                // - cardHeight - topPadding.
                let scale = UIScreen.main.scale
                let cardWidth: CGFloat = renderSize.width * 0.94
                let cardX: CGFloat = (renderSize.width - cardWidth) / 2
                let cardHeight: CGFloat = renderSize.height * 0.18
                let topPadding: CGFloat = renderSize.height * 0.04
                let cardY: CGFloat = renderSize.height - cardHeight - topPadding
                let inset: CGFloat = renderSize.width * 0.018
                let rowGap: CGFloat = cardHeight * 0.05

                // Three logical rows inside the card.
                let row1Height: CGFloat = cardHeight * 0.20
                let row2Height: CGFloat = cardHeight * 0.42
                let row3Height: CGFloat = cardHeight * 0.30
                let row1Y: CGFloat = cardY + cardHeight - row1Height - inset
                let row2Y: CGFloat = row1Y - row2Height - rowGap
                let row3Y: CGFloat = row2Y - row3Height - rowGap

                // Background card — more transparent so the video shows through
                let bgLayer = CALayer()
                bgLayer.frame = CGRect(x: cardX, y: cardY, width: cardWidth, height: cardHeight)
                bgLayer.backgroundColor = UIColor(white: 0, alpha: 0.45).cgColor
                bgLayer.cornerRadius = 18
                bgLayer.borderWidth = 1
                bgLayer.borderColor = UIColor(white: 1, alpha: 0.12).cgColor
                overlayContainer.addSublayer(bgLayer)

                // ------ Row 1: course + TOTAL ------
                let courseText = CATextLayer()
                courseText.string = sc.courseName
                courseText.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
                courseText.fontSize = renderSize.width * 0.022
                courseText.foregroundColor = UIColor(white: 1, alpha: 0.55).cgColor
                courseText.alignmentMode = .left
                courseText.truncationMode = .end
                courseText.contentsScale = scale
                courseText.frame = CGRect(
                    x: cardX + inset, y: row1Y,
                    width: cardWidth * 0.55, height: row1Height,
                )
                overlayContainer.addSublayer(courseText)

                // ------ Row 2: hole strip (always visible, current highlighted via per-hole layers below) ------
                let stripX = cardX + inset
                let stripWidth = cardWidth - inset * 2
                let cellWidth = stripWidth / CGFloat(max(1, sc.holes.count))
                // Pre-render each cell's static "background" container (hole# + par)
                // and create the score / highlight inside per-hole containers
                // so they can fade in with the right state.
                for (cellIdx, hole) in sc.holes.enumerated() {
                    let cellX = stripX + cellWidth * CGFloat(cellIdx)
                    // Static hole number (always dim until that hole is current)
                    let holeNumLayer = CATextLayer()
                    holeNumLayer.string = "\(hole.holeNumber)"
                    holeNumLayer.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
                    holeNumLayer.fontSize = renderSize.width * 0.018
                    holeNumLayer.foregroundColor = UIColor(white: 1, alpha: 0.4).cgColor
                    holeNumLayer.alignmentMode = .center
                    holeNumLayer.contentsScale = scale
                    holeNumLayer.frame = CGRect(
                        x: cellX, y: row2Y + row2Height * 0.65,
                        width: cellWidth, height: row2Height * 0.30,
                    )
                    overlayContainer.addSublayer(holeNumLayer)

                    // Static par
                    let parLabel = CATextLayer()
                    parLabel.string = "\(hole.par)"
                    parLabel.font = UIFont.systemFont(ofSize: 1, weight: .regular) as CTFont
                    parLabel.fontSize = renderSize.width * 0.014
                    parLabel.foregroundColor = UIColor(white: 1, alpha: 0.25).cgColor
                    parLabel.alignmentMode = .center
                    parLabel.contentsScale = scale
                    parLabel.frame = CGRect(
                        x: cellX, y: row2Y + row2Height * 0.05,
                        width: cellWidth, height: row2Height * 0.25,
                    )
                    overlayContainer.addSublayer(parLabel)
                }

                // Per-hole layers: TOTAL+badge (row 1 right), strip score reveal
                // for played holes, current-hole highlight, big hole/par/strokes (row 3).
                var runningScore = 0
                var runningPar = 0
                for (index, hole) in sc.holes.enumerated() {
                    let cumulativeScore = runningScore + hole.strokes
                    let cumulativePar = runningPar + hole.par
                    let cumulativeStp = cumulativeScore - cumulativePar

                    let holeContainer = CALayer()
                    holeContainer.frame = CGRect(origin: .zero, size: renderSize)
                    holeContainer.opacity = 0

                    let beginTime = hole.startMs / 1000.0
                    let holeDuration = (hole.endMs - hole.startMs) / 1000.0

                    let fadeIn = CABasicAnimation(keyPath: "opacity")
                    fadeIn.fromValue = 0
                    fadeIn.toValue = 1
                    fadeIn.beginTime = AVCoreAnimationBeginTimeAtZero + beginTime
                    fadeIn.duration = 0.15
                    fadeIn.fillMode = .forwards
                    fadeIn.isRemovedOnCompletion = false
                    holeContainer.add(fadeIn, forKey: "fadeIn")
                    if index < sc.holes.count - 1 {
                        let fadeOut = CABasicAnimation(keyPath: "opacity")
                        fadeOut.fromValue = 1
                        fadeOut.toValue = 0
                        fadeOut.beginTime = AVCoreAnimationBeginTimeAtZero + beginTime + holeDuration - 0.15
                        fadeOut.duration = 0.15
                        fadeOut.fillMode = .forwards
                        fadeOut.isRemovedOnCompletion = false
                        holeContainer.add(fadeOut, forKey: "fadeOut")
                    }

                    // Score-to-par color (used by TOTAL badge AND big strokes)
                    let stpColor: UIColor
                    if cumulativeStp < 0 {
                        stpColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
                    } else if cumulativeStp == 0 {
                        stpColor = UIColor.white
                    } else {
                        stpColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
                    }

                    // ---- Row 1 right: TOTAL X + STP badge ----
                    let totalLabel = CATextLayer()
                    totalLabel.string = "TOTAL"
                    totalLabel.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
                    totalLabel.fontSize = renderSize.width * 0.018
                    totalLabel.foregroundColor = UIColor(white: 1, alpha: 0.5).cgColor
                    totalLabel.alignmentMode = .right
                    totalLabel.contentsScale = scale
                    totalLabel.frame = CGRect(
                        x: cardX + cardWidth * 0.55, y: row1Y + row1Height * 0.15,
                        width: cardWidth * 0.18, height: row1Height * 0.7,
                    )
                    holeContainer.addSublayer(totalLabel)

                    let totalNumber = CATextLayer()
                    totalNumber.string = "\(cumulativeScore)"
                    totalNumber.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
                    totalNumber.fontSize = renderSize.width * 0.024
                    totalNumber.foregroundColor = UIColor.white.cgColor
                    totalNumber.alignmentMode = .right
                    totalNumber.contentsScale = scale
                    totalNumber.frame = CGRect(
                        x: cardX + cardWidth * 0.74, y: row1Y + row1Height * 0.10,
                        width: cardWidth * 0.10, height: row1Height * 0.85,
                    )
                    holeContainer.addSublayer(totalNumber)

                    // STP badge — pill-shaped background + signed number
                    let stpString: String
                    if cumulativeStp < 0 { stpString = "\(cumulativeStp)" }
                    else if cumulativeStp == 0 { stpString = "E" }
                    else { stpString = "+\(cumulativeStp)" }

                    let badgeWidth: CGFloat = cardWidth * 0.10
                    let badgeHeight: CGFloat = row1Height * 0.85
                    let badgeBG = CALayer()
                    badgeBG.frame = CGRect(
                        x: cardX + cardWidth - inset - badgeWidth, y: row1Y + row1Height * 0.075,
                        width: badgeWidth, height: badgeHeight,
                    )
                    badgeBG.backgroundColor = stpColor.withAlphaComponent(0.22).cgColor
                    badgeBG.cornerRadius = badgeHeight / 2
                    holeContainer.addSublayer(badgeBG)

                    let badgeText = CATextLayer()
                    badgeText.string = stpString
                    badgeText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
                    badgeText.fontSize = renderSize.width * 0.018
                    badgeText.foregroundColor = stpColor.cgColor
                    badgeText.alignmentMode = .center
                    badgeText.contentsScale = scale
                    badgeText.frame = CGRect(
                        x: badgeBG.frame.minX, y: badgeBG.frame.minY + badgeHeight * 0.18,
                        width: badgeWidth, height: badgeHeight * 0.7,
                    )
                    holeContainer.addSublayer(badgeText)

                    // ---- Row 2: scores already played show in their cells ----
                    for (cellIdx, h) in sc.holes.enumerated() {
                        let isPlayed = cellIdx <= index
                        let cellX = stripX + cellWidth * CGFloat(cellIdx)
                        let isCurrent = cellIdx == index
                        if isCurrent {
                            // Highlight cell
                            let highlight = CALayer()
                            highlight.frame = CGRect(
                                x: cellX + cellWidth * 0.06, y: row2Y,
                                width: cellWidth * 0.88, height: row2Height,
                            )
                            highlight.backgroundColor = UIColor(white: 1, alpha: 0.10).cgColor
                            highlight.cornerRadius = 8
                            holeContainer.addSublayer(highlight)
                        }
                        // Score for this cell (only if played)
                        let cellSTP = h.strokes - h.par
                        let cellColor: UIColor
                        if !isPlayed {
                            cellColor = UIColor(white: 1, alpha: 0.25)
                        } else if cellSTP < 0 {
                            cellColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
                        } else if cellSTP == 0 {
                            cellColor = UIColor.white
                        } else {
                            cellColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
                        }
                        let cellScore = CATextLayer()
                        cellScore.string = isPlayed ? "\(h.strokes)" : "-"
                        cellScore.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
                        cellScore.fontSize = renderSize.width * 0.022
                        cellScore.foregroundColor = cellColor.cgColor
                        cellScore.alignmentMode = .center
                        cellScore.contentsScale = scale
                        cellScore.frame = CGRect(
                            x: cellX, y: row2Y + row2Height * 0.30,
                            width: cellWidth, height: row2Height * 0.40,
                        )
                        holeContainer.addSublayer(cellScore)
                    }

                    // ---- Row 3: Hole N · Par M (left) ----
                    let holeBigText = CATextLayer()
                    holeBigText.string = "Hole \(hole.holeNumber)"
                    holeBigText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
                    holeBigText.fontSize = renderSize.width * 0.030
                    holeBigText.foregroundColor = UIColor.white.cgColor
                    holeBigText.alignmentMode = .left
                    holeBigText.contentsScale = scale
                    holeBigText.frame = CGRect(
                        x: cardX + inset, y: row3Y + row3Height * 0.10,
                        width: cardWidth * 0.30, height: row3Height * 0.85,
                    )
                    holeContainer.addSublayer(holeBigText)

                    let holeParBigText = CATextLayer()
                    holeParBigText.string = "Par \(hole.par)"
                    holeParBigText.font = UIFont.systemFont(ofSize: 1, weight: .medium) as CTFont
                    holeParBigText.fontSize = renderSize.width * 0.020
                    holeParBigText.foregroundColor = UIColor(white: 1, alpha: 0.5).cgColor
                    holeParBigText.alignmentMode = .left
                    holeParBigText.contentsScale = scale
                    holeParBigText.frame = CGRect(
                        x: cardX + cardWidth * 0.32, y: row3Y + row3Height * 0.20,
                        width: cardWidth * 0.20, height: row3Height * 0.7,
                    )
                    holeContainer.addSublayer(holeParBigText)

                    // Strokes (right)
                    let holeStpColor: UIColor
                    let holeStp = hole.strokes - hole.par
                    if holeStp < 0 {
                        holeStpColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
                    } else if holeStp == 0 {
                        holeStpColor = UIColor.white
                    } else {
                        holeStpColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
                    }
                    let holeStrokesText = CATextLayer()
                    holeStrokesText.string = "\(hole.strokes)"
                    holeStrokesText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
                    holeStrokesText.fontSize = renderSize.width * 0.034
                    holeStrokesText.foregroundColor = holeStpColor.cgColor
                    holeStrokesText.alignmentMode = .right
                    holeStrokesText.contentsScale = scale
                    holeStrokesText.frame = CGRect(
                        x: cardX + cardWidth * 0.6, y: row3Y + row3Height * 0.05,
                        width: cardWidth * 0.4 - inset, height: row3Height * 0.9,
                    )
                    holeContainer.addSublayer(holeStrokesText)

                    overlayContainer.addSublayer(holeContainer)
                    runningScore = cumulativeScore
                    runningPar = cumulativePar
                }

                // Fade entire card + course name in at start
                let overallFadeIn = CABasicAnimation(keyPath: "opacity")
                overallFadeIn.fromValue = 0
                overallFadeIn.toValue = 1
                overallFadeIn.beginTime = AVCoreAnimationBeginTimeAtZero
                overallFadeIn.duration = 0.5
                overallFadeIn.fillMode = .forwards
                overallFadeIn.isRemovedOnCompletion = false
                bgLayer.add(overallFadeIn, forKey: "bgFadeIn")
                courseText.add(overallFadeIn, forKey: "courseFadeIn")

                parentLayer.addSublayer(overlayContainer)
            }

            // Create video composition with overlay
            let videoComposition = AVMutableVideoComposition()
            videoComposition.renderSize = renderSize
            videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
            videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
                postProcessingAsVideoLayer: videoLayer,
                in: parentLayer
            )

            // Create per-clip instructions so each clip gets its own transform
            var instructions: [AVMutableVideoCompositionInstruction] = []
            for segment in clipSegments {
                let instruction = AVMutableVideoCompositionInstruction()
                instruction.timeRange = segment.timeRange

                let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
                let fillTransform = self.computeFillTransform(
                    naturalSize: segment.naturalSize,
                    preferredTransform: segment.transform,
                    renderSize: renderSize
                )
                layerInstruction.setTransform(fillTransform, at: segment.timeRange.start)
                instruction.layerInstructions = [layerInstruction]
                instructions.append(instruction)
            }
            videoComposition.instructions = instructions

            // ---- Background music mixing ----
            var audioMix: AVMutableAudioMix?
            if let musicUriStr = musicUri, !musicUriStr.isEmpty {
                let musicURL = self.resolveFileURL(musicUriStr)
                if FileManager.default.fileExists(atPath: musicURL.path) {
                    let musicAsset = AVURLAsset(url: musicURL)
                    if let musicAudioTrack = musicAsset.tracks(withMediaType: .audio).first {
                        if let musicTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                            // Loop music to cover full reel duration
                            var musicInsert = CMTime.zero
                            let musicDuration = musicAsset.duration
                            while CMTimeCompare(musicInsert, totalDuration) < 0 {
                                let remaining = CMTimeSubtract(totalDuration, musicInsert)
                                let insertDuration = CMTimeMinimum(musicDuration, remaining)
                                try? musicTrack.insertTimeRange(
                                    CMTimeRange(start: .zero, duration: insertDuration),
                                    of: musicAudioTrack,
                                    at: musicInsert
                                )
                                musicInsert = CMTimeAdd(musicInsert, insertDuration)
                            }

                            // Mix: clip audio at 80% volume (only if any clip
                            // had audio), music at 30%. audioTrack is nil when
                            // every source clip was muted (CameraView default).
                            let mix = AVMutableAudioMix()
                            var inputParams: [AVMutableAudioMixInputParameters] = []
                            if let clipAudio = audioTrack {
                                let clipAudioParam = AVMutableAudioMixInputParameters(track: clipAudio)
                                clipAudioParam.setVolume(0.8, at: .zero)
                                inputParams.append(clipAudioParam)
                            }
                            let musicAudioParam = AVMutableAudioMixInputParameters(track: musicTrack)
                            musicAudioParam.setVolume(0.3, at: .zero)
                            // Fade out music in last 2 seconds
                            let fadeStart = CMTimeSubtract(totalDuration, CMTime(seconds: 2.0, preferredTimescale: 600))
                            musicAudioParam.setVolumeRamp(fromStartVolume: 0.3, toEndVolume: 0.0, timeRange: CMTimeRange(start: fadeStart, duration: CMTime(seconds: 2.0, preferredTimescale: 600)))
                            inputParams.append(musicAudioParam)
                            mix.inputParameters = inputParams
                            audioMix = mix
                        }
                    }
                }
            }

            // ---- Export ----
            let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                .appendingPathComponent("reel_\(UUID().uuidString).mp4")
            try? FileManager.default.removeItem(at: outputURL)

            // Use size-specific preset (forces H.264 1080p SDR) instead of
            // HighestQuality. With a custom AVVideoComposition + Core Animation
            // overlay on HEVC/HDR/Dolby Vision source (iPhone default since
            // iOS 17+), HighestQuality returns AVErrorOperationNotSupportedForAsset
            // (-11838) at export time. 1920x1080 forces a known good codec
            // combo and matches the camera's recording resolution.
            guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset1920x1080) else {
                promise.reject(Exception(name: "ERR_EXPORT_SESSION", description: "Could not create export session for reel"))
                return
            }

            exportSession.outputURL = outputURL
            exportSession.outputFileType = .mp4
            exportSession.videoComposition = videoComposition
            if let mix = audioMix {
                exportSession.audioMix = mix
            }
            exportSession.shouldOptimizeForNetworkUse = true

            // Request a UIKit background task so iOS doesn't interrupt the
            // export with AVErrorOperationInterrupted (-11847) if the user
            // backgrounds the app mid-compose. iOS grants up to ~30s of
            // grace after backgrounding — long enough for a typical
            // 9-18 clip round at the 1080p preset.
            //
            // We call cancelExport() in the expiration handler so the
            // partial file gets cleaned up gracefully rather than left
            // half-written. The completion callback then fires with
            // status == .cancelled and the normal error handling below
            // surfaces it to JS — the editor can prompt the user to
            // re-run the compose when they come back.
            //
            // beginBackgroundTask is a UIApplication API and must be
            // invoked on the main thread; we sync-dispatch since we're
            // currently on a global queue.
            var bgTaskId: UIBackgroundTaskIdentifier = .invalid
            DispatchQueue.main.sync {
                bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "ClipparReelCompose") {
                    print("[Clippar.Compose] background task expiring — cancelling export")
                    exportSession.cancelExport()
                }
            }
            defer {
                if bgTaskId != .invalid {
                    DispatchQueue.main.async {
                        UIApplication.shared.endBackgroundTask(bgTaskId)
                    }
                }
            }

            let semaphore = DispatchSemaphore(value: 0)
            var exportError: Error?

            exportSession.exportAsynchronously {
                // Capture both .failed AND .cancelled as errors. .cancelled
                // happens when the bg-task expires; we want the JS layer
                // to know the compose didn't finish (rather than thinking
                // it succeeded with a partial file).
                if exportSession.status == .failed || exportSession.status == .cancelled {
                    exportError = exportSession.error ?? NSError(
                        domain: "ClipparExport",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "Export was cancelled (likely backgrounded too long)"]
                    )
                }
                semaphore.signal()
            }

            // Poll export progress instead of blocking wait
            while exportSession.status == .waiting || exportSession.status == .exporting {
                Thread.sleep(forTimeInterval: 0.5)
                let exportPercent = 50.0 + Double(exportSession.progress) * 50.0
                self.sendEvent("onStitchProgress", [
                    "phase": "exporting",
                    "current": clips.count,
                    "total": clips.count,
                    "percent": exportPercent,
                ])
            }

            semaphore.wait()

            if let error = exportError {
                let nsErr = error as NSError
                let underlying = (nsErr.userInfo[NSUnderlyingErrorKey] as? NSError).map { "code=\($0.code) domain=\($0.domain)" } ?? "none"
                print("[Clippar.Compose] FAIL exportSession.status=\(exportSession.status.rawValue) error=\(error.localizedDescription) code=\(nsErr.code) domain=\(nsErr.domain) underlying=\(underlying) userInfo=\(nsErr.userInfo)")
                print("[Clippar.Compose] context: clips=\(clips.count) totalDurationSec=\(CMTimeGetSeconds(totalDuration)) renderSize=\(renderSize) hasOverlay=\(scorecard != nil) hasMusic=\(musicUri != nil) videoCompositionInstructions=\(videoComposition.instructions.count)")
                // Clean up the partial output file if cancelled mid-write.
                try? FileManager.default.removeItem(at: outputURL)
                promise.reject(Exception(name: "ERR_COMPOSE_FAILED", description: "Reel compose failed: \(error.localizedDescription) (code \(nsErr.code))"))
                return
            }

            let elapsed = CACurrentMediaTime() - startTime
            let durationSec = CMTimeGetSeconds(totalDuration)
            print("[Clippar.Compose] OK clips=\(clips.count) durationSec=\(String(format: "%.1f", durationSec)) overlay=\(scorecard != nil) music=\(musicUri != nil) elapsedSec=\(String(format: "%.1f", elapsed)) out=\(outputURL.lastPathComponent)")

            promise.resolve([
                "reelUri": outputURL.absoluteString,
                "durationMs": durationSec * 1000.0,
                "clipCount": clips.count,
                "hasOverlay": scorecard != nil,
                "hasMusic": musicUri != nil,
            ] as [String: Any])
        }
    }

    // MARK: - Scorecard Overlay Layer Builder (legacy, no longer called)
    // Replaced by inline persistent scorecard in composeReelOnDevice.

    private func createScorecardOverlayLayer(
        hole: ScorecardHole,
        courseName: String,
        totalPar: Int,
        totalStrokes: Int,
        renderSize: CGSize
    ) -> CALayer {
        let container = CALayer()
        container.frame = CGRect(origin: .zero, size: renderSize)
        container.opacity = 0

        let beginTime = hole.startMs / 1000.0
        let holeDuration = (hole.endMs - hole.startMs) / 1000.0

        // Fade in at hole start
        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.beginTime = AVCoreAnimationBeginTimeAtZero + beginTime
        fadeIn.duration = 0.3
        fadeIn.fillMode = .forwards
        fadeIn.isRemovedOnCompletion = false
        container.add(fadeIn, forKey: "fadeIn")

        // Fade out at hole end
        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        fadeOut.beginTime = AVCoreAnimationBeginTimeAtZero + beginTime + holeDuration - 0.3
        fadeOut.duration = 0.3
        fadeOut.fillMode = .forwards
        fadeOut.isRemovedOnCompletion = false
        container.add(fadeOut, forKey: "fadeOut")

        // --- Card background at bottom ---
        let cardHeight: CGFloat = renderSize.height * 0.12
        let cardWidth: CGFloat = renderSize.width * 0.92
        let cardX: CGFloat = (renderSize.width - cardWidth) / 2
        let cardY: CGFloat = renderSize.height * 0.05 // CoreAnimation: 0 = bottom

        let bgLayer = CALayer()
        bgLayer.frame = CGRect(x: cardX, y: cardY, width: cardWidth, height: cardHeight)
        bgLayer.backgroundColor = UIColor(white: 0, alpha: 0.75).cgColor
        bgLayer.cornerRadius = 16
        bgLayer.borderWidth = 1
        bgLayer.borderColor = UIColor(white: 1, alpha: 0.1).cgColor
        container.addSublayer(bgLayer)

        let scale = UIScreen.main.scale
        let inset: CGFloat = 16

        // --- Top row: Course name + Running total ---
        let courseText = CATextLayer()
        courseText.string = courseName
        courseText.font = UIFont.systemFont(ofSize: 1, weight: .semibold) as CTFont
        courseText.fontSize = renderSize.width * 0.024
        courseText.foregroundColor = UIColor(white: 1, alpha: 0.5).cgColor
        courseText.alignmentMode = .left
        courseText.contentsScale = scale
        courseText.frame = CGRect(
            x: cardX + inset,
            y: cardY + cardHeight * 0.6,
            width: cardWidth * 0.5,
            height: cardHeight * 0.25
        )
        container.addSublayer(courseText)

        // Running total (right-aligned, top)
        // Running score = sum of all completed holes before this one
        let runningText = CATextLayer()
        runningText.string = "TOTAL  \(totalStrokes)"
        runningText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
        runningText.fontSize = renderSize.width * 0.026
        runningText.foregroundColor = UIColor.white.cgColor
        runningText.alignmentMode = .right
        runningText.contentsScale = scale
        runningText.frame = CGRect(
            x: cardX + cardWidth * 0.5,
            y: cardY + cardHeight * 0.6,
            width: cardWidth * 0.5 - inset,
            height: cardHeight * 0.25
        )
        container.addSublayer(runningText)

        // --- Bottom row: Hole X | Par Y | Score ---
        let holeText = CATextLayer()
        holeText.string = "Hole \(hole.holeNumber)"
        holeText.font = UIFont.systemFont(ofSize: 1, weight: .bold) as CTFont
        holeText.fontSize = renderSize.width * 0.038
        holeText.foregroundColor = UIColor.white.cgColor
        holeText.alignmentMode = .left
        holeText.contentsScale = scale
        holeText.frame = CGRect(
            x: cardX + inset,
            y: cardY + cardHeight * 0.15,
            width: cardWidth * 0.3,
            height: cardHeight * 0.35
        )
        container.addSublayer(holeText)

        let parText = CATextLayer()
        parText.string = "Par \(hole.par)"
        parText.font = UIFont.systemFont(ofSize: 1, weight: .medium) as CTFont
        parText.fontSize = renderSize.width * 0.03
        parText.foregroundColor = UIColor(white: 1, alpha: 0.6).cgColor
        parText.alignmentMode = .center
        parText.contentsScale = scale
        parText.frame = CGRect(
            x: cardX + cardWidth * 0.3,
            y: cardY + cardHeight * 0.18,
            width: cardWidth * 0.2,
            height: cardHeight * 0.3
        )
        container.addSublayer(parText)

        // Hole score with color coding
        let scoreToPar = hole.strokes - hole.par
        let scoreColor: UIColor
        if scoreToPar < 0 {
            scoreColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1) // Green
        } else if scoreToPar == 0 {
            scoreColor = UIColor.white
        } else {
            scoreColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1) // Red
        }

        let scoreText = CATextLayer()
        scoreText.string = "\(hole.strokes)"
        scoreText.font = UIFont.systemFont(ofSize: 1, weight: .heavy) as CTFont
        scoreText.fontSize = renderSize.width * 0.042
        scoreText.foregroundColor = scoreColor.cgColor
        scoreText.alignmentMode = .right
        scoreText.contentsScale = scale
        scoreText.frame = CGRect(
            x: cardX + cardWidth * 0.5,
            y: cardY + cardHeight * 0.15,
            width: cardWidth * 0.5 - inset,
            height: cardHeight * 0.35
        )
        container.addSublayer(scoreText)

        return container
    }

    // ============================================================================
    // MARK: - NEW: Strategy Dispatch + Detection Variants (additive, baseline-safe)
    // ============================================================================
    //
    // Everything below is ADDITIVE. The baseline functions (detectSwingEvent,
    // detectAudioTransients, extractPoseFrames, classifyShotType, fallbackClassify,
    // and the trim/export path) are NOT modified. All strategy variants compile
    // into one binary; config.detection.strategy (a JS string) picks the active
    // one at runtime via dispatchDetection's switch. The 'baseline'/'default'
    // cases call the unchanged detectSwingEvent.
    //
    // Critique fixes applied (see design JSON critiques):
    //   #1 ORIENTATION  — extractPoseFramesOriented() corrects coords via the
    //                     track preferredTransform + a sanity gate that disables
    //                     the gate (falls back to baseline) when coords look wrong.
    //   #2 FALSE-NEG    — on gate failure we fall back to the baseline impact for
    //                     the clip, never to clip-midpoint. ARC_MARGIN/MIN_ARC etc.
    //                     are tunable via DetectionOptions.
    //   #3 5fps CONTIN. — single dominant drop accepted; smoothing reconciled with
    //                     the velocity threshold (gate runs on RAW Y for velocity,
    //                     smoothed Y only for arc/peak).
    //   #4 DENSE PASS   — velocityPeak dense re-decode uses the SAME oriented
    //                     projection, re-derives shoulderY in-window, reads per-buffer
    //                     PTS and trims a widened window by PTS (GOP snapping).
    //   #5 AUDIO        — spectral flux + centroid + band ratios at the measurable
    //                     22050Hz/512 reality (no <=10ms attack clause); the snapped
    //                     onset must be the LARGEST in-window flux AND within ~50ms
    //                     of the velocityPeak wrist-speed estimate.
    //   #6 SELECTION    — prefer audio-confirmed episode, else max(arc*downVelMax);
    //                     'last' only as final tie-break. episodeCount logged.
    //   #7 DROPOUT      — wrist joint-count flips between adjacent frames mark that
    //                     velocity step invalid (skip for velocity/continuity).

    // MARK: New tunable options (parsed from optionsJson)

    /// All thresholds for the new strategies. Defaults match the design;
    /// every value is overridable from JS via `config.detection.options`
    /// (forwarded as the `optionsJson` arg). Unknown keys are ignored, missing
    /// keys keep the default — so an empty "{}" object uses pure defaults.
    private struct DetectionOptions {
        // --- Pose gate (aboveShoulderGate / velocityPeak / audioFused) ---
        // Wrists must clear the shoulder line by this ADDITIVE margin (Vision
        // bottom-origin space, oriented). NOT a fraction — see critique #1/#2.
        var arcMargin: CGFloat = 0.06
        // Minimum total vertical excursion address->peak.
        var minArc: CGFloat = 0.25
        // Minimum peak downward wrist speed per ~6-frame (~0.2s @5fps) step.
        var minDownVel: CGFloat = 0.06
        // Allowed upward reversal during the downswing before it's rejected.
        var maxReversal: CGFloat = 0.02
        // Episode selection policy: "audioElseScore" (default, critique #6),
        // "last", or "bestConfidence".
        var pickPolicy: String = "audioElseScore"
        // velocityPeak dense second pass — off for batch import to avoid
        // ~0.5s x 60-100 clips (the hook passes refine:false there).
        var refine: Bool = true
        var denseWindowMs: Double = 250.0

        // --- audioFused spectral analysis (22050Hz mono, 512-sample Hann, hop 128) ---
        var centroidFloorHz: Float = 1800.0   // wind gate: reject low-centroid (wind) onsets
        var lowBandRatioCeil: Float = 0.5      // wind gate: reject onsets dominated by <500Hz
        var highBandFloor: Float = 0.08        // require some 2-4kHz energy (sharp crack)
        var audioWindowMs: Double = 200.0      // half-width of pose downswing window
        var onsetMinSpacingMs: Double = 250.0  // adaptive peak-pick min spacing
        var fluxMedianMs: Double = 150.0       // sliding-median window for adaptive threshold
        var fluxDeltaScale: Float = 0.0        // extra delta above median (0 = median only)
        // Onset must agree with the velocityPeak wrist-speed time within this
        // tolerance (critique #5) so a coincident clap/cart-door cannot win.
        var audioPoseAgreeMs: Double = 50.0

        // --- Putt post-roll (read ONLY here, never edits baseline line ~306) ---
        // NOTE: under the baseline strategy the untouchable native line
        // `max(postRollMs, 4000)` pins putts at >=4000ms regardless of this.
        // This value is read only inside the new variants if ever needed; we
        // keep it for documentation parity and do not apply it (baseline trim
        // math is forbidden to edit). Putts staying long is satisfied by the
        // existing 4000 floor.
        var puttPostRollMs: Double = 4000.0

        init(json: String) {
            guard !json.isEmpty,
                  let data = json.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return
            }
            func f(_ k: String) -> Float? { (obj[k] as? NSNumber)?.floatValue }
            func d(_ k: String) -> Double? { (obj[k] as? NSNumber)?.doubleValue }
            func g(_ k: String) -> CGFloat? { (obj[k] as? NSNumber).map { CGFloat($0.doubleValue) } }
            func b(_ k: String) -> Bool? { obj[k] as? Bool }
            func s(_ k: String) -> String? { obj[k] as? String }

            if let v = g("arcMargin") { arcMargin = v }
            if let v = g("minArc") { minArc = v }
            if let v = g("minDownVel") { minDownVel = v }
            if let v = g("maxReversal") { maxReversal = v }
            if let v = s("pickPolicy") { pickPolicy = v }
            if let v = b("refine") { refine = v }
            if let v = d("denseWindowMs") { denseWindowMs = v }
            if let v = f("centroidFloorHz") { centroidFloorHz = v }
            if let v = f("lowBandRatioCeil") { lowBandRatioCeil = v }
            if let v = f("highBandFloor") { highBandFloor = v }
            if let v = d("audioWindowMs") { audioWindowMs = v }
            if let v = d("onsetMinSpacingMs") { onsetMinSpacingMs = v }
            if let v = d("fluxMedianMs") { fluxMedianMs = v }
            if let v = f("fluxDeltaScale") { fluxDeltaScale = v }
            if let v = d("audioPoseAgreeMs") { audioPoseAgreeMs = v }
            if let v = d("puttPostRollMs") { puttPostRollMs = v }
        }
    }

    // MARK: Harness diagnostics (critique #10 — honest A/B)

    /// Per-clip diagnostics emitted as OPTIONAL keys at all four resolve sites
    /// plus one machine-parseable `[ABHARNESS]` print line. All keys are optional
    /// in the JS contract, so an absent key never breaks an existing caller.
    private struct DetectionDiagnostics {
        var strategy: String
        var impactTimeMs: Double = 0.0
        var confidence: Double = 0.0
        var gatePassed: Bool = false        // a full-swing gate episode was chosen
        var episodeCount: Int = 0           // gated episodes found
        var poseFrameCount: Int = 0
        var hadAudioTrack: Bool = false     // clip has an audio track at all
        var hadAnyTransient: Bool = false   // baseline transients or spec-flux onsets existed
        var audioUsable: Bool = false       // a QUALIFYING onset existed in-window (denominator)
        var audioOnsetMatched: Bool = false // audio onset was actually snapped to
        var orientationOK: Bool = true      // oriented-pose sanity check passed
        var refinedDense: Bool = false      // velocityPeak dense pass actually ran

        init(strategy: String) { self.strategy = strategy }

        /// Add the OPTIONAL harness keys onto a resolve payload. The primary
        /// keys (found/impactTimeMs/trimStartMs/trimEndMs/confidence/shotType/
        /// trimmedUri) are left as-is — these are purely additive so an absent
        /// key never breaks an existing JS caller.
        func merge(into payload: inout [String: Any]) {
            payload["chosenStrategy"] = strategy
            payload["episodeCount"] = episodeCount
            payload["poseFrameCount"] = poseFrameCount
            payload["gatePassed"] = gatePassed
            payload["hadAudioTrack"] = hadAudioTrack
            payload["audioUsable"] = audioUsable
            payload["audioOnsetMatched"] = audioOnsetMatched
            // Whether ANY transient/onset existed (audio-usability denominator).
            payload["hadAnyTransient"] = hadAnyTransient
        }
    }

    private func logABHarness(_ d: DetectionDiagnostics) {
        let dict: [String: Any] = [
            "strategy": d.strategy,
            "impactMs": Int(d.impactTimeMs),
            "confidence": Double(round(100 * d.confidence) / 100),
            "gatePassed": d.gatePassed,
            "episodeCount": d.episodeCount,
            "poseFrames": d.poseFrameCount,
            "hadAudioTrack": d.hadAudioTrack,
            "hadAnyTransient": d.hadAnyTransient,
            "audioUsable": d.audioUsable,
            "audioOnsetMatched": d.audioOnsetMatched,
            "orientationOK": d.orientationOK,
            "refinedDense": d.refinedDense,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let json = String(data: data, encoding: .utf8) {
            print("[ABHARNESS] " + json)
        }
    }

    // MARK: Dispatch

    /// Runtime strategy switch. `baseline`/`default` call the UNCHANGED
    /// detectSwingEvent; new strategies call the additive variants. Any new
    /// variant that internally bails (orientation looks wrong, no gated swing)
    /// falls back to the baseline detectSwingEvent for that clip so behavior
    /// degrades gracefully and never dumps to clip-midpoint (critique #2).
    private func dispatchDetection(
        strategy: String,
        poseFrames: [PoseFrame],
        audioTransients: [Double],
        asset: AVURLAsset,
        recentShotTypes: [String],
        options: DetectionOptions,
        diag: inout DetectionDiagnostics
    ) -> SwingResult {
        let result: SwingResult
        switch strategy {
        case "aboveShoulderGate":
            result = detectSwing_aboveShoulderGate(
                poseFrames: poseFrames, audioTransients: audioTransients,
                asset: asset, recentShotTypes: recentShotTypes,
                options: options, diag: &diag)
        case "velocityPeak":
            result = detectSwing_velocityPeak(
                poseFrames: poseFrames, audioTransients: audioTransients,
                asset: asset, recentShotTypes: recentShotTypes,
                options: options, diag: &diag)
        case "audioFused":
            result = detectSwing_audioFused(
                poseFrames: poseFrames, audioTransients: audioTransients,
                asset: asset, recentShotTypes: recentShotTypes,
                options: options, diag: &diag)
        default:
            // "baseline" and anything unrecognized -> byte-for-byte baseline.
            result = detectSwingEvent(
                poseFrames: poseFrames, audioTransients: audioTransients,
                asset: asset, recentShotTypes: recentShotTypes)
        }
        diag.impactTimeMs = result.impactTimeMs
        diag.confidence = result.confidence
        return result
    }

    // MARK: Oriented pose source (critique #1)

    /// An oriented copy of pose data for the NEW absolute-magnitude gates.
    /// extractPoseFrames runs Vision with orientation:.up into a forced 480x640
    /// buffer and never applies preferredTransform, so its coords are rotated /
    /// aspect-squashed. The baseline tolerates that (it only uses relative
    /// ordering), but the new gates calibrate to absolute "above shoulder by
    /// margin" thresholds and would calibrate to garbage. This function
    /// re-extracts pose with the CORRECT CGImagePropertyOrientation derived from
    /// the track preferredTransform, in a buffer sized to the display aspect so
    /// the vertical axis is the true vertical. It does NOT modify extractPoseFrames.
    internal func extractPoseFramesOriented(from asset: AVURLAsset) throws -> [PoseFrame] {
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            throw NSError(domain: "ShotDetector", code: 1, userInfo: [NSLocalizedDescriptionKey: "No video track found"])
        }

        let transform = videoTrack.preferredTransform
        let orientation = cgOrientation(for: transform)

        // Display-correct aspect: apply the transform to natural size so the
        // buffer is sized to how the clip is shown (portrait stays portrait).
        let natural = videoTrack.naturalSize
        let displayRect = CGRect(origin: .zero, size: natural).applying(transform)
        let displayW = abs(displayRect.width)
        let displayH = abs(displayRect.height)
        // Long edge ~640 for Vision speed parity with baseline, preserving aspect.
        let targetLong: CGFloat = 640
        let aspect = (displayW > 0 && displayH > 0) ? (displayW / displayH) : (480.0 / 640.0)
        var bufW: Int
        var bufH: Int
        if aspect >= 1.0 {
            bufW = Int(targetLong)
            bufH = max(16, Int((targetLong / aspect).rounded()))
        } else {
            bufH = Int(targetLong)
            bufW = max(16, Int((targetLong * aspect).rounded()))
        }

        let fps = videoTrack.nominalFrameRate
        let frameStep = max(6, Int(fps / 5.0))

        let reader = try AVAssetReader(asset: asset)
        let outputSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: bufW,
            kCVPixelBufferHeightKey as String: bufH,
        ]
        let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
        trackOutput.alwaysCopiesSampleData = false
        reader.add(trackOutput)

        guard reader.startReading() else {
            throw NSError(domain: "ShotDetector", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to start reading video"])
        }

        var frames: [PoseFrame] = []
        var frameIndex = 0
        var readerDone = false
        while !readerDone {
            autoreleasepool {
                guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else {
                    readerDone = true
                    return
                }
                defer { frameIndex += 1 }
                guard frameIndex % frameStep == 0 else { return }

                let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                let timeMs = CMTimeGetSeconds(presentationTime) * 1000.0
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

                let poseRequest = VNDetectHumanBodyPoseRequest()
                // Correct orientation so Vision's normalized coords are upright.
                let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
                try? handler.perform([poseRequest])

                guard let observation = poseRequest.results?.first else {
                    frames.append(PoseFrame(
                        frameIndex: frameIndex, timeMs: timeMs,
                        leftWrist: nil, rightWrist: nil,
                        leftElbow: nil, rightElbow: nil,
                        leftShoulder: nil, rightShoulder: nil,
                        leftHip: nil, rightHip: nil,
                        nose: nil, confidence: 0))
                    return
                }
                frames.append(PoseFrame(
                    frameIndex: frameIndex, timeMs: timeMs,
                    leftWrist: self.safePoint(observation, .leftWrist),
                    rightWrist: self.safePoint(observation, .rightWrist),
                    leftElbow: self.safePoint(observation, .leftElbow),
                    rightElbow: self.safePoint(observation, .rightElbow),
                    leftShoulder: self.safePoint(observation, .leftShoulder),
                    rightShoulder: self.safePoint(observation, .rightShoulder),
                    leftHip: self.safePoint(observation, .leftHip),
                    rightHip: self.safePoint(observation, .rightHip),
                    nose: self.safePoint(observation, .nose),
                    confidence: observation.confidence))
            }
        }
        reader.cancelReading()
        return frames
    }

    /// Map a track preferredTransform to the CGImagePropertyOrientation that
    /// makes the decoded buffer upright for Vision. Mirrors the standard
    /// AVFoundation rotation cases (0/90/180/270).
    internal func cgOrientation(for t: CGAffineTransform) -> CGImagePropertyOrientation {
        if t.a == 1 && t.b == 0 && t.c == 0 && t.d == 1 { return .up }            // 0
        if t.a == 0 && t.b == 1 && t.c == -1 && t.d == 0 { return .right }        // 90 CW
        if t.a == -1 && t.b == 0 && t.c == 0 && t.d == -1 { return .down }        // 180
        if t.a == 0 && t.b == -1 && t.c == 1 && t.d == 0 { return .left }         // 270 CW
        return .up
    }

    /// Sanity check (critique #1): in an upright golfer the shoulders should sit
    /// ABOVE the hips (higher Y in Vision bottom-origin space) in a majority of
    /// frames. If they don't, coords look rotated/garbage and the absolute gate
    /// is unreliable — caller should fall back to baseline.
    private func orientationLooksUpright(_ frames: [PoseFrame]) -> Bool {
        var ok = 0
        var total = 0
        for f in frames {
            guard let s = avgShoulderY(f), let h = avgHipY(f) else { continue }
            total += 1
            if s > h { ok += 1 }
        }
        guard total >= 3 else { return false }
        return Double(ok) / Double(total) >= 0.6
    }

    // MARK: Gate primitives (episode model + dropout-aware velocity)

    /// A candidate full-swing episode found by the gate walk.
    private struct SwingEpisode {
        var addressIdx: Int
        var peakIdx: Int
        var impactIdx: Int
        var peakY: CGFloat            // max smoothed wrist Y during backswing
        var addressY: CGFloat         // smoothed wrist Y at address
        var shoulderYAtPeak: CGFloat
        var downVelMax: CGFloat       // max valid downward wrist speed (per step)
        var arc: CGFloat              // peakY - addressY
    }

    /// Centered 3-tap moving average — used only for arc/peak detection, NOT for
    /// velocity (critique #3: smoothing fights the velocity threshold, so the
    /// velocity clause reads RAW Y while arc/peak read smoothed Y).
    private func smooth3(_ v: [CGFloat]) -> [CGFloat] {
        guard v.count >= 3 else { return v }
        var out = v
        for i in 1..<(v.count - 1) {
            out[i] = (v[i - 1] + v[i] + v[i + 1]) / 3.0
        }
        return out
    }

    /// Per-frame wrist Y plus how many wrist joints contributed (1 or 2), so the
    /// gate can mark steps where the count flips as invalid (critique #7) — a
    /// 2-joint->1-joint switch injects a fake Y step that must not satisfy or
    /// fail the velocity / continuity clauses.
    private func wristYWithCount(_ f: PoseFrame) -> (y: CGFloat, count: Int)? {
        if let l = f.leftWrist, let r = f.rightWrist { return ((l.y + r.y) / 2.0, 2) }
        if let l = f.leftWrist { return (l.y, 1) }
        if let r = f.rightWrist { return (r.y, 1) }
        return nil
    }

    /// Core gate shared by aboveShoulderGate / velocityPeak / audioFused.
    /// Returns the gated episodes (may be empty) and the per-index arrays it
    /// computed, so velocityPeak can reuse the oriented coarse signal.
    private struct GateScan {
        var episodes: [SwingEpisode]
        var rawWristY: [CGFloat]
        var smoothWristY: [CGFloat]
        var shoulderY: [CGFloat]
        var wristCount: [Int]      // 0 = no wrist that frame
        var times: [Double]
        var validFrameIdx: [Int]   // poseFrames indices that had usable wrist+conf
    }

    private func scanGate(_ poseFrames: [PoseFrame], options: DetectionOptions) -> GateScan {
        // Build per-frame series over frames that have a usable wrist and
        // sufficient confidence. We keep parallel arrays indexed by a compacted
        // "valid frame" sequence so neighbor velocity is between real samples.
        var rawY: [CGFloat] = []
        var sY: [CGFloat] = []
        var wc: [Int] = []
        var ts: [Double] = []
        var srcIdx: [Int] = []
        for (i, f) in poseFrames.enumerated() {
            guard f.confidence > 0.3, let w = wristYWithCount(f) else { continue }
            rawY.append(w.y)
            wc.append(w.count)
            sY.append(avgShoulderY(f) ?? 0.55)
            ts.append(f.timeMs)
            srcIdx.append(i)
        }

        let smoothY = smooth3(rawY)
        var episodes: [SwingEpisode] = []

        let n = rawY.count
        guard n >= 4 else {
            return GateScan(episodes: episodes, rawWristY: rawY,
                            smoothWristY: smoothY, shoulderY: sY, wristCount: wc,
                            times: ts, validFrameIdx: srcIdx)
        }

        // Walk: find local minima (address candidates), the following max
        // (backswing peak), then the subsequent max-downward-speed frame (impact).
        var i = 1
        while i < n - 1 {
            // Address: a local low in smoothed wrist Y near/under shoulder line.
            let isAddress = smoothY[i] <= smoothY[i - 1] && smoothY[i] <= smoothY[i + 1]
            if !isAddress { i += 1; continue }
            let addressIdx = i
            let addressY = smoothY[i]

            // Rise to a peak.
            var j = i + 1
            var peakIdx = addressIdx
            var peakY = smoothY[addressIdx]
            while j < n {
                if smoothY[j] > peakY {
                    peakY = smoothY[j]
                    peakIdx = j
                }
                // Stop rising once we turn down meaningfully past the peak.
                if j > peakIdx && smoothY[j] < peakY - 0.02 { break }
                j += 1
            }
            if peakIdx <= addressIdx { i += 1; continue }

            // Downswing: find max valid downward speed after the peak, using RAW
            // Y and skipping steps where the wrist joint-count flips (critique #7).
            var impactIdx = peakIdx
            var downVelMax: CGFloat = 0
            var reversal: CGFloat = 0
            var k = peakIdx + 1
            while k < n {
                let stepValid = (wc[k] == wc[k - 1])
                let dy = rawY[k - 1] - rawY[k] // positive = wrist moving down
                if stepValid {
                    if dy > downVelMax {
                        downVelMax = dy
                        impactIdx = k
                    }
                    if dy < 0 { reversal = max(reversal, -dy) } // upward move magnitude
                }
                // End downswing window when wrists settle near/under shoulder for a beat.
                if rawY[k] < sY[k] && k > impactIdx + 1 { break }
                if k - peakIdx > 6 { break } // downswing is fast — bound the search
                k += 1
            }

            // ---- FULL-SWING GATE ----
            let shoulderAtPeak = sY[peakIdx]
            let clearedShoulder = peakY > shoulderAtPeak + options.arcMargin   // (a)
            let arc = peakY - addressY
            let enoughArc = arc > options.minArc                               // (b)
            // (c) continuity: accept a single dominant drop OR >=2 decreasing
            // samples; reject a large upward reversal mid-downswing.
            let noBadReversal = reversal <= options.maxReversal
            // (d) min downward velocity.
            let fastEnough = downVelMax > options.minDownVel
            // (e) commitment: address existed before AND wrist falls back through
            // the address zone by impact (rejects a follow-through-only motion).
            let returnedDown = impactIdx > peakIdx && rawY[impactIdx] <= addressY + options.arcMargin

            if clearedShoulder && enoughArc && noBadReversal && fastEnough && returnedDown {
                episodes.append(SwingEpisode(
                    addressIdx: addressIdx, peakIdx: peakIdx, impactIdx: impactIdx,
                    peakY: peakY, addressY: addressY, shoulderYAtPeak: shoulderAtPeak,
                    downVelMax: downVelMax, arc: arc))
                // Continue scanning AFTER this impact to collect later episodes.
                i = max(impactIdx, addressIdx + 1)
            } else {
                i = addressIdx + 1
            }
        }

        return GateScan(episodes: episodes, rawWristY: rawY,
                        smoothWristY: smoothY, shoulderY: sY, wristCount: wc,
                        times: ts, validFrameIdx: srcIdx)
    }

    /// Decisive-episode selection (critique #6): prefer the episode with audio
    /// confirmation (if audioTimes provided), else max(arc*downVelMax); 'last'
    /// only as a final tie-break. Honors options.pickPolicy overrides.
    private func selectEpisode(
        _ episodes: [SwingEpisode],
        scan: GateScan,
        audioTimes: [Double],
        options: DetectionOptions
    ) -> SwingEpisode? {
        guard !episodes.isEmpty else { return nil }
        if episodes.count == 1 { return episodes[0] }

        switch options.pickPolicy {
        case "last":
            return episodes.max(by: { $0.impactIdx < $1.impactIdx })
        case "bestConfidence":
            return episodes.max(by: { ($0.arc * $0.downVelMax) < ($1.arc * $1.downVelMax) })
        default: // "audioElseScore"
            // (i) audio-confirmed: an audio onset within audioWindow of the
            //     episode's impact time.
            if !audioTimes.isEmpty {
                let confirmed = episodes.filter { ep in
                    let t = scan.times[ep.impactIdx]
                    return audioTimes.contains { abs($0 - t) < options.audioWindowMs }
                }
                if !confirmed.isEmpty {
                    return confirmed.max(by: { ($0.arc * $0.downVelMax) < ($1.arc * $1.downVelMax) })
                }
            }
            // (ii) else max score; (iii) 'last' tie-break via impactIdx.
            return episodes.max(by: {
                let s0 = $0.arc * $0.downVelMax
                let s1 = $1.arc * $1.downVelMax
                if abs(s0 - s1) < 1e-6 { return $0.impactIdx < $1.impactIdx }
                return s0 < s1
            })
        }
    }

    /// Build a SwingResult from a chosen episode, reusing the baseline classifier
    /// + confidence shape. Maps the compacted episode index back to the original
    /// poseFrames index so classifyShotType gets the right frame window.
    private func resultFromEpisode(
        _ ep: SwingEpisode,
        scan: GateScan,
        poseFrames: [PoseFrame],
        audioTransients: [Double],
        impactTimeMsOverride: Double?,
        asset: AVURLAsset,
        recentShotTypes: [String]
    ) -> SwingResult {
        let impactTimeMs = impactTimeMsOverride ?? scan.times[ep.impactIdx]
        let srcImpactIdx = scan.validFrameIdx[ep.impactIdx]

        var confidence = 0.6
        if ep.arc > 0.2 { confidence += 0.1 }
        if ep.arc > 0.35 { confidence += 0.1 }
        confidence += 0.05 // a real address->peak->impact episode passed the gate
        if audioTransients.contains(where: { abs($0 - impactTimeMs) < 200.0 }) { confidence += 0.2 }
        let srcImpactFrame = poseFrames[min(srcImpactIdx, poseFrames.count - 1)]
        if srcImpactFrame.confidence > 0.6 { confidence += 0.05 }
        confidence = min(1.0, confidence)

        let sceneSignal = self.sceneGreenSignal(from: asset)
        let shotType = classifyShotType(
            poseFrames: poseFrames,
            impactFrameIndex: srcImpactIdx,
            backswingPeakY: ep.peakY,
            audioTransients: audioTransients,
            impactTimeMs: impactTimeMs,
            sceneSignal: sceneSignal,
            recentShotTypes: recentShotTypes)

        return SwingResult(
            found: true,
            impactTimeMs: impactTimeMs,
            impactFrameIndex: srcImpactFrame.frameIndex,
            confidence: confidence,
            shotType: shotType)
    }

    // MARK: Strategy — aboveShoulderGate

    /// Pure-pose, wind-immune waggle fix. On orientation failure OR no gated
    /// episode, falls back to the baseline detectSwingEvent (critique #1/#2 —
    /// never clip-midpoint).
    private func detectSwing_aboveShoulderGate(
        poseFrames: [PoseFrame],
        audioTransients: [Double],
        asset: AVURLAsset,
        recentShotTypes: [String],
        options: DetectionOptions,
        diag: inout DetectionDiagnostics
    ) -> SwingResult {
        // Need enough pose data; otherwise baseline handles the fallback path.
        guard poseFrames.count >= 5 else {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        // Use an ORIENTED pose source for the absolute gate. If re-extraction
        // fails, fall back to the baseline frames (relative ordering still works
        // for baseline, but our absolute gate needs upright coords — so we also
        // run the sanity check below).
        let orientedFrames = (try? extractPoseFramesOriented(from: asset)) ?? poseFrames
        let upright = orientationLooksUpright(orientedFrames)
        diag.orientationOK = upright
        if !upright {
            print("[ABGATE] orientation looks rotated — disabling gate, using baseline")
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        let scan = scanGate(orientedFrames, options: options)
        diag.episodeCount = scan.episodes.count
        guard let ep = selectEpisode(scan.episodes, scan: scan, audioTimes: audioTransients, options: options) else {
            print("[ABGATE] no gated episode — baseline fallback (episodes=\(scan.episodes.count))")
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        diag.gatePassed = true
        // classifyShotType expects indices into the ORIENTED frames here (the
        // window it samples is relative, and oriented frames share the same
        // frameStep cadence as baseline). We pass orientedFrames consistently.
        let result = resultFromEpisode(ep, scan: scan, poseFrames: orientedFrames,
                                       audioTransients: audioTransients,
                                       impactTimeMsOverride: nil,
                                       asset: asset, recentShotTypes: recentShotTypes)
        print("[ABGATE] gated impact ms=\(Int(result.impactTimeMs)) arc=\(String(format: "%.2f", ep.arc)) downVel=\(String(format: "%.3f", ep.downVelMax)) episodes=\(scan.episodes.count)")
        return result
    }

    // MARK: Strategy — velocityPeak (dense sub-frame refinement)

    /// aboveShoulderGate + a dense ~30fps re-decode in a +/-denseWindow around
    /// the coarse impact, in the SAME oriented projection, re-deriving shoulderY
    /// in-window (critique #4). Parabolic sub-frame interp only when the dense
    /// samples are too few; otherwise the dense-pass peak time is used directly.
    private func detectSwing_velocityPeak(
        poseFrames: [PoseFrame],
        audioTransients: [Double],
        asset: AVURLAsset,
        recentShotTypes: [String],
        options: DetectionOptions,
        diag: inout DetectionDiagnostics
    ) -> SwingResult {
        guard poseFrames.count >= 5 else {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        let orientedFrames = (try? extractPoseFramesOriented(from: asset)) ?? poseFrames
        let upright = orientationLooksUpright(orientedFrames)
        diag.orientationOK = upright
        if !upright {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        let scan = scanGate(orientedFrames, options: options)
        diag.episodeCount = scan.episodes.count
        guard let ep = selectEpisode(scan.episodes, scan: scan, audioTimes: audioTransients, options: options) else {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }
        diag.gatePassed = true

        // Coarse impact time + a coarse parabolic refine on the velocity series.
        let coarseImpactMs = scan.times[ep.impactIdx]
        var refinedMs = coarseImpactMs

        // Coarse parabolic interp on raw downward-speed v[i]=rawY[i-1]-rawY[i].
        // 3-point peak interp on (v[k-1], v[k], v[k+1]) of the speed series.
        // GUARDED (critique #4): clamp the vertex and only apply when the
        // denominator is non-degenerate — at ~5fps a coarse peak is often a
        // near-impulse, so this is a small nudge and the dense pass below is the
        // real precision win.
        let k = ep.impactIdx
        if k >= 2 && k + 1 < scan.rawWristY.count {
            let vA = scan.rawWristY[k - 2] - scan.rawWristY[k - 1]
            let vB = scan.rawWristY[k - 1] - scan.rawWristY[k]
            let vC = scan.rawWristY[k] - scan.rawWristY[k + 1]
            let denom = vA - 2 * vB + vC
            if abs(denom) > 1e-4 {
                var delta = 0.5 * (vA - vC) / denom
                delta = max(-0.5, min(0.5, delta)) // guard near-impulse saturation
                let t0 = scan.times[k]
                let t1 = scan.times[k + 1]
                refinedMs = t0 + Double(delta) * (t1 - t0)
            }
        }

        // Dense second pass (critique #4): re-decode a widened window, re-derive
        // shoulderY in-window, find the true wrist-speed peak. Off for batch
        // import via options.refine=false.
        if options.refine {
            if let dense = denseRefineImpact(asset: asset, aroundMs: coarseImpactMs, options: options) {
                refinedMs = dense
                diag.refinedDense = true
                print("[VELPEAK] dense refine ms=\(Int(dense)) (coarse=\(Int(coarseImpactMs)))")
            } else {
                print("[VELPEAK] dense refine unavailable — using coarse/parabolic ms=\(Int(refinedMs))")
            }
        }

        let result = resultFromEpisode(ep, scan: scan, poseFrames: orientedFrames,
                                       audioTransients: audioTransients,
                                       impactTimeMsOverride: refinedMs,
                                       asset: asset, recentShotTypes: recentShotTypes)
        return result
    }

    /// Dense ~full-rate re-decode of a +/-denseWindow window around `aroundMs`,
    /// in the SAME oriented projection as the coarse pass. Reads per-buffer PTS
    /// and requests a WIDER reader.timeRange to absorb GOP/sync-sample snapping,
    /// then trims by PTS. Re-derives shoulderY in-window. Returns the refined
    /// impact time in ms, or nil if too few samples (caller keeps coarse).
    private func denseRefineImpact(asset: AVURLAsset, aroundMs: Double, options: DetectionOptions) -> Double? {
        guard let videoTrack = asset.tracks(withMediaType: .video).first else { return nil }
        let transform = videoTrack.preferredTransform
        let orientation = cgOrientation(for: transform)

        let natural = videoTrack.naturalSize
        let displayRect = CGRect(origin: .zero, size: natural).applying(transform)
        let displayW = abs(displayRect.width)
        let displayH = abs(displayRect.height)
        let targetLong: CGFloat = 640
        let aspect = (displayW > 0 && displayH > 0) ? (displayW / displayH) : (480.0 / 640.0)
        var bufW: Int; var bufH: Int
        if aspect >= 1.0 { bufW = Int(targetLong); bufH = max(16, Int((targetLong / aspect).rounded())) }
        else { bufH = Int(targetLong); bufW = max(16, Int((targetLong * aspect).rounded())) }

        let halfMs = options.denseWindowMs
        // Widen the request by ~300ms each side for GOP snapping; trim by PTS.
        let padMs = 300.0
        let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0
        let reqStartMs = max(0.0, aroundMs - halfMs - padMs)
        let reqEndMs = min(durationMs, aroundMs + halfMs + padMs)
        guard reqEndMs > reqStartMs else { return nil }

        var refined: Double? = nil
        autoreleasepool {
            guard let reader = try? AVAssetReader(asset: asset) else { return }
            let outputSettings: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: bufW,
                kCVPixelBufferHeightKey as String: bufH,
            ]
            let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
            trackOutput.alwaysCopiesSampleData = false
            reader.add(trackOutput)
            reader.timeRange = CMTimeRange(
                start: CMTime(seconds: reqStartMs / 1000.0, preferredTimescale: 600),
                duration: CMTime(seconds: (reqEndMs - reqStartMs) / 1000.0, preferredTimescale: 600))
            guard reader.startReading() else { return }

            // Decode every frame in-window (no frame skipping — dense).
            var denseY: [CGFloat] = []
            var denseW: [Int] = []
            var denseS: [CGFloat] = []
            var denseT: [Double] = []
            var done = false
            while !done {
                autoreleasepool {
                    guard let sb = trackOutput.copyNextSampleBuffer() else { done = true; return }
                    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
                    let tMs = CMTimeGetSeconds(pts) * 1000.0
                    // Trim by PTS to the actual +/-halfMs window.
                    guard tMs >= aroundMs - halfMs && tMs <= aroundMs + halfMs else { return }
                    guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
                    let req = VNDetectHumanBodyPoseRequest()
                    let handler = VNImageRequestHandler(cvPixelBuffer: pb, orientation: orientation, options: [:])
                    try? handler.perform([req])
                    guard let obs = req.results?.first, obs.confidence > 0.3 else { return }
                    let f = PoseFrame(
                        frameIndex: 0, timeMs: tMs,
                        leftWrist: self.safePoint(obs, .leftWrist),
                        rightWrist: self.safePoint(obs, .rightWrist),
                        leftElbow: nil, rightElbow: nil,
                        leftShoulder: self.safePoint(obs, .leftShoulder),
                        rightShoulder: self.safePoint(obs, .rightShoulder),
                        leftHip: nil, rightHip: nil, nose: nil,
                        confidence: obs.confidence)
                    guard let w = self.wristYWithCount(f) else { return }
                    denseY.append(w.y)
                    denseW.append(w.count)
                    denseS.append(self.avgShoulderY(f) ?? 0.55) // re-derived in-window
                    denseT.append(tMs)
                }
            }
            reader.cancelReading()

            // Need enough dense samples to beat the coarse estimate.
            guard denseY.count >= 4 else { return }

            // Max valid downward speed (skip joint-count flips, critique #7).
            // shoulderY is RE-DERIVED in-window (denseS) and used to bias the
            // search toward the downswing region (wrist at/below shoulder line),
            // keeping the dense pass commensurate with the coarse gate (critique
            // #4) rather than picking a backswing-side velocity spike.
            var peakK = 1
            var peakV: CGFloat = -.greatestFiniteMagnitude
            for k in 1..<denseY.count {
                guard denseW[k] == denseW[k - 1] else { continue }
                let dy = denseY[k - 1] - denseY[k]
                // Down-region weighting: full weight near/below the shoulder line.
                let belowShoulder = denseY[k] <= denseS[k] + 0.05
                let weighted = belowShoulder ? dy : dy * 0.5
                if weighted > peakV { peakV = weighted; peakK = k }
            }

            // Parabolic sub-frame interp on the dense speed series; prefer the
            // dense peak time when too few neighbors (critique #4 guard).
            var outMs = denseT[peakK]
            if peakK >= 2 && peakK + 1 < denseY.count {
                let vA = denseY[peakK - 2] - denseY[peakK - 1]
                let vB = denseY[peakK - 1] - denseY[peakK]
                let vC = denseY[peakK] - denseY[peakK + 1]
                let denom = vA - 2 * vB + vC
                if abs(denom) > 1e-4 {
                    var delta = 0.5 * (vA - vC) / denom
                    delta = max(-0.5, min(0.5, delta))
                    let t0 = denseT[peakK]
                    let t1 = denseT[min(peakK + 1, denseT.count - 1)]
                    outMs = t0 + Double(delta) * (t1 - t0)
                }
            }
            refined = outMs
        }
        return refined
    }

    // MARK: Strategy — audioFused (spectral snap onto the pose gate)

    /// Pose gate decides; audio only refines timing inside the validated window.
    /// The snapped onset must be the LARGEST in-window flux onset AND agree with
    /// the velocityPeak wrist-speed estimate within options.audioPoseAgreeMs
    /// (critique #5). On no qualifying onset, keep pose timing, audioOnsetMatched
    /// = false (critique #5/#10). On orientation failure / no gate, baseline.
    private func detectSwing_audioFused(
        poseFrames: [PoseFrame],
        audioTransients: [Double],
        asset: AVURLAsset,
        recentShotTypes: [String],
        options: DetectionOptions,
        diag: inout DetectionDiagnostics
    ) -> SwingResult {
        guard poseFrames.count >= 5 else {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        let orientedFrames = (try? extractPoseFramesOriented(from: asset)) ?? poseFrames
        let upright = orientationLooksUpright(orientedFrames)
        diag.orientationOK = upright
        if !upright {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }

        let scan = scanGate(orientedFrames, options: options)
        diag.episodeCount = scan.episodes.count
        guard let ep = selectEpisode(scan.episodes, scan: scan, audioTimes: audioTransients, options: options) else {
            return detectSwingEvent(poseFrames: poseFrames, audioTransients: audioTransients,
                                    asset: asset, recentShotTypes: recentShotTypes)
        }
        diag.gatePassed = true

        // Derive a precise pose impact via the dense pass (critique #5: window
        // centered on the ms-scale estimate, not the coarse 5fps impact).
        let coarseImpactMs = scan.times[ep.impactIdx]
        let poseImpactMs = denseRefineImpact(asset: asset, aroundMs: coarseImpactMs, options: options) ?? coarseImpactMs
        if poseImpactMs != coarseImpactMs { diag.refinedDense = true }

        // Spectral onsets across the whole clip (new analyzer, baseline untouched).
        let onsets = (try? detectAudioOnsets_specFlux(from: asset, options: options)) ?? []
        diag.hadAnyTransient = diag.hadAnyTransient || !onsets.isEmpty

        // Qualifying onsets = passed wind/sharpness gate AND inside the pose window.
        let lo = poseImpactMs - options.audioWindowMs
        let hi = poseImpactMs + options.audioWindowMs
        let inWindow = onsets.filter { $0.passedGate && $0.timeMs >= lo && $0.timeMs <= hi }
        diag.audioUsable = !inWindow.isEmpty

        var impactMs = poseImpactMs
        if !inWindow.isEmpty {
            // LARGEST in-window flux onset (critique #5).
            if let best = inWindow.max(by: { ($0.flux * $0.highBandRatio) < ($1.flux * $1.highBandRatio) }) {
                // Must agree with the wrist-speed (pose) estimate.
                if abs(best.timeMs - poseImpactMs) <= options.audioPoseAgreeMs {
                    impactMs = best.timeMs
                    diag.audioOnsetMatched = true
                    print("[AUDIOFUSED] snap onset ms=\(Int(best.timeMs)) flux=\(String(format: "%.2f", best.flux)) centroid=\(Int(best.centroidHz)) HBR=\(String(format: "%.2f", best.highBandRatio))")
                } else {
                    print("[AUDIOFUSED] in-window onset disagrees with pose (onset=\(Int(best.timeMs)) pose=\(Int(poseImpactMs))) — keeping pose")
                }
            }
        } else {
            print("[AUDIOFUSED] no qualifying onset in window — keeping pose ms=\(Int(poseImpactMs))")
        }

        var result = resultFromEpisode(ep, scan: scan, poseFrames: orientedFrames,
                                       audioTransients: audioTransients,
                                       impactTimeMsOverride: impactMs,
                                       asset: asset, recentShotTypes: recentShotTypes)
        // Confidence: boost on a confirmed audio snap, soften slightly on mismatch.
        if diag.audioOnsetMatched {
            result = SwingResult(found: result.found, impactTimeMs: result.impactTimeMs,
                                 impactFrameIndex: result.impactFrameIndex,
                                 confidence: min(1.0, result.confidence + 0.1),
                                 shotType: result.shotType)
        } else if diag.audioUsable {
            result = SwingResult(found: result.found, impactTimeMs: result.impactTimeMs,
                                 impactFrameIndex: result.impactFrameIndex,
                                 confidence: max(0.0, result.confidence - 0.05),
                                 shotType: result.shotType)
        }
        diag.confidence = result.confidence
        return result
    }

    // MARK: New spectral onset analyzer (vDSP FFT) — additive, NOT detectAudioTransients

    /// A single detected audio onset with the features the wind/sharpness gate
    /// needs. `passedGate` = cleared the wind (centroid/low-band) + sharpness
    /// (high-band) gates.
    private struct AudioOnset {
        let timeMs: Double
        let flux: Float
        let centroidHz: Float
        let lowBandRatio: Float   // energy <500Hz / total
        let highBandRatio: Float  // energy 2-4kHz / total
        let passedGate: Bool
    }

    /// Spectral-flux onset detection with a wind/sharpness gate (critique #5).
    ///
    /// Bin math (22050Hz mono, 512-sample frame): bin spacing = 22050/512 ≈
    /// 43.07 Hz; <500Hz ≈ bins 1..11; 2-4kHz ≈ bins 47..93; Nyquist 11025Hz.
    /// A 512-sample frame integrates ~23ms, so the sub-10ms impulse-attack clause
    /// from the original research is UNMEASURABLE here and is intentionally
    /// dropped — we rely on flux + centroid wind-gate + high-band sharpness +
    /// the pose-window cross-validation done by the caller. Hop 128 ≈ 5.8ms
    /// gives ms-scale onset timing.
    ///
    /// Reuses ONE vDSP FFT setup for the whole clip (autoreleasepool discipline
    /// matching the baseline). Does NOT touch detectAudioTransients.
    private func detectAudioOnsets_specFlux(from asset: AVURLAsset, options: DetectionOptions) throws -> [AudioOnset] {
        guard let audioTrack = asset.tracks(withMediaType: .audio).first else { return [] }

        let reader = try AVAssetReader(asset: asset)
        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVSampleRateKey: 22050,
            AVNumberOfChannelsKey: 1,
        ]
        let trackOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        reader.add(trackOutput)
        guard reader.startReading() else { return [] }

        var allSamples: [Int16] = []
        var done = false
        while !done {
            autoreleasepool {
                guard let sb = trackOutput.copyNextSampleBuffer() else { done = true; return }
                guard let bb = CMSampleBufferGetDataBuffer(sb) else { return }
                let length = CMBlockBufferGetDataLength(bb)
                var data = Data(count: length)
                data.withUnsafeMutableBytes { raw in
                    if let base = raw.baseAddress {
                        CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: length, destination: base)
                    }
                }
                let count = length / MemoryLayout<Int16>.size
                data.withUnsafeBytes { raw in
                    if let p = raw.bindMemory(to: Int16.self).baseAddress {
                        allSamples.append(contentsOf: UnsafeBufferPointer(start: p, count: count))
                    }
                }
            }
        }
        reader.cancelReading()
        guard allSamples.count > 1024 else { return [] }

        let sampleRate: Float = 22050.0
        let floatSamples = allSamples.map { Float($0) / Float(Int16.max) }

        // --- FFT setup (single, reused) ---
        let log2n = vDSP_Length(9)        // 2^9 = 512
        let frameSize = 512
        let hop = 128
        let halfN = frameSize / 2
        guard let fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return [] }
        defer { vDSP_destroy_fftsetup(fftSetup) }

        // Hann window (precomputed once).
        var hann = [Float](repeating: 0, count: frameSize)
        vDSP_hann_window(&hann, vDSP_Length(frameSize), Int32(vDSP_HANN_NORM))

        let binHz = sampleRate / Float(frameSize) // ≈43.07 Hz
        let lowBandMaxBin = max(1, Int(500.0 / binHz))         // <500Hz
        let hiBandLoBin = Int(2000.0 / binHz)                  // 2kHz
        let hiBandHiBin = min(halfN - 1, Int(4000.0 / binHz))  // 4kHz

        // Per-frame magnitude spectrum -> flux + features.
        var prevMag = [Float](repeating: 0, count: halfN)
        var fluxes: [Float] = []
        var centroids: [Float] = []
        var lbrs: [Float] = []
        var hbrs: [Float] = []
        var frameTimesMs: [Double] = []

        var windowed = [Float](repeating: 0, count: frameSize)
        var realp = [Float](repeating: 0, count: halfN)
        var imagp = [Float](repeating: 0, count: halfN)
        var magnitudes = [Float](repeating: 0, count: halfN)

        var idx = 0
        // We compute UNSCALED magnitudes. Every feature we use is either a ratio
        // (centroid, low/high-band ratio) or compared to a frame-local median
        // (flux), so the constant vDSP_fft_zrip 2x scaling cancels and is omitted.
        while idx + frameSize <= floatSamples.count {
            autoreleasepool {
                // Window the frame.
                floatSamples.withUnsafeBufferPointer { src in
                    vDSP_vmul(src.baseAddress! + idx, 1, hann, 1, &windowed, 1, vDSP_Length(frameSize))
                }
                // Pack real input into split-complex, run the real FFT, take mags.
                realp.withUnsafeMutableBufferPointer { rp in
                    imagp.withUnsafeMutableBufferPointer { ip in
                        var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                        windowed.withUnsafeBufferPointer { wp in
                            wp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: halfN) { cp in
                                vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(halfN))
                            }
                        }
                        vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                        // Magnitude = sqrt(re^2 + im^2). NOTE: in the zrip packed
                        // format realp[0]=DC and imagp[0]=Nyquist; zvabs would
                        // fold the Nyquist into bin 0's magnitude. We overwrite
                        // bin 0 with |DC| afterward so it's the true DC term.
                        let dc = rp.baseAddress![0]
                        magnitudes.withUnsafeMutableBufferPointer { mp in
                            vDSP_zvabs(&split, 1, mp.baseAddress!, 1, vDSP_Length(halfN))
                        }
                        magnitudes[0] = abs(dc)
                    }
                }

                // Positive spectral flux vs previous frame.
                var flux: Float = 0
                var total: Float = 0
                var lowE: Float = 0
                var hiE: Float = 0
                var weighted: Float = 0
                for k in 0..<halfN {
                    let m = magnitudes[k]
                    let d = m - prevMag[k]
                    if d > 0 { flux += d }
                    total += m
                    weighted += m * (Float(k) * binHz)
                    if k <= lowBandMaxBin { lowE += m }
                    if k >= hiBandLoBin && k <= hiBandHiBin { hiE += m }
                }
                let centroid = total > 0 ? weighted / total : 0
                let lbr = total > 0 ? lowE / total : 0
                let hbr = total > 0 ? hiE / total : 0

                fluxes.append(flux)
                centroids.append(centroid)
                lbrs.append(lbr)
                hbrs.append(hbr)
                frameTimesMs.append(Double(idx) / Double(sampleRate) * 1000.0)

                // Save current magnitude as previous for next flux.
                for k in 0..<halfN { prevMag[k] = magnitudes[k] }
            }
            idx += hop
        }

        guard fluxes.count > 5 else { return [] }

        // Adaptive peak pick (Dixon): local max AND flux >= sliding-median + delta,
        // AND >= onsetMinSpacing since last accepted onset.
        let medFrames = max(3, Int(options.fluxMedianMs / (Double(hop) / Double(sampleRate) * 1000.0)))
        var onsets: [AudioOnset] = []
        var lastMs = -1e9
        let n = fluxes.count
        for j in 1..<(n - 1) {
            let isLocalMax = fluxes[j] >= fluxes[j - 1] && fluxes[j] >= fluxes[j + 1]
            guard isLocalMax else { continue }
            let lo = max(0, j - medFrames)
            let hi = min(n - 1, j + medFrames)
            let slice = Array(fluxes[lo...hi]).sorted()
            let median = slice[slice.count / 2]
            let mean = slice.reduce(0, +) / Float(slice.count)
            let threshold = median + options.fluxDeltaScale * mean
            guard fluxes[j] > threshold && fluxes[j] > 0 else { continue }
            let tMs = frameTimesMs[j]
            guard tMs - lastMs >= options.onsetMinSpacingMs else { continue }
            lastMs = tMs

            // Wind/sharpness gate (critique #5): centroid above floor, low-band
            // not dominant, some high-band (2-4kHz) energy.
            let passed = centroids[j] >= options.centroidFloorHz
                && lbrs[j] < options.lowBandRatioCeil
                && hbrs[j] >= options.highBandFloor
            onsets.append(AudioOnset(
                timeMs: tMs, flux: fluxes[j], centroidHz: centroids[j],
                lowBandRatio: lbrs[j], highBandRatio: hbrs[j], passedGate: passed))
        }
        return onsets
    }

    // ============================================================================
    // MARK: - NEW: Pose timeline for live SVG overlay (read-only, orientation-correct)
    // ============================================================================

    /// Read-only payload for the live pose-overlay toggle. Reuses
    /// extractPoseFramesOriented so the per-joint x/y are already in the upright
    /// display space (critique #11: apply preferredTransform to coords, not only
    /// width/height). Emits DISPLAY-oriented normalized coords (Vision bottom-
    /// origin Y) plus display width/height so JS can contain-fit map them.
    ///
    /// JS contract:
    ///   { width: Number, height: Number,
    ///     frames: [ { timeMs: Number, confidence: Number,
    ///                 joints: { leftWrist: {x,y,confidence}, rightWrist, leftElbow,
    ///                           rightElbow, leftShoulder, rightShoulder, leftHip,
    ///                           rightHip, nose } } ] }
    /// Only joints present that frame are included (extractPoseFrames null-filters
    /// confidence<=0.3). Falls back to {width:0,height:0,frames:[]} on failure.
    private func extractPoseTimelinePayload(uri: String, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
            do {
                let fileURL = self.resolveFileURL(uri)
                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    promise.resolve(["width": 0, "height": 0, "frames": []] as [String: Any])
                    return
                }
                let asset = AVURLAsset(url: fileURL)
                guard let videoTrack = asset.tracks(withMediaType: .video).first else {
                    promise.resolve(["width": 0, "height": 0, "frames": []] as [String: Any])
                    return
                }
                // Display-oriented size (apply preferredTransform).
                let natural = videoTrack.naturalSize
                let displayRect = CGRect(origin: .zero, size: natural).applying(videoTrack.preferredTransform)
                let displayW = abs(displayRect.width)
                let displayH = abs(displayRect.height)

                // Oriented pose frames — coords already upright/display-space.
                let frames = try self.extractPoseFramesOriented(from: asset)

                var framePayloads: [[String: Any]] = []
                framePayloads.reserveCapacity(frames.count)
                for f in frames {
                    var joints: [String: Any] = [:]
                    func add(_ name: String, _ p: CGPoint?) {
                        guard let p = p else { return }
                        joints[name] = ["x": Double(p.x), "y": Double(p.y), "confidence": 1.0]
                    }
                    add("leftWrist", f.leftWrist)
                    add("rightWrist", f.rightWrist)
                    add("leftElbow", f.leftElbow)
                    add("rightElbow", f.rightElbow)
                    add("leftShoulder", f.leftShoulder)
                    add("rightShoulder", f.rightShoulder)
                    add("leftHip", f.leftHip)
                    add("rightHip", f.rightHip)
                    add("nose", f.nose)
                    framePayloads.append([
                        "timeMs": f.timeMs,
                        "confidence": Double(f.confidence),
                        "joints": joints,
                    ])
                }

                promise.resolve([
                    "width": Double(displayW),
                    "height": Double(displayH),
                    "frames": framePayloads,
                ] as [String: Any])
            } catch {
                promise.resolve(["width": 0, "height": 0, "frames": []] as [String: Any])
            }
            } // autoreleasepool
        }
    }
}
