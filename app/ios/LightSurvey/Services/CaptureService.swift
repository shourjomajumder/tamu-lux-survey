import Foundation
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import CoreLocation
import simd

/// One front-camera light reading.
struct LuxSample {
    let epoch: Double
    let lux: Double          // calibrated estimate
    let rawLux: Double       // before per-phone calibration factor
    let exposure: Double     // seconds
    let iso: Double
    let fNumber: Double
    let brightnessValue: Double  // Apple's APEX Bv from frame EXIF (NaN if missing)
    let meanY: Double        // mean luma 0–1 (gamma encoded)
    let linearY: Double      // mean linear luminance 0–1
    let clipFrac: Double     // fraction of saturated pixels
    let wbTemp: Double
    let wbTint: Double
}

/// Front camera (behind a paper diffuser) measures light the same way App Store lux meters do:
/// from the auto-exposure settings the camera picks (shutter time, ISO, aperture), via the
/// standard incident-light equation  E = K · N² / (t · S)  with K = 250, corrected by how bright
/// the frame actually came out (handles the case where auto-exposure has maxed out in the dark).
/// Back camera saves a full-resolution JPEG every `photoInterval` seconds with GPS + exposure EXIF.
/// Uses AVCaptureMultiCamSession so both cameras run at once (iPhone XS/XR and newer).
final class CaptureService: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    enum Mode: String { case none, multiCam = "Both cameras", frontOnly = "Lux only (this iPhone can't run both cameras)" }

    // Settings (set before start)
    var calibration: Double = 1.0
    var photoInterval: Double = 1.0
    var photosPaused = false
    var recordVideo = false
    /// Seconds between short-exposure "light snapshots" (0 = off). Lamps, signs and other sources
    /// are blown out in normal night frames; a 1/4000 s frame at minimum ISO shows their real
    /// shape, size and colour so each source can be located and classified later.
    var bracketInterval: Double = 5
    var jpegQuality: Double = 0.82
    let K: Double = 250
    let yRef: Double = 0.18

    weak var recorder: SessionRecorder?
    var locationProvider: (() -> CLLocation?)?
    var headingProvider: (() -> Double?)?
    var motionProvider: (() -> MotionSnapshot?)?
    var progressProvider: (() -> Double)?
    /// Small frames of what the back camera sees, ~10 per second, for the on-screen viewfinder.
    var previewHandler: ((CGImage) -> Void)?
    private var lastPreview: Double = 0   // backQueue only

    private(set) var mode: Mode = .none
    private(set) var frontFormatDesc = ""
    private(set) var backFormatDesc = ""
    private(set) var hardwareCost: Float = 0

    private var session: AVCaptureSession?
    private var frontDevice: AVCaptureDevice?
    private var backDevice: AVCaptureDevice?
    private let frontOutput = AVCaptureVideoDataOutput()
    private let backOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "capture.session")
    private let frontQueue = DispatchQueue(label: "capture.front")
    private let backQueue = DispatchQueue(label: "capture.back")
    private let encodeQueue = DispatchQueue(label: "capture.encode")
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let model = SessionRecorder.modelIdentifier()
    private var video: VideoRecorder?   // touched only on backQueue
    // Light-snapshot state machine (backQueue only)
    private var bracketPhase = 0          // 0 idle, 1 waiting for the short-exposure frame
    private var bracketStarted: Double = 0
    private var nextBracket: Double = 0
    private var bracketIndex = 0
    private let bracketTarget: Double = 1.0 / 4000.0

    private let lock = NSLock()
    private var _latest: LuxSample?
    private var _photoCount = 0
    private var _skipped = 0
    private var lastPhotoEpoch: Double = 0
    private var pendingEncodes = 0

    private static let linLUT: [Double] = (0..<256).map { i in
        let v = Double(i) / 255.0
        return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
    }

    var latest: LuxSample? {
        lock.lock(); defer { lock.unlock() }; return _latest
    }
    var photoCount: Int {
        lock.lock(); defer { lock.unlock() }; return _photoCount
    }
    var skippedPhotos: Int { lock.lock(); defer { lock.unlock() }; return _skipped }
    private var _brackets = 0
    var bracketCount: Int { lock.lock(); defer { lock.unlock() }; return _brackets }

    // Health + gating (all read/written under `lock`)
    private var _collecting = false
    private var _lastFrontEpoch: Double = 0
    private var _lastPhotoSaved: Double = 0
    private var _lastBackEpoch: Double = 0
    private var settleUntil: Double = 0   // backQueue only: auto-exposure recovering after a light snapshot
    private var _interrupted = false
    private var _restarts = 0
    /// Only record to disk while true (walker on the route, good GPS, app in front).
    /// The live lux number and camera preview keep working either way.
    var collecting: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _collecting }
        set { lock.lock(); _collecting = newValue; lock.unlock() }
    }
    var lastFrontEpoch: Double {
        lock.lock(); defer { lock.unlock() }; return _lastFrontEpoch
    }
    var lastPhotoSaved: Double { lock.lock(); defer { lock.unlock() }; return _lastPhotoSaved }
    var lastBackEpoch: Double {
        lock.lock(); defer { lock.unlock() }; return _lastBackEpoch
    }
    var interrupted: Bool { lock.lock(); defer { lock.unlock() }; return _interrupted }
    var restartCount: Int { lock.lock(); defer { lock.unlock() }; return _restarts }
    private var observers: [NSObjectProtocol] = []

    // MARK: - Lifecycle

    static func requestCameraAccess(_ done: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { done(ok) } }
        default: done(false)
        }
    }

    /// frontOnly = true for the calibration screen (saves battery, no photos).
    func start(frontOnly: Bool = false, completion: @escaping (String?) -> Void) {
        sessionQueue.async {
            let err = self.configure(frontOnly: frontOnly)
            if err == nil {
                self.session?.startRunning()
                self.observeSession()
            }
            DispatchQueue.main.async { completion(err) }
        }
    }

    /// Stops cameras and waits for queued JPEGs to finish writing.
    func stop(completion: (() -> Void)? = nil) {
        observers.forEach { NotificationCenter.default.removeObserver($0) }   // called on main
        observers = []
        collecting = false
        sessionQueue.async {
            if let s = self.session {
                s.stopRunning()
                CaptureService.teardown(s)
            }
            self.session = nil
            self.backQueue.sync {   // close the open video file
                self.video?.finish()
                self.video = nil
            }
            self.mode = .none
            self.encodeQueue.sync {}   // drain pending photo writes
            DispatchQueue.main.async { completion?() }
        }
    }

    /// Watch for phone calls, Control Center, camera errors: resume automatically.
    private func observeSession() {
        guard let s = session else { return }
        let nc = NotificationCenter.default
        let obs = [
            nc.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: s, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self._interrupted = true; self.lock.unlock()
            },
            nc.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: s, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self._interrupted = false; self.lock.unlock()
                self.restartIfNeeded()
            },
            nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: s, queue: .main) { [weak self] _ in
                self?.restartIfNeeded(force: true)
            },
        ]
        DispatchQueue.main.async { self.observers = obs }
    }

    /// Restart the camera session if it stopped (error, interruption, thermal).
    func restartIfNeeded(force: Bool = false) {
        sessionQueue.async {
            guard let s = self.session else { return }
            if force || !s.isRunning {
                if s.isRunning { s.stopRunning() }
                s.startRunning()
                self.lock.lock(); self._restarts += 1; self.lock.unlock()
            }
        }
    }

    func resetCounters() {
        lock.lock(); _photoCount = 0; _skipped = 0; _brackets = 0; lastPhotoEpoch = 0; _latest = nil
        _lastFrontEpoch = 0; _lastPhotoSaved = 0; _lastBackEpoch = 0; _interrupted = false; _restarts = 0; lock.unlock()
        backQueue.async { self.bracketPhase = 0; self.nextBracket = 0; self.bracketIndex = 0; self.settleUntil = 0 }
    }

    // MARK: - Configuration

    private func configure(frontOnly: Bool) -> String? {
        guard let front = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            return "No front camera found."
        }
        frontDevice = front
        let back = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        backDevice = back

        if !frontOnly, AVCaptureMultiCamSession.isMultiCamSupported, let back, let s = setupMultiCam(front: front, back: back) {
            session = s
            mode = .multiCam
            return nil
        }
        // Single-camera fallback: front camera only (lux), no photos.
        let s = AVCaptureSession()
        s.beginConfiguration()
        guard let input = try? AVCaptureDeviceInput(device: front), s.canAddInput(input) else {
            s.commitConfiguration(); return "Could not open the front camera."
        }
        s.addInput(input)
        prepare(frontOutput, queue: frontQueue)
        guard s.canAddOutput(frontOutput) else { s.commitConfiguration(); return "Could not attach camera output." }
        s.addOutput(frontOutput)
        if let f = pickFormat(front, multiCam: false, maxWidth: 1280, largest: false) {
            s.sessionPreset = .inputPriority
            configureDevice(front, format: f, isFront: true)
            frontFormatDesc = describe(f)
        }
        s.commitConfiguration()
        session = s
        mode = .frontOnly
        return nil
    }

    private func prepare(_ out: AVCaptureVideoDataOutput, queue: DispatchQueue) {
        out.alwaysDiscardsLateVideoFrames = true
        out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        out.setSampleBufferDelegate(self, queue: queue)
    }

    private func setupMultiCam(front: AVCaptureDevice, back: AVCaptureDevice) -> AVCaptureMultiCamSession? {
        let s = AVCaptureMultiCamSession()
        s.beginConfiguration()
        func fail() -> AVCaptureMultiCamSession? { s.commitConfiguration(); CaptureService.teardown(s); return nil }

        guard let fIn = try? AVCaptureDeviceInput(device: front), s.canAddInput(fIn) else { return fail() }
        s.addInputWithNoConnections(fIn)
        guard let bIn = try? AVCaptureDeviceInput(device: back), s.canAddInput(bIn) else { return fail() }
        s.addInputWithNoConnections(bIn)

        prepare(frontOutput, queue: frontQueue)
        prepare(backOutput, queue: backQueue)
        guard s.canAddOutput(frontOutput), s.canAddOutput(backOutput) else { return fail() }
        s.addOutputWithNoConnections(frontOutput)
        s.addOutputWithNoConnections(backOutput)

        guard let fPort = fIn.ports(for: .video, sourceDeviceType: front.deviceType, sourceDevicePosition: .front).first,
              let bPort = bIn.ports(for: .video, sourceDeviceType: back.deviceType, sourceDevicePosition: .back).first else { return fail() }
        let fConn = AVCaptureConnection(inputPorts: [fPort], output: frontOutput)
        let bConn = AVCaptureConnection(inputPorts: [bPort], output: backOutput)
        guard s.canAddConnection(fConn), s.canAddConnection(bConn) else { return fail() }
        s.addConnection(fConn)
        s.addConnection(bConn)
        if bConn.isCameraIntrinsicMatrixDeliverySupported { bConn.isCameraIntrinsicMatrixDeliveryEnabled = true }
        if bConn.isVideoStabilizationSupported { bConn.preferredVideoStabilizationMode = .off }

        if let ff = pickFormat(front, multiCam: true, maxWidth: 1280, largest: false) {
            configureDevice(front, format: ff, isFront: true)
            frontFormatDesc = describe(ff)
        }
        // Back camera: biggest multi-cam format up to 1920 wide; step down if the hardware budget is exceeded.
        let backCandidates = candidateFormats(back, multiCam: true)
            .filter { dims($0).width <= 1920 }
            .sorted { dims($0).width > dims($1).width }
        if let bf = backCandidates.first {
            configureDevice(back, format: bf, isFront: false)
            backFormatDesc = describe(bf)
        }
        s.commitConfiguration()

        var idx = 0
        while s.hardwareCost > 1.0, idx + 1 < backCandidates.count {
            idx += 1
            s.beginConfiguration()
            configureDevice(back, format: backCandidates[idx], isFront: false)
            backFormatDesc = describe(backCandidates[idx])
            s.commitConfiguration()
        }
        hardwareCost = s.hardwareCost
        if s.hardwareCost > 1.0 { CaptureService.teardown(s); return nil }   // can't fit both cameras → fall back
        return s
    }

    /// Detach everything so the shared outputs can be reused by a new session.
    static func teardown(_ s: AVCaptureSession) {
        s.beginConfiguration()
        if let m = s as? AVCaptureMultiCamSession { for c in m.connections { m.removeConnection(c) } }
        for o in s.outputs { s.removeOutput(o) }
        for i in s.inputs { s.removeInput(i) }
        s.commitConfiguration()
    }

    private func dims(_ f: AVCaptureDevice.Format) -> (width: Int, height: Int) {
        let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
        return (Int(d.width), Int(d.height))
    }

    private func describe(_ f: AVCaptureDevice.Format) -> String {
        let d = dims(f); return "\(d.width)x\(d.height)"
    }

    private func candidateFormats(_ d: AVCaptureDevice, multiCam: Bool) -> [AVCaptureDevice.Format] {
        d.formats.filter { f in
            (!multiCam || f.isMultiCamSupported)
            && CMFormatDescriptionGetMediaSubType(f.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            && f.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 15 && $0.maxFrameRate >= 15 }
        }
    }

    private func pickFormat(_ d: AVCaptureDevice, multiCam: Bool, maxWidth: Int, largest: Bool) -> AVCaptureDevice.Format? {
        let c = candidateFormats(d, multiCam: multiCam).filter { dims($0).width >= 640 && dims($0).width <= maxWidth }
        let fourThree = c.filter { dims($0).width * 3 == dims($0).height * 4 }
        let pool = fourThree.isEmpty ? c : fourThree
        return largest ? pool.max { dims($0).width < dims($1).width } : pool.min { dims($0).width < dims($1).width }
    }

    private func configureDevice(_ d: AVCaptureDevice, format: AVCaptureDevice.Format, isFront: Bool) {
        do {
            try d.lockForConfiguration()
            defer { d.unlockForConfiguration() }
            d.activeFormat = format
            // 15 fps: allows exposures up to 1/15 s on the front camera for dim scenes.
            if format.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 15 && $0.maxFrameRate >= 15 }) {
                d.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 15)
                d.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 15)
            }
            if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
            if d.isExposurePointOfInterestSupported { d.exposurePointOfInterest = CGPoint(x: 0.5, y: 0.5) }
            if d.isLowLightBoostSupported { d.automaticallyEnablesLowLightBoostWhenAvailable = false }
            d.automaticallyAdjustsFaceDrivenAutoExposureEnabled = false
            d.isFaceDrivenAutoExposureEnabled = false
            if isFront {
                if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { d.whiteBalanceMode = .continuousAutoWhiteBalance }
            } else {
                CaptureService.capExposure(d)
                if d.isFocusModeSupported(.continuousAutoFocus) { d.focusMode = .continuousAutoFocus }
            }
        } catch {
            print("lockForConfiguration failed: \(error)")
        }
    }

    /// Cap shutter time at 1/30 s so walking doesn't blur the frames. Call with the device locked.
    static func capExposure(_ d: AVCaptureDevice) {
        let cap = CMTime(value: 1, timescale: 30)
        let f = d.activeFormat
        if CMTimeCompare(cap, f.minExposureDuration) >= 0, CMTimeCompare(cap, f.maxExposureDuration) <= 0 {
            d.activeMaxExposureDuration = cap
        }
    }

    // MARK: - Light snapshots (short exposure)

    /// Returns true while a snapshot is in progress (the current frame is not a normal exposure).
    private func bracketTick(_ sb: CMSampleBuffer, rec: SessionRecorder, epoch: Double, exposure: Double) -> Bool {
        guard bracketInterval > 0, let d = backDevice else { return false }
        if bracketPhase == 0 {
            if nextBracket == 0 { nextBracket = epoch + 3 }
            guard epoch >= nextBracket, d.isExposureModeSupported(.custom) else { return false }
            do {
                try d.lockForConfiguration()
                let minDur = d.activeFormat.minExposureDuration
                var dur = CMTime(seconds: bracketTarget, preferredTimescale: 1_000_000)
                if CMTimeCompare(dur, minDur) < 0 { dur = minDur }
                d.setExposureModeCustom(duration: dur, iso: d.activeFormat.minISO, completionHandler: nil)
                d.unlockForConfiguration()
                bracketPhase = 1
                bracketStarted = epoch
            } catch {
                nextBracket = epoch + bracketInterval
            }
            return bracketPhase == 1
        }
        // phase 1: wait for the dark frame (or give up after 1.5 s), save it, then restore auto exposure
        let isDark = epoch > bracketStarted + 0.05 && exposure > 0 && exposure <= bracketTarget * 2.5
        if isDark { saveBracket(sb, rec: rec, epoch: epoch) }
        if isDark || epoch - bracketStarted > 1.5 {
            do {
                try d.lockForConfiguration()
                if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
                CaptureService.capExposure(d)
                d.unlockForConfiguration()
            } catch {}
            bracketPhase = 0
            nextBracket = epoch + bracketInterval
            settleUntil = epoch + 0.7   // let auto-exposure come back before the next normal photo
            // the next 2–3 frames still carry the short exposure; frames.csv flags them by exposure time
        }
        return true
    }

    private func saveBracket(_ sb: CMSampleBuffer, rec: SessionRecorder, epoch: Double) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        bracketIndex += 1
        let index = bracketIndex
        let width = CVPixelBufferGetWidth(pb), height = CVPixelBufferGetHeight(pb)
        let ex = exif(sb)
        let p = exposureParams(ex, device: backDevice)
        let l = luma(pb)
        let intr = intrinsics(sb)
        let ci = CIImage(cvPixelBuffer: pb)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return }
        let loc = locationProvider?(), heading = headingProvider?(), m = motionProvider?()
        let progress = progressProvider?() ?? .nan
        lock.lock(); _brackets += 1; lock.unlock()
        encodeQueue.async {
            let name = String(format: "BRK_%06d.jpg", index)
            guard self.writeJPEG(cg, to: rec.lightsDir.appendingPathComponent(name), exif: ex, epoch: epoch, location: loc, heading: heading) else { return }
            rec.brackets.write([String(index), "lights/" + name, fmt(epoch, 3), fmt(rec.t(epoch), 3),
                                fmt(loc?.coordinate.latitude, 7), fmt(loc?.coordinate.longitude, 7), fmt(loc?.horizontalAccuracy, 1),
                                fmt(heading, 1), fmt(p.t, 7), fmt(p.iso, 1), fmt(p.n, 2),
                                fmt(intr?.fx, 2), fmt(intr?.fy, 2), fmt(intr?.cx, 2), fmt(intr?.cy, 2), String(width), String(height),
                                fmt(m?.qw, 5), fmt(m?.qx, 5), fmt(m?.qy, 5), fmt(m?.qz, 5), fmt(m?.pitch, 1), fmt(m?.roll, 1), fmt(m?.yaw, 1),
                                fmt(l.mean, 4), fmt(l.clip, 5), fmt(progress, 1)].joined(separator: ","))
        }
    }

    /// JPEG with EXIF (exposure, time), TIFF (make/model), GPS. Orientation 6 = portrait.
    private func writeJPEG(_ cg: CGImage, to url: URL, exif ex: [String: Any], epoch: Double, location loc: CLLocation?, heading: Double?) -> Bool {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
        var props: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: jpegQuality,
            kCGImagePropertyOrientation: 6,
        ]
        var exifOut: [CFString: Any] = [:]
        for (k, v) in ex { exifOut[k as CFString] = v }
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "yyyy:MM:dd HH:mm:ss"
        exifOut[kCGImagePropertyExifDateTimeOriginal] = df.string(from: Date(timeIntervalSince1970: epoch))
        exifOut[kCGImagePropertyExifSubsecTimeOriginal] = String(format: "%03d", Int((epoch.truncatingRemainder(dividingBy: 1)) * 1000))
        props[kCGImagePropertyExifDictionary] = exifOut
        props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFMake: "Apple", kCGImagePropertyTIFFModel: model,
                                                 kCGImagePropertyTIFFOrientation: 6] as [CFString: Any]
        if let loc { props[kCGImagePropertyGPSDictionary] = CaptureService.gpsDict(loc, heading: heading) }
        CGImageDestinationAddImage(dest, cg, props as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }

    // MARK: - Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === frontOutput {
            handleFront(sampleBuffer)
        } else if output === backOutput {
            handleBack(sampleBuffer)
        }
    }

    private func exif(_ sb: CMSampleBuffer) -> [String: Any] {
        (CMGetAttachment(sb, key: kCGImagePropertyExifDictionary, attachmentModeOut: nil) as? [String: Any]) ?? [:]
    }

    private func exposureParams(_ ex: [String: Any], device: AVCaptureDevice?) -> (t: Double, iso: Double, n: Double, bv: Double, focal: Double) {
        var t = (ex[kCGImagePropertyExifExposureTime as String] as? NSNumber)?.doubleValue ?? .nan
        var iso = ((ex[kCGImagePropertyExifISOSpeedRatings as String] as? [NSNumber])?.first)?.doubleValue ?? .nan
        var n = (ex[kCGImagePropertyExifFNumber as String] as? NSNumber)?.doubleValue ?? .nan
        let bv = (ex[kCGImagePropertyExifBrightnessValue as String] as? NSNumber)?.doubleValue ?? .nan
        let focal = (ex[kCGImagePropertyExifFocalLength as String] as? NSNumber)?.doubleValue ?? .nan
        if let d = device {   // fall back to live device values
            if !(t > 0) { t = CMTimeGetSeconds(d.exposureDuration) }
            if !(iso > 0) { iso = Double(d.iso) }
            if !(n > 0) { n = Double(d.lensAperture) }
        }
        return (t, iso, n, bv, focal)
    }

    /// Mean luma (gamma-encoded and linear) over the central half of the frame, plus clipped fraction.
    private func luma(_ pb: CVPixelBuffer) -> (mean: Double, linear: Double, clip: Double) {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return (.nan, .nan, .nan) }
        let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let p = base.assumingMemoryBound(to: UInt8.self)
        let lut = CaptureService.linLUT
        var sum = 0, n = 0, clip = 0
        var lin = 0.0
        var y = h / 4
        while y < h * 3 / 4 {
            let row = p + y * stride
            var x = w / 4
            while x < w * 3 / 4 {
                let v = Int(row[x])
                sum += v; lin += lut[v]; n += 1
                if v >= 250 { clip += 1 }
                x += 4
            }
            y += 4
        }
        guard n > 0 else { return (.nan, .nan, .nan) }
        return (Double(sum) / Double(n) / 255.0, lin / Double(n), Double(clip) / Double(n))
    }

    private func handleFront(_ sb: CMSampleBuffer) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let epoch = Date().timeIntervalSince1970
        let ex = exif(sb)
        let p = exposureParams(ex, device: frontDevice)
        let l = luma(pb)
        var raw = Double.nan
        if p.t > 0, p.iso > 0, p.n > 0, l.linear.isFinite {
            raw = K * p.n * p.n / (p.t * p.iso) * (max(l.linear, 1e-4) / yRef)
        }
        var temp = Double.nan, tint = Double.nan
        if let d = frontDevice {
            var g = d.deviceWhiteBalanceGains
            let mx = d.maxWhiteBalanceGain
            g.redGain = min(max(g.redGain, 1), mx); g.greenGain = min(max(g.greenGain, 1), mx); g.blueGain = min(max(g.blueGain, 1), mx)
            let tt = d.temperatureAndTintValues(for: g)
            temp = Double(tt.temperature); tint = Double(tt.tint)
        }
        let s = LuxSample(epoch: epoch, lux: raw * calibration, rawLux: raw, exposure: p.t, iso: p.iso, fNumber: p.n,
                          brightnessValue: p.bv, meanY: l.mean, linearY: l.linear, clipFrac: l.clip, wbTemp: temp, wbTint: tint)
        lock.lock(); _latest = s; _lastFrontEpoch = epoch; let rec0 = _collecting; lock.unlock()

        guard rec0, let rec = recorder else { return }
        let loc = locationProvider?()
        let m = motionProvider?()
        rec.lux.write([fmt(epoch, 3), fmt(rec.t(epoch), 3), fmt(s.lux, 4), fmt(s.rawLux, 4), fmt(s.exposure, 6), fmt(s.iso, 1),
                       fmt(s.fNumber, 2), fmt(s.brightnessValue, 3), fmt(s.meanY, 4), fmt(s.linearY, 5), fmt(s.clipFrac, 4),
                       fmt(s.wbTemp, 0), fmt(s.wbTint, 1), fmt(loc?.coordinate.latitude, 7), fmt(loc?.coordinate.longitude, 7),
                       fmt(loc?.horizontalAccuracy, 1), fmt(m?.pitch, 1), fmt(m?.roll, 1), fmt(m?.yaw, 1)].joined(separator: ","))
    }

    private func intrinsics(_ sb: CMSampleBuffer) -> (fx: Double, fy: Double, cx: Double, cy: Double)? {
        guard let data = CMGetAttachment(sb, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, attachmentModeOut: nil) as? Data,
              data.count >= MemoryLayout<matrix_float3x3>.size else { return nil }
        let m = data.withUnsafeBytes { $0.loadUnaligned(as: matrix_float3x3.self) }
        return (Double(m.columns.0.x), Double(m.columns.1.y), Double(m.columns.2.x), Double(m.columns.2.y))
    }

    /// Continuous video + one frames.csv row per written frame (for 3D reconstruction).
    private func recordFrame(_ sb: CMSampleBuffer, rec: SessionRecorder, epoch: Double, inSnapshot: Bool) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        if video == nil {
            video = VideoRecorder(dir: rec.videoDir, width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb))
        }
        guard let v = video, let r = v.append(sb) else { return }
        let width = CVPixelBufferGetWidth(pb), height = CVPixelBufferGetHeight(pb)
        let ex = exif(sb)
        let p = exposureParams(ex, device: backDevice)
        let l = luma(pb)
        let intr = intrinsics(sb)
        let loc = locationProvider?()
        let heading = headingProvider?()
        let m = motionProvider?()
        let progress = progressProvider?() ?? .nan
        let lens = backDevice.map { Double($0.lensPosition) }
        var ev = Double.nan
        if p.t > 0, p.iso > 0, p.n > 0, l.linear > 0 {
            ev = log2(p.n * p.n / p.t) - log2(p.iso / 100) + log2(l.linear / 0.18)
        }
        rec.frames.write([String(r.segment), String(r.frame), fmt(r.pts, 4), fmt(epoch, 3), fmt(rec.t(epoch), 3),
                          fmt(loc?.coordinate.latitude, 7), fmt(loc?.coordinate.longitude, 7), fmt(loc?.horizontalAccuracy, 1),
                          fmt(heading, 1), fmt(p.t, 6), fmt(p.iso, 1), fmt(p.n, 2), fmt(p.bv, 3), fmt(lens, 3),
                          fmt(intr?.fx, 2), fmt(intr?.fy, 2), fmt(intr?.cx, 2), fmt(intr?.cy, 2), String(width), String(height),
                          fmt(m?.qw, 5), fmt(m?.qx, 5), fmt(m?.qy, 5), fmt(m?.qz, 5), fmt(m?.pitch, 1), fmt(m?.roll, 1), fmt(m?.yaw, 1),
                          fmt(l.mean, 4), fmt(l.clip, 4), fmt(ev, 3), fmt(progress, 1),
                          inSnapshot ? "1" : "0"].joined(separator: ","))
    }

    /// Downscaled copy of the back-camera frame for the live viewfinder (not saved).
    private func pushPreview(_ sb: CMSampleBuffer, epoch: Double) {
        guard let handler = previewHandler, epoch - lastPreview >= 0.1,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        lastPreview = epoch
        let ci = CIImage(cvPixelBuffer: pb)
        let scale = 480.0 / max(ci.extent.width, 1)
        let small = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = ciContext.createCGImage(small, from: small.extent) else { return }
        DispatchQueue.main.async { handler(cg) }
    }

    private func handleBack(_ sb: CMSampleBuffer) {
        let epoch = Date().timeIntervalSince1970
        lock.lock(); _lastBackEpoch = epoch; lock.unlock()
        pushPreview(sb, epoch: epoch)
        guard let rec = recorder, !photosPaused, collecting else { return }
        if recordVideo { recordFrame(sb, rec: rec, epoch: epoch, inSnapshot: bracketPhase == 1 || epoch < settleUntil) }
        let frameExposure = exposureParams(exif(sb), device: nil).t
        if bracketTick(sb, rec: rec, epoch: epoch, exposure: frameExposure) { return }
        // Skip only the few frames right after a light snapshot (NOT every short exposure:
        // in bright light normal exposures are shorter than 1/1000 s — that was the
        // "back camera stopped" false alarm).
        if epoch < settleUntil { return }
        lock.lock()
        let due = epoch - lastPhotoEpoch >= photoInterval
        let canEncode = pendingEncodes < 3
        if due && !canEncode { _skipped += 1; lastPhotoEpoch = epoch }
        let go = due && canEncode
        if go { lastPhotoEpoch = epoch; pendingEncodes += 1; _photoCount += 1 }
        let index = _photoCount
        lock.unlock()
        guard go else { return }

        func release() { lock.lock(); pendingEncodes -= 1; lock.unlock() }
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { release(); return }
        let width = CVPixelBufferGetWidth(pb), height = CVPixelBufferGetHeight(pb)
        let ex = exif(sb)
        let p = exposureParams(ex, device: backDevice)
        let l = luma(pb)
        let intr = intrinsics(sb)
        let ci = CIImage(cvPixelBuffer: pb)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { release(); return }
        let loc = locationProvider?()
        let heading = headingProvider?()
        let m = motionProvider?()
        let progress = progressProvider?() ?? .nan

        encodeQueue.async {
            defer { release() }
            let name = String(format: "IMG_%06d.jpg", index)
            guard self.writeJPEG(cg, to: rec.photosDir.appendingPathComponent(name), exif: ex, epoch: epoch, location: loc, heading: heading) else { return }
            self.lock.lock(); self._lastPhotoSaved = Date().timeIntervalSince1970; self.lock.unlock()

            var ev = Double.nan
            if p.t > 0, p.iso > 0, p.n > 0, l.linear > 0 {
                ev = log2(p.n * p.n / p.t) - log2(p.iso / 100) + log2(l.linear / 0.18)
            }
            rec.photos.write([String(index), "photos/" + name, fmt(epoch, 3), fmt(rec.t(epoch), 3),
                              fmt(loc?.coordinate.latitude, 7), fmt(loc?.coordinate.longitude, 7), fmt(loc?.altitude, 2),
                              fmt(loc?.horizontalAccuracy, 1), fmt(loc?.verticalAccuracy, 1),
                              fmt((loc?.speed ?? -1) >= 0 ? loc?.speed : nil, 2), fmt((loc?.course ?? -1) >= 0 ? loc?.course : nil, 1),
                              fmt(heading, 1), fmt(p.t, 6), fmt(p.iso, 1), fmt(p.n, 2), fmt(p.bv, 3), fmt(p.focal, 3),
                              fmt(intr?.fx, 2), fmt(intr?.fy, 2), fmt(intr?.cx, 2), fmt(intr?.cy, 2), String(width), String(height), "6",
                              fmt(m?.qw, 5), fmt(m?.qx, 5), fmt(m?.qy, 5), fmt(m?.qz, 5), fmt(m?.pitch, 1), fmt(m?.roll, 1), fmt(m?.yaw, 1),
                              fmt(l.mean, 4), fmt(l.linear, 5), fmt(ev, 3), fmt(progress, 1)].joined(separator: ","))
        }
    }

    static func gpsDict(_ l: CLLocation, heading: Double?) -> [CFString: Any] {
        let utc = TimeZone(identifier: "UTC")!
        let dfD = DateFormatter(); dfD.locale = Locale(identifier: "en_US_POSIX"); dfD.timeZone = utc; dfD.dateFormat = "yyyy:MM:dd"
        let dfT = DateFormatter(); dfT.locale = Locale(identifier: "en_US_POSIX"); dfT.timeZone = utc; dfT.dateFormat = "HH:mm:ss.SS"
        var d: [CFString: Any] = [
            kCGImagePropertyGPSLatitude: abs(l.coordinate.latitude),
            kCGImagePropertyGPSLatitudeRef: l.coordinate.latitude >= 0 ? "N" : "S",
            kCGImagePropertyGPSLongitude: abs(l.coordinate.longitude),
            kCGImagePropertyGPSLongitudeRef: l.coordinate.longitude >= 0 ? "E" : "W",
            kCGImagePropertyGPSAltitude: abs(l.altitude),
            kCGImagePropertyGPSAltitudeRef: l.altitude < 0 ? 1 : 0,
            kCGImagePropertyGPSHPositioningError: l.horizontalAccuracy,
            kCGImagePropertyGPSDateStamp: dfD.string(from: l.timestamp),
            kCGImagePropertyGPSTimeStamp: dfT.string(from: l.timestamp),
        ]
        if let h = heading, h >= 0 {
            d[kCGImagePropertyGPSImgDirection] = h
            d[kCGImagePropertyGPSImgDirectionRef] = "T"
        }
        return d
    }
}
