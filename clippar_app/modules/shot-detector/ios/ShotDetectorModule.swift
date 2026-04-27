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
private struct PoseFrame {
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
        AsyncFunction("detectAndTrim") { (videoUri: String, preRollMs: Double, postRollMs: Double, recentShotTypes: [String], promise: Promise) in
            self.detectAndTrimVideo(uri: videoUri, preRollMs: preRollMs, postRollMs: postRollMs, recentShotTypes: recentShotTypes, promise: promise)
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
    }

    // MARK: - Passthrough Trim (zero re-encode)

    private func trimVideoPassthrough(uri: String, startMs: Double, endMs: Double, promise: Promise) {
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

                // Determine output file type based on input extension
                let ext = fileURL.pathExtension.lowercased()
                let outputFileType: AVFileType = (ext == "mov") ? .mov : .mp4
                let outputExt = (ext == "mov") ? "mov" : "mp4"

                guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
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
                    promise.reject(Exception(name: "ERR_TRIM_FAILED", description: "Trim export failed: \(error.localizedDescription)"))
                    return
                }

                let elapsed = CACurrentMediaTime() - startTime
                print("[ShotDetector] Passthrough trim took \(String(format: "%.2f", elapsed))s — zero re-encode")

                promise.resolve([
                    "trimmedUri": outputURL.absoluteString,
                ] as [String: Any])
            } catch {
                promise.reject(Exception(name: "ERR_TRIM_FAILED", description: error.localizedDescription))
            }
            } // autoreleasepool
        }
    }

    // MARK: - Combined Detect + Trim

    private func detectAndTrimVideo(uri: String, preRollMs: Double, postRollMs: Double, recentShotTypes: [String], promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            // Wrap entire operation in autoreleasepool to ensure AVAsset, AVAssetReader,
            // VNImageRequestHandler, pixel buffers, and AVAssetExportSession are freed
            // immediately after each call — critical for batch processing 60-100+ clips.
            autoreleasepool {
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
                let result = self.detectSwingEvent(
                    poseFrames: poseFrames,
                    audioTransients: audioTransients,
                    asset: asset,
                    recentShotTypes: recentShotTypes
                )

                let detectionElapsed = CACurrentMediaTime() - startTime
                let durationMs = CMTimeGetSeconds(asset.duration) * 1000.0

                print("[ShotDetector] Detection took \(String(format: "%.1f", detectionElapsed))s for \(String(format: "%.1f", durationMs/1000))s video (\(poseFrames.count) frames analysed)")

                guard result.found else {
                    let availableMBAfter = Double(os_proc_available_memory()) / (1024.0 * 1024.0)
                    print("[ShotDetector] Available memory: \(String(format: "%.0f", availableMBAfter))MB after processing (delta: \(String(format: "%.0f", availableMBAfter - availableMB))MB)")
                    promise.resolve([
                        "found": false,
                        "impactTimeMs": 0.0,
                        "trimStartMs": 0.0,
                        "trimEndMs": 0.0,
                        "confidence": 0.0,
                        "shotType": "swing",
                        "trimmedUri": NSNull(),
                    ] as [String: Any])
                    return
                }

                print("[Classifier] clip=\(fileURL.lastPathComponent) shotType=\(result.shotType.rawValue) confidence=\(String(format: "%.2f", result.confidence)) durationMs=\(Int(durationMs)) impactMs=\(Int(result.impactTimeMs)) poseFrames=\(poseFrames.count) audioTransients=\(audioTransients.count)")

                // Putts: keep full clip (no trimming) — the ball roll is the interesting part
                if result.shotType == .putt {
                    print("[ShotDetector] Putt detected — keeping full clip (no trim)")
                    let availableMBAfter = Double(os_proc_available_memory()) / (1024.0 * 1024.0)
                    print("[ShotDetector] Available memory: \(String(format: "%.0f", availableMBAfter))MB after processing (delta: \(String(format: "%.0f", availableMBAfter - availableMB))MB)")
                    promise.resolve([
                        "found": true,
                        "impactTimeMs": result.impactTimeMs,
                        "trimStartMs": 0.0,
                        "trimEndMs": durationMs,
                        "confidence": result.confidence,
                        "shotType": result.shotType.rawValue,
                        "trimmedUri": NSNull(),
                    ] as [String: Any])
                    return
                }

                // Step 2: Calculate trim window with configurable pre/post roll (swings only)
                let trimStart = max(0.0, result.impactTimeMs - preRollMs)
                let trimEnd = min(durationMs, result.impactTimeMs + postRollMs)

                // Step 3: Passthrough trim (zero re-encode)
                let ext = fileURL.pathExtension.lowercased()
                let outputFileType: AVFileType = (ext == "mov") ? .mov : .mp4
                let outputExt = (ext == "mov") ? "mov" : "mp4"

                guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
                    // Detection succeeded but trim failed — return detection result without trim
                    promise.resolve([
                        "found": true,
                        "impactTimeMs": result.impactTimeMs,
                        "trimStartMs": trimStart,
                        "trimEndMs": trimEnd,
                        "confidence": result.confidence,
                        "shotType": result.shotType.rawValue,
                        "trimmedUri": NSNull(),
                    ] as [String: Any])
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
                    promise.resolve([
                        "found": true,
                        "impactTimeMs": result.impactTimeMs,
                        "trimStartMs": trimStart,
                        "trimEndMs": trimEnd,
                        "confidence": result.confidence,
                        "shotType": result.shotType.rawValue,
                        "trimmedUri": NSNull(),
                    ] as [String: Any])
                    return
                }

                print("[ShotDetector] Detect+trim total: \(String(format: "%.2f", totalElapsed))s (detection: \(String(format: "%.1f", detectionElapsed))s, trim: \(String(format: "%.2f", totalElapsed - detectionElapsed))s)")

                let availableMBAfter = Double(os_proc_available_memory()) / (1024.0 * 1024.0)
                print("[ShotDetector] Available memory: \(String(format: "%.0f", availableMBAfter))MB after processing (delta: \(String(format: "%.0f", availableMBAfter - availableMB))MB)")

                promise.resolve([
                    "found": true,
                    "impactTimeMs": result.impactTimeMs,
                    "trimStartMs": trimStart,
                    "trimEndMs": trimEnd,
                    "confidence": result.confidence,
                    "shotType": result.shotType.rawValue,
                    "trimmedUri": outputURL.absoluteString,
                ] as [String: Any])
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

    private func resolveFileURL(_ uri: String) -> URL {
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
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                  let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                promise.reject(Exception(name: "ERR_COMPOSITION", description: "Could not create composition tracks"))
                return
            }

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

                // Insert audio track (if present)
                if let assetAudioTrack = asset.tracks(withMediaType: .audio).first {
                    do {
                        try audioTrack.insertTimeRange(
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

            // MediumQuality re-encodes ~3-5x faster than HighestQuality with
            // no perceptible difference at 1080p — clips were already encoded
            // by the device camera, so pumping bitrate higher here just
            // doubles compose time without improving the visual result.
            let presetName = AVAssetExportPresetMediumQuality
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
                promise.reject(Exception(name: "ERR_STITCH_FAILED", description: "Stitch export failed: \(error.localizedDescription)"))
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

    private func computeFillTransform(
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

    private func composeReelOnDevice(clips: [[String: Any]], scorecardJson: String, musicUri: String?, promise: Promise) {
        DispatchQueue.global(qos: .userInitiated).async {
            let startTime = CACurrentMediaTime()

            guard !clips.isEmpty else {
                promise.reject(Exception(name: "ERR_NO_CLIPS", description: "No clips provided"))
                return
            }

            // Parse scorecard data
            var scorecard: ScorecardData?
            if let jsonData = scorecardJson.data(using: .utf8) {
                scorecard = try? JSONDecoder().decode(ScorecardData.self, from: jsonData)
            }

            // Build the composition
            let composition = AVMutableComposition()
            guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
                  let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
                promise.reject(Exception(name: "ERR_COMPOSITION", description: "Could not create composition tracks"))
                return
            }

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
                    try? audioTrack.insertTimeRange(
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

                // Persistent background card — visible for entire video
                let cardHeight: CGFloat = renderSize.height * 0.12
                let cardWidth: CGFloat = renderSize.width * 0.92
                let cardX: CGFloat = (renderSize.width - cardWidth) / 2
                let cardY: CGFloat = renderSize.height * 0.05

                let bgLayer = CALayer()
                bgLayer.frame = CGRect(x: cardX, y: cardY, width: cardWidth, height: cardHeight)
                bgLayer.backgroundColor = UIColor(white: 0, alpha: 0.75).cgColor
                bgLayer.cornerRadius = 16
                bgLayer.borderWidth = 1
                bgLayer.borderColor = UIColor(white: 1, alpha: 0.1).cgColor
                overlayContainer.addSublayer(bgLayer)

                // Persistent course name
                let scale = UIScreen.main.scale
                let inset: CGFloat = 16
                let courseText = CATextLayer()
                courseText.string = sc.courseName
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
                overlayContainer.addSublayer(courseText)

                // Per-hole text layers — each visible only during its hole
                var runningScore = 0
                for (index, hole) in sc.holes.enumerated() {
                    let cumulativeScore = runningScore + hole.strokes

                    let holeContainer = CALayer()
                    holeContainer.frame = CGRect(origin: .zero, size: renderSize)
                    holeContainer.opacity = 0

                    let beginTime = hole.startMs / 1000.0
                    let holeDuration = (hole.endMs - hole.startMs) / 1000.0

                    // Fade in
                    let fadeIn = CABasicAnimation(keyPath: "opacity")
                    fadeIn.fromValue = 0
                    fadeIn.toValue = 1
                    fadeIn.beginTime = AVCoreAnimationBeginTimeAtZero + beginTime
                    fadeIn.duration = 0.15
                    fadeIn.fillMode = .forwards
                    fadeIn.isRemovedOnCompletion = false
                    holeContainer.add(fadeIn, forKey: "fadeIn")

                    // Fade out — only if NOT the last hole (last hole stays visible)
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

                    // Running total text (right-aligned, top)
                    let runningText = CATextLayer()
                    runningText.string = "TOTAL  \(cumulativeScore)"
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
                    holeContainer.addSublayer(runningText)

                    // Hole number (bottom left)
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
                    holeContainer.addSublayer(holeText)

                    // Par text (center bottom)
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
                    holeContainer.addSublayer(parText)

                    // Score with color coding (bottom right)
                    let scoreToPar = hole.strokes - hole.par
                    let scoreColor: UIColor
                    if scoreToPar < 0 {
                        scoreColor = UIColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1)
                    } else if scoreToPar == 0 {
                        scoreColor = UIColor.white
                    } else {
                        scoreColor = UIColor(red: 1.0, green: 0.45, blue: 0.4, alpha: 1)
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
                    holeContainer.addSublayer(scoreText)

                    overlayContainer.addSublayer(holeContainer)
                    runningScore = cumulativeScore
                }

                // Fade the entire background + course name in at the start
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

                            // Mix: clip audio at 80% volume, music at 30%
                            let mix = AVMutableAudioMix()
                            let clipAudioParam = AVMutableAudioMixInputParameters(track: audioTrack)
                            clipAudioParam.setVolume(0.8, at: .zero)
                            let musicAudioParam = AVMutableAudioMixInputParameters(track: musicTrack)
                            musicAudioParam.setVolume(0.3, at: .zero)
                            // Fade out music in last 2 seconds
                            let fadeStart = CMTimeSubtract(totalDuration, CMTime(seconds: 2.0, preferredTimescale: 600))
                            musicAudioParam.setVolumeRamp(fromStartVolume: 0.3, toEndVolume: 0.0, timeRange: CMTimeRange(start: fadeStart, duration: CMTime(seconds: 2.0, preferredTimescale: 600)))
                            mix.inputParameters = [clipAudioParam, musicAudioParam]
                            audioMix = mix
                        }
                    }
                }
            }

            // ---- Export ----
            let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                .appendingPathComponent("reel_\(UUID().uuidString).mp4")
            try? FileManager.default.removeItem(at: outputURL)

            // MediumQuality cuts reel compose time roughly in half vs
            // HighestQuality with no visible quality drop at 1080p. See
            // matching note in stitchClips above.
            guard let exportSession = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetMediumQuality) else {
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
                    "current": clips.count,
                    "total": clips.count,
                    "percent": exportPercent,
                ])
            }

            semaphore.wait()

            if let error = exportError {
                promise.reject(Exception(name: "ERR_COMPOSE_FAILED", description: "Reel compose failed: \(error.localizedDescription)"))
                return
            }

            let elapsed = CACurrentMediaTime() - startTime
            let durationSec = CMTimeGetSeconds(totalDuration)
            print("[ShotDetector] Composed reel (\(clips.count) clips, \(String(format: "%.1f", durationSec))s, overlay: \(scorecard != nil), music: \(musicUri != nil)) in \(String(format: "%.1f", elapsed))s")

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
}
