import Foundation
import CoreLocation
import CoreMotion
import AVFoundation

// MARK: - Motion

struct MotionSnapshot {
    let epoch: Double
    let qw, qx, qy, qz: Double
    let pitch, roll, yaw: Double      // degrees
    let gx, gy, gz: Double            // gravity (g)
    let ax, ay, az: Double            // user acceleration (g)
}

final class MotionService {
    private let manager = CMMotionManager()
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "motion"
        return q
    }()
    private let lock = NSLock()
    private var _latest: MotionSnapshot?
    var onSample: ((MotionSnapshot) -> Void)?

    var latest: MotionSnapshot? {
        lock.lock(); defer { lock.unlock() }
        return _latest
    }

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 30.0
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        let frame: CMAttitudeReferenceFrame = frames.contains(.xTrueNorthZVertical) ? .xTrueNorthZVertical : .xArbitraryCorrectedZVertical
        // Device-motion timestamps are seconds since boot; convert to Unix time.
        let bootOffset = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
        manager.startDeviceMotionUpdates(using: frame, to: queue) { [weak self] m, _ in
            guard let self, let m else { return }
            let q = m.attitude.quaternion
            let r = 180.0 / Double.pi
            let s = MotionSnapshot(epoch: bootOffset + m.timestamp,
                                   qw: q.w, qx: q.x, qy: q.y, qz: q.z,
                                   pitch: m.attitude.pitch * r, roll: m.attitude.roll * r, yaw: m.attitude.yaw * r,
                                   gx: m.gravity.x, gy: m.gravity.y, gz: m.gravity.z,
                                   ax: m.userAcceleration.x, ay: m.userAcceleration.y, az: m.userAcceleration.z)
            self.lock.lock(); self._latest = s; self.lock.unlock()
            self.onSample?(s)
        }
    }

    func stop() { manager.stopDeviceMotionUpdates() }
}

// MARK: - Barometer

final class AltimeterService {
    private let altimeter = CMAltimeter()
    private let queue = OperationQueue()
    var onSample: ((Double, Double, Double) -> Void)?   // epoch, relative altitude (m), pressure (kPa)

    func start() {
        guard CMAltimeter.isRelativeAltitudeAvailable() else { return }
        let bootOffset = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
        altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] d, _ in
            guard let d else { return }
            self?.onSample?(bootOffset + d.timestamp, d.relativeAltitude.doubleValue, d.pressure.doubleValue)
        }
    }

    func stop() { altimeter.stopRelativeAltitudeUpdates() }
}

// MARK: - Location

final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let lock = NSLock()
    private var _latest: CLLocation?
    private var _heading: CLHeading?

    var onLocation: ((CLLocation) -> Void)?
    var onHeading: ((CLHeading) -> Void)?
    var onAuthChange: (() -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .fitness
        manager.pausesLocationUpdatesAutomatically = false
        manager.headingFilter = 2
    }

    var latest: CLLocation? { lock.lock(); defer { lock.unlock() }; return _latest }
    var latestHeading: CLHeading? { lock.lock(); defer { lock.unlock() }; return _heading }
    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    func requestPermission() { manager.requestWhenInUseAuthorization() }

    func start() {
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for l in locations {
            lock.lock(); _latest = l; lock.unlock()
            onLocation?(l)
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        lock.lock(); _heading = newHeading; lock.unlock()
        onHeading?(newHeading)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { onAuthChange?() }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("Location error: \(error)")
    }
}

// MARK: - Voice prompts

final class Voice {
    private let synth = AVSpeechSynthesizer()
    var enabled = true

    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .mixWithOthers])
    }

    func say(_ text: String) {
        guard enabled else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.rate = 0.52
        u.voice = AVSpeechSynthesisVoice(language: "en-US")
        synth.speak(u)
    }
}
