import Foundation
import AVFoundation
import CoreMedia

/// Writes back-camera frames to HEVC .mov files in 10-minute segments (video/back_000.mov, …).
/// Segments + movie fragments mean a crash or dead battery loses at most a few seconds.
/// Call `append` from the back-camera capture queue only.
final class VideoRecorder {
    private let dir: URL
    private let width: Int
    private let height: Int
    private let fps: Int
    private let segmentSeconds: Double
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var segmentStartPTS: CMTime?
    private(set) var segment = -1
    private(set) var frameInSegment = 0
    private(set) var failed: String?

    init(dir: URL, width: Int, height: Int, fps: Int = 15, segmentSeconds: Double = 600) {
        self.dir = dir
        self.width = width
        self.height = height
        self.fps = fps
        self.segmentSeconds = segmentSeconds
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    /// Appends a frame. Returns (segment index, frame index within segment, seconds into segment) or nil if dropped.
    func append(_ sb: CMSampleBuffer) -> (segment: Int, frame: Int, pts: Double)? {
        guard failed == nil else { return nil }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if writer == nil || (segmentStartPTS.map { CMTimeGetSeconds(CMTimeSubtract(pts, $0)) >= segmentSeconds } ?? false) {
            finishSegment(wait: false)
            startSegment(at: pts)
        }
        guard let w = writer, let inp = input, w.status == .writing else {
            if let w = writer, w.status == .failed { failed = w.error?.localizedDescription ?? "video writer failed" }
            return nil
        }
        guard inp.isReadyForMoreMediaData else { return nil }   // encoder busy: drop this frame
        guard inp.append(sb) else { return nil }
        let rel = CMTimeGetSeconds(CMTimeSubtract(pts, segmentStartPTS ?? pts))
        let result = (segment, frameInSegment, rel)
        frameInSegment += 1
        return result
    }

    private func startSegment(at pts: CMTime) {
        segment += 1
        frameInSegment = 0
        let url = dir.appendingPathComponent(String(format: "back_%03d.mov", segment))
        try? FileManager.default.removeItem(at: url)
        do {
            let w = try AVAssetWriter(outputURL: url, fileType: .mov)
            w.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.hevc,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 6_000_000,
                    AVVideoExpectedSourceFrameRateKey: fps,
                    AVVideoMaxKeyFrameIntervalKey: fps,
                ] as [String: Any],
            ]
            let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            inp.expectsMediaDataInRealTime = true
            inp.transform = CGAffineTransform(rotationAngle: .pi / 2)   // portrait playback
            guard w.canAdd(inp) else { failed = "cannot add video input"; return }
            w.add(inp)
            guard w.startWriting() else { failed = w.error?.localizedDescription ?? "startWriting failed"; return }
            w.startSession(atSourceTime: pts)
            writer = w
            input = inp
            segmentStartPTS = pts
        } catch {
            failed = error.localizedDescription
        }
    }

    private func finishSegment(wait: Bool) {
        guard let w = writer, let inp = input else { return }
        writer = nil
        input = nil
        guard w.status == .writing else { return }
        inp.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        w.finishWriting { done.signal() }
        if wait { _ = done.wait(timeout: .now() + 10) }
    }

    /// Finish the open file. Call on the back-camera queue (or after the session has stopped).
    func finish() { finishSegment(wait: true) }
}
