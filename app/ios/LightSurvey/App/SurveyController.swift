import SwiftUI
import Observation
import CoreLocation
import UIKit

/// One problem (or good news) shown on the walking screen.
struct SurveyAlert: Identifiable, Equatable {
    enum Level: Int { case good = 0, info = 1, warn = 2, bad = 3 }
    enum Action { case guideBack, retryCamera }
    let id: String
    let level: Level
    let icon: String
    let text: String
    var action: Action? = nil
    static func == (a: SurveyAlert, b: SurveyAlert) -> Bool { a.id == b.id && a.text == b.text }
}

/// A stretch of the route drawn in one colour on the map.
struct CoverageRun: Identifiable {
    enum State { case done, missed, todo }
    let id: Int
    let state: State
    let coords: [CLLocationCoordinate2D]
}

@Observable
final class SurveyController {
    // MARK: Configuration
    var routes: [SurveyRoute] = RouteStore.current()
    /// Shown on the home screen when Survey Control has assigned routes.
    var assignmentNote = ""
    /// Walker names set in Survey Control (e.g. 2 → "jamal"), from the startup hello. Cached for offline use.
    var walkerNames: [Int: String] = (UserDefaults.standard.dictionary(forKey: "walkerNames") as? [String: String] ?? [:])
        .reduce(into: [Int: String]()) { d, kv in if let k = Int(kv.key) { d[k] = kv.value } }
    var selectedRouteID: Int = 1
    var calibration: Double
    var photoInterval: Double = 1.0
    var recordVideo = false
    var lightSnapshots = true
    var voiceOn = true

    // MARK: Live state (read by views)
    var isRunning = false
    var isStarting = false
    var errorMessage: String?
    var captureModeText = ""
    var elapsed: TimeInterval = 0
    var lux: Double = .nan
    var rawLux: Double = .nan
    var exposureText = ""
    var photoCount = 0
    var progress: Double = 0
    var stepIndex = 0
    var distToNext: Double = 0
    var offRoute = false
    var distFromRoute: Double = 0
    var gpsAccuracy: Double = -1
    var batteryLevel: Float = -1
    var thermalText = ""
    var marks = 0
    var hasFix = false
    /// Latest back-camera frame for the on-screen viewfinder.
    var previewImage: CGImage?
    var layerDone: [CLLocationCoordinate2D] = []
    var layerRemaining: [CLLocationCoordinate2D] = []
    var layerCurrent: [CLLocationCoordinate2D] = []
    var lastSessionURL: URL?
    var showSummary = false
    var summaryText = ""

    // Coverage (what's been captured, saved per walker across sessions)
    var coverageRuns: [CoverageRun] = []
    var coverageFraction: Double = 0
    var gapCount = 0
    var gapMeters: Double = 0
    var collecting = false
    var collectStatus = "Waiting for GPS"
    var alerts: [SurveyAlert] = []
    var targetCoord: CLLocationCoordinate2D?
    var targetText = ""
    var distToTarget: Double = 0
    var walkerFractions: [Int: Double] = [:]
    var recoveredSessions = 0
    var resumed = false
    /// False until the walker reaches the start point; nothing is recorded before that.
    var atStart = false
    var distToStart: Double = 0
    var userCoord: CLLocationCoordinate2D?
    var phoneHeading: Double = -1
    /// Becomes true with the first compass reading (the map checks this instead of `phoneHeading`,
    /// so 10 heading updates a second don't rebuild the map's content).
    var hasPhoneHeading = false
    /// Bumps on every GPS fix so the map's follow-cam can move.
    var locationTick = 0
    /// Direction to turn the map: walking direction when moving, else where the phone points.
    var travelHeading: Double = -1
    // Live link to the team dashboard
    @ObservationIgnored let live = LiveUploader()
    var liveOK = false
    var liveStatus = "Not tried yet"
    // Background uploads: everything new is sent every 5 minutes while recording, and at End.
    static let uploadInterval: TimeInterval = 5 * 60
    var uploadPending = 0
    var uploadDone = 0
    var uploadChunksDone: [Int] = []
    var uploadError = ""

    // MARK: Services
    @ObservationIgnored let location = LocationService()
    @ObservationIgnored let motion = MotionService()
    @ObservationIgnored let altimeter = AltimeterService()
    @ObservationIgnored let capture = CaptureService()
    @ObservationIgnored let voice = Voice()
    @ObservationIgnored private(set) var recorder: SessionRecorder?
    @ObservationIgnored private(set) var tracker: RouteTracker?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var uploadTimer: Timer?
    @ObservationIgnored private var startDate = Date()
    @ObservationIgnored private var announcedFar = Set<Int>()
    @ObservationIgnored private var announcedNear = Set<Int>()
    @ObservationIgnored private var lastOffRouteVoice = Date.distantPast
    @ObservationIgnored private var luxSmooth = Double.nan
    @ObservationIgnored private var lastThermal: ProcessInfo.ThermalState = .nominal
    @ObservationIgnored private var lastLayerProgress: Double = -1
    @ObservationIgnored private var lastLayerDate = Date.distantPast
    @ObservationIgnored private var lastLayerStep = -1
    @ObservationIgnored private(set) var coverage: CoverageStore?
    @ObservationIgnored private var appActive = true
    @ObservationIgnored private var onRoute = false
    @ObservationIgnored private var lastCreditedPhotos = 0
    @ObservationIgnored private var coverageChanged = true
    @ObservationIgnored private var lastRunsBuild = Date.distantPast
    @ObservationIgnored private var lastRunsBehindBin = -1
    @ObservationIgnored private var announcedGaps = Set<Int>()
    @ObservationIgnored private var targetAlong: Double?
    @ObservationIgnored private var targetIsGap = false
    @ObservationIgnored private var tickCount = 0
    @ObservationIgnored private var collectingSince = Date()
    @ObservationIgnored private var lastFixDate = Date.distantPast
    @ObservationIgnored private var fastFixes = 0
    @ObservationIgnored private var badPoseSince: Date?
    @ObservationIgnored private var badLuxSince: Date?
    @ObservationIgnored private var lastRestart = Date.distantPast
    @ObservationIgnored private var spokenAlerts = Set<String>()
    @ObservationIgnored private var thermalPause = false
    @ObservationIgnored private var storagePause = false
    @ObservationIgnored private var freeGB: Double = -1
    @ObservationIgnored private var completeAnnounced = false
    @ObservationIgnored private var startAlong: Double = 0
    @ObservationIgnored private var lastHeadingUI = Date.distantPast
    @ObservationIgnored private var frontStallSince: Date?
    @ObservationIgnored private var backStallSince: Date?
    @ObservationIgnored private var batteryWarned = false
    static let startRadius = 15.0       // how close to the start point counts as "at the start"
    static let creditRadius = 10.0      // metres either side of you that a reading counts for
    static let onRouteMax = 20.0        // further than this from the line = not recording
    static let goodAccuracy = 25.0      // GPS must be at least this good for data to count

    init() {
        let saved = UserDefaults.standard.double(forKey: "calibration")
        calibration = saved > 0 ? saved : 1.0
        if let r = UserDefaults.standard.object(forKey: "walker") as? Int { selectedRouteID = r }
        let interrupted = SessionRecorder.markInterruptedSessions()
        recoveredSessions = interrupted.count
        refreshWalkerStats()
        UploadManager.shared.onStats = { [weak self] st in
            self?.uploadPending = st.pending
            self?.uploadDone = st.uploaded
            self?.uploadChunksDone = st.chunksDone
            self?.uploadError = st.lastError
        }
        UploadManager.shared.resume()
        // A walk that was killed mid-way (app closed, phone died) never got its End upload:
        // queue whatever it recorded since its last 5-minute chunk. Files stay on the phone.
        for s in interrupted {
            UploadManager.shared.uploadNew(sessionDir: s.dir, walker: s.walker)
        }
    }

    // MARK: - Routes assigned from Survey Control (website)

    /// Asks the dashboard which route each walker should walk. Never changes a route mid-walk.
    func checkAssignments() {
        guard !isRunning, !isStarting, let base = live.baseURLString else { return }
        let defaults = RouteStore.load()
        for w in defaults.map(\.id) {
            guard let url = URL(string: "\(base)/api/assigned?walker=\(w)") else { continue }
            var req = URLRequest(url: url, timeoutInterval: 10)
            req.setValue(LiveUploader.key, forHTTPHeaderField: "x-live-key")
            URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
                guard let self, let data, (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
                struct Reply: Decodable { let route: SurveyRoute? }
                guard let reply = try? JSONDecoder().decode(Reply.self, from: data) else { return }
                DispatchQueue.main.async { self.applyAssigned(reply.route, to: w) }
            }.resume()
        }
    }

    /// Swaps walker `w`'s route for the one assigned in Survey Control (nil = back to the bundled loop).
    /// Shared by checkAssignments() and hello(). Never changes a route mid-walk. Call on the main thread.
    private func applyAssigned(_ lib: SurveyRoute?, to w: Int) {
        guard !isRunning, !isStarting, let i = routes.firstIndex(where: { $0.id == w }) else { return }
        if let lib {
            guard lib.pts.count >= 2, lib.pts.count == lib.cum.count, lib.pts.allSatisfy({ $0.count >= 2 }) else { return }
            let r = RouteStore.assigned(lib, to: w)
            if routes[i].variant != r.variant {
                routes[i] = r
                if let enc = try? JSONEncoder().encode(r) { UserDefaults.standard.set(enc, forKey: "assigned-\(w)") }
            }
        } else if routes[i].variant != nil, let d = RouteStore.load().first(where: { $0.id == w }) {
            routes[i] = d
            UserDefaults.standard.removeObject(forKey: "assigned-\(w)")
        }
        let n = routes.filter { $0.variant != nil }.count
        assignmentNote = n == 0 ? "" : "\(n) walker(s) have a route assigned from Survey Control"
        refreshWalkerStats()
    }

    // MARK: - Startup handshake with Survey Control

    /// Tells the website this phone is up for walker `w` (default: the selected walker) and gets back
    /// the walker's name and assigned route. Silent on failure — offline is fine.
    func hello(_ walker: Int? = nil) {
        let w = walker ?? selectedRouteID
        guard let base = live.baseURLString, let url = URL(string: "\(base)/api/control") else { return }
        let info = Bundle.main.infoDictionary
        let version = (info?["CFBundleShortVersionString"] as? String ?? "?") + " (" + (info?["CFBundleVersion"] as? String ?? "?") + ")"
        let body: [String: Any] = ["action": "hello", "walker": w, "device": UIDevice.current.name, "app_version": version]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(LiveUploader.key, forHTTPHeaderField: "x-live-key")
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self, let data, (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
            struct HelloWalker: Decodable { let name: String? }
            struct Assignment: Decodable { let route_id: Int? }
            struct Reply: Decodable { let ok: Bool?; let walker: HelloWalker?; let assignment: Assignment? }
            struct RouteOnly: Decodable { let route: SurveyRoute? }
            guard let reply = try? JSONDecoder().decode(Reply.self, from: data), reply.ok == true else { return }
            // decoded on its own so a route the app can't read doesn't lose the name (or wrongly clear the route)
            let route = (try? JSONDecoder().decode(RouteOnly.self, from: data))?.route
            DispatchQueue.main.async {
                if let name = reply.walker?.name?.trimmingCharacters(in: .whitespacesAndNewlines) {
                    self.setWalkerName(name == "Walker \(w)" ? nil : name, for: w)
                }
                if reply.assignment == nil {
                    self.applyAssigned(nil, to: w)
                } else if let route {
                    self.applyAssigned(route, to: w)
                }
            }
        }.resume()
    }

    private func setWalkerName(_ name: String?, for w: Int) {
        let clean = (name?.isEmpty ?? true) ? nil : name
        guard walkerNames[w] != clean else { return }
        walkerNames[w] = clean
        let stored = Dictionary(uniqueKeysWithValues: walkerNames.map { (String($0.key), $0.value) })
        UserDefaults.standard.set(stored, forKey: "walkerNames")
    }

    /// "Walker 1 · jamal" when Survey Control has a name for this walker, else "Walker 1".
    func walkerTitle(_ w: Int) -> String {
        if let n = walkerNames[w], !n.isEmpty { return "Walker \(w) · \(n)" }
        return "Walker \(w)"
    }

    // MARK: - Per-walker progress (home screen)

    func refreshWalkerStats() {
        var f: [Int: Double] = [:]
        for r in routes { f[r.id] = CoverageStore(route: r).fraction }
        walkerFractions = f
    }

    func resetProgress(_ id: Int) {
        guard let r = routes.first(where: { $0.id == id }) else { return }
        CoverageStore(route: r).reset()
        refreshWalkerStats()
    }

    var route: SurveyRoute? { routes.first { $0.id == selectedRouteID } }
    var steps: [RouteStep] { route?.steps ?? [] }
    var currentStep: RouteStep? { steps.indices.contains(stepIndex) ? steps[stepIndex] : nil }
    var nextStep: RouteStep? { steps.indices.contains(stepIndex + 1) ? steps[stepIndex + 1] : nil }
    var thenStep: RouteStep? { steps.indices.contains(stepIndex + 2) ? steps[stepIndex + 2] : nil }
    var remaining: Double { max(0, (route?.total ?? 0) - progress) }

    func setCalibration(_ v: Double) {
        calibration = v
        UserDefaults.standard.set(v, forKey: "calibration")
        capture.calibration = v
    }

    func select(_ id: Int) {
        selectedRouteID = id
        UserDefaults.standard.set(id, forKey: "walker")
        hello(id)
    }

    // MARK: - Start / stop

    func start() {
        guard let route, !isRunning, !isStarting else { return }
        errorMessage = nil
        isStarting = true
        CaptureService.requestCameraAccess { [weak self] ok in
            guard let self else { return }
            guard ok else {
                self.isStarting = false
                self.errorMessage = "Camera access is off. Turn it on in Settings → LightSurvey → Camera."
                return
            }
            if self.location.authorization == .notDetermined { self.location.requestPermission() }
            self.beginSession(route)
        }
    }

    private func beginSession(_ route: SurveyRoute) {
        do {
            recorder = try SessionRecorder(route: route, calibration: calibration, photoInterval: photoInterval)
        } catch {
            isStarting = false
            errorMessage = "Couldn't create the session folder: \(error.localizedDescription)"
            return
        }
        let t = RouteTracker(route: route)
        tracker = t
        let cov = CoverageStore(route: route)
        coverage = cov
        t.needsData = { [weak cov] along in cov?.needsData(at: along) ?? false }
        announcedFar = []; announcedNear = []; announcedGaps = []; spokenAlerts = []
        progress = 0; stepIndex = 0; marks = 0; photoCount = 0; lux = .nan; luxSmooth = .nan
        offRoute = false; hasFix = false; lastLayerProgress = -1; onRoute = false; collecting = false
        lastCreditedPhotos = 0; coverageChanged = true; alerts = []; completeAnnounced = false
        fastFixes = 0; badPoseSince = nil; badLuxSince = nil; thermalPause = false; storagePause = false
        targetAlong = nil; targetCoord = nil; targetIsGap = false
        // Step 1 is always: walk to the start point. Fresh walk = the route start (MSC);
        // resume = the first stretch that still needs data. Nothing records until you're there.
        resumed = false
        startAlong = 0
        if let first = cov.firstUncovered(), first > 0 {
            resumed = true
            startAlong = cov.start(ofBin: first)
        }
        atStart = false
        frontStallSince = nil; backStallSince = nil; batteryWarned = false
        t.jump(to: startAlong)
        setTarget(startAlong, isGap: false)
        targetText = resumed ? "Walk to the pin to pick up where data stops" : "Walk to the start pin (MSC) — recording begins there"
        coverageFraction = cov.fraction
        updateNav()
        refreshLayers(force: true)
        refreshCoverageRuns(force: true)

        capture.resetCounters()
        capture.recorder = recorder
        capture.calibration = calibration
        capture.photoInterval = photoInterval
        capture.photosPaused = false
        capture.recordVideo = recordVideo
        capture.bracketInterval = lightSnapshots ? 5 : 0
        capture.locationProvider = { [weak self] in self?.location.latest }
        capture.headingProvider = { [weak self] in
            guard let h = self?.location.latestHeading else { return nil }
            return h.trueHeading >= 0 ? h.trueHeading : h.magneticHeading
        }
        capture.motionProvider = { [weak self] in self?.motion.latest }
        capture.progressProvider = { [weak self] in self?.tracker?.progress ?? .nan }
        capture.previewHandler = { [weak self] img in self?.previewImage = img }

        location.onLocation = { [weak self] l in self?.handle(location: l) }
        location.onAuthChange = { [weak self] in
            guard let self, self.recorder != nil else { return }
            self.location.start()
        }
        location.onHeading = { [weak self] h in
            guard let self else { return }
            self.recorder?.logHeading(h)
            let v = h.trueHeading >= 0 ? h.trueHeading : h.magneticHeading
            // UI update at most 10×/s and only when it moved noticeably.
            if Date().timeIntervalSince(self.lastHeadingUI) > 0.1, abs((SessionRecorder.angleDiff(v, self.phoneHeading) ?? 99)) > 2 {
                self.lastHeadingUI = Date()
                self.phoneHeading = v
                if !self.hasPhoneHeading { self.hasPhoneHeading = true }
            }
        }
        motion.onSample = { [weak self] m in self?.recorder?.logMotion(m) }
        altimeter.onSample = { [weak self] e, alt, kpa in
            guard let rec = self?.recorder else { return }
            rec.altimeter.write([fmt(e, 3), fmt(rec.t(e), 3), fmt(alt, 3), fmt(kpa, 4)].joined(separator: ","))
        }
        altimeter.start()
        location.start()
        motion.start()

        UIApplication.shared.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        startDate = Date()
        voice.enabled = voiceOn

        capture.start { [weak self] err in
            guard let self else { return }
            self.isStarting = false
            if let err {
                self.errorMessage = err
                self.abort()
                return
            }
            self.isRunning = true
            self.captureModeText = self.capture.mode.rawValue
            self.coverage?.photosRequired = self.capture.mode == .multiCam
            self.coverageFraction = self.coverage?.fraction ?? 0
            self.collectingSince = Date()
            self.freeGB = StorageInfo.freeGB()
            self.recorder?.update(meta: [
                "capture_mode": self.capture.mode.rawValue,
                "front_format": self.capture.frontFormatDesc,
                "back_format": self.capture.backFormatDesc,
                "multicam_hardware_cost": Double(self.capture.hardwareCost),
                "record_video": self.recordVideo,
                "light_snapshot_interval_s": self.lightSnapshots ? 5 : 0,
            ])
            self.recorder?.logEvent("start", detail: "walker \(route.id) \(route.name)", location: self.location.latest)
            self.timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
            self.uploadTimer?.invalidate()
            // Every recording path (fresh start and Resume) comes through here, so every walk uploads every 5 min.
            let up = Timer(timeInterval: Self.uploadInterval, repeats: true) { [weak self] _ in self?.uploadNew() }
            RunLoop.main.add(up, forMode: .common)   // keeps firing while the map is being dragged
            self.uploadTimer = up
            if self.resumed {
                self.voice.say(String(format: "%.0f percent already collected. Walk to the red pin. Recording starts when you get there.", self.coverageFraction * 100))
            } else {
                self.voice.say("Walk to the start pin. Recording starts when you get there.")
            }
        }
    }

    private func abort() {
        uploadTimer?.invalidate(); uploadTimer = nil
        coverage?.save(force: true)
        location.stop(); motion.stop(); altimeter.stop()
        recorder?.finish(extra: ["aborted": true])
        recorder = nil
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func stop() {
        guard isRunning else { return }
        timer?.invalidate(); timer = nil
        uploadTimer?.invalidate(); uploadTimer = nil
        let rec = recorder
        rec?.logEvent("stop", location: location.latest, lux: lux)
        let photos = capture.photoCount
        let skipped = capture.skippedPhotos
        let prog = progress
        let total = route?.total ?? 0
        let dur = Date().timeIntervalSince(startDate)
        coverage?.save(force: true)
        let covPct = (coverage?.fraction ?? 0) * 100
        let gaps = gapCount
        capture.stop { [weak self] in
            guard let self else { return }
            self.location.stop()
            self.motion.stop()
            self.altimeter.stop()
            rec?.finish(extra: ["light_snapshots": self.capture.bracketCount, "photos": photos, "photos_skipped_busy": skipped, "route_progress_m": prog,
                                "route_completed_pct": total > 0 ? prog / total * 100 : 0,
                                "duration_s": dur, "marks": self.marks,
                                "walker_coverage_pct": covPct, "gaps_behind": gaps])
            if let dir = rec?.dir {
                UploadManager.shared.uploadNew(sessionDir: dir, walker: self.selectedRouteID)
            }
            self.capture.recorder = nil
            self.collecting = false
            self.capture.previewHandler = nil
            self.previewImage = nil
            self.recorder = nil
            self.lastSessionURL = rec?.dir
            self.isRunning = false
            UIApplication.shared.isIdleTimerDisabled = false
            let mins = Int(dur / 60)
            var text = "\(mins) min · \(photos) photos · \(self.marks) marks\n"
            text += "Walker \(self.selectedRouteID): \(Int(covPct.rounded()))% of the route has data"
            if gaps > 0 { text += " · \(gaps) gap(s) to redo" }
            text += ". Tap Resume later to finish — nothing is lost."
            self.summaryText = text
            self.coverage = nil
            self.coverageRuns = []
            self.alerts = []
            self.targetCoord = nil
            self.refreshWalkerStats()
            self.showSummary = true
        }
    }

    // MARK: - Updates

    private func handle(location l: CLLocation) {
        guard let tracker else { return }
        let prevStep = stepIndex
        let acc = l.horizontalAccuracy
        userCoord = l.coordinate
        if l.course >= 0 && l.speed > 0.6 { travelHeading = l.course }
        else if phoneHeading >= 0 { travelHeading = phoneHeading }
        locationTick &+= 1
        if acc >= 0 && acc <= 65 {
            if atStart { tracker.update(location: l) }
            hasFix = true
            lastFixDate = Date()
        }
        if !atStart {
            let sc = tracker.coordinate(at: startAlong)
            distToStart = l.distance(from: CLLocation(latitude: sc.latitude, longitude: sc.longitude))
            if hasFix, acc <= 30, distToStart <= Self.startRadius { arriveAtStart() }
        }
        updateNav()

        // Where are we relative to the whole route (not just the next turn)?
        let near = tracker.nearby(l.coordinate, radius: Self.creditRadius)
        let nearAll = tracker.nearby(l.coordinate, radius: 0)
        onRoute = hasFix && acc >= 0 && acc <= 65 && nearAll.minDist <= Self.onRouteMax
        distFromRoute = nearAll.minDist
        fastFixes = l.speed > 2.3 ? fastFixes + 1 : 0
        updateCollecting()

        // Credit every 10 m piece of route within reach with this second's data.
        if collecting, acc >= 0, acc <= Self.goodAccuracy, let cov = coverage {
            var bins = Set<Int>()
            for h in near.hits {
                let a = cov.bin(at: h.along - h.halfWidth), b = cov.bin(at: h.along + h.halfWidth)
                for i in a...max(a, b) { bins.insert(i) }
            }
            let now = Date().timeIntervalSince1970
            var luxOK = false
            if let s = capture.latest, s.lux.isFinite, s.lux >= 0, now - s.epoch < 1.5 { luxOK = true }
            let pc = capture.photoCount
            let photoOK = pc > lastCreditedPhotos
            if photoOK { lastCreditedPhotos = pc }
            if !bins.isEmpty, cov.credit(bins, lux: luxOK, photo: photoOK) > 0 {
                coverageChanged = true
                coverageFraction = cov.fraction
            }
        }
        if atStart { checkGapsAndTarget(l) } else { distToTarget = distToStart }
        let ph = location.latestHeading.map { $0.trueHeading >= 0 ? $0.trueHeading : $0.magneticHeading }
        recorder?.logLocation(l, progress: tracker.progress, distFromRoute: tracker.distanceFromRoute, step: stepIndex + 1,
                              phoneHeading: ph, routeBearing: tracker.bearing(at: tracker.progress), recording: collecting)
        if stepIndex != prevStep, let s = currentStep {
            recorder?.logEvent("step", detail: "\(s.i): \(s.txt)", location: l)
        }
    }

    private func updateNav() {
        guard let tracker else { return }
        progress = tracker.progress
        var k = 0
        for (j, s) in steps.enumerated() where s.at <= progress + 6 { k = j }
        stepIndex = k
        distToNext = nextStep.map { max(0, $0.at - progress) } ?? 0
        distFromRoute = tracker.distanceFromRoute
        refreshLayers()

        guard let n = nextStep else { return }
        if distToNext <= 45, distToNext > 18, (currentStep?.L ?? 0) > 70, !announcedFar.contains(n.i) {
            announcedFar.insert(n.i)
            voice.say("In \(Int((distToNext / 5).rounded()) * 5) meters, \(spoken(n.txt))")
        }
        if distToNext <= 12, !announcedNear.contains(n.i) {
            announcedNear.insert(n.i)
            voice.say(spoken(n.txt))
        }
    }

    /// Next-leg halo for the map. At most once a second (or right away on a new step), and only
    /// published when the line really changed: every change re-renders the map's content.
    private func refreshLayers(force: Bool = false) {
        guard let tracker else { return }
        let stepChanged = stepIndex != lastLayerStep
        if !force && !stepChanged {
            if abs(tracker.progress - lastLayerProgress) < 3 { return }
            if Date().timeIntervalSince(lastLayerDate) < 1.0 { return }
        }
        lastLayerProgress = tracker.progress
        lastLayerDate = Date()
        lastLayerStep = stepIndex
        let end = nextStep?.at ?? (route?.total ?? 0)
        let l = tracker.layers(currentEnd: end)
        layerDone = l.done; layerRemaining = l.remaining
        if !Self.sameCoords(layerCurrent, l.current) { layerCurrent = l.current }
    }

    static func sameCoords(_ a: [CLLocationCoordinate2D], _ b: [CLLocationCoordinate2D]) -> Bool {
        guard a.count == b.count else { return false }
        for i in a.indices where a[i].latitude != b[i].latitude || a[i].longitude != b[i].longitude { return false }
        return true
    }

    static func sameRuns(_ a: [CoverageRun], _ b: [CoverageRun]) -> Bool {
        guard a.count == b.count else { return false }
        for i in a.indices {
            if a[i].id != b[i].id || a[i].state != b[i].state || !sameCoords(a[i].coords, b[i].coords) { return false }
        }
        return true
    }

    private func tick() {
        tickCount += 1
        elapsed = Date().timeIntervalSince(startDate)
        // Data safety: push buffered rows to disk every 2 s, coverage every 5 s.
        if tickCount % 8 == 0 { recorder?.flushAll() }
        if tickCount % 20 == 0 { coverage?.save() }
        if tickCount % 120 == 0 { freeGB = StorageInfo.freeGB() }
        if tickCount % 8 == 0 { sendLive() }   // every 2 s
        if tickCount % 4 == 0 {
            updateCollecting()
            refreshCoverageRuns()
            updateAlerts()
        }
        if let s = capture.latest, s.lux.isFinite {
            luxSmooth = luxSmooth.isFinite ? luxSmooth * 0.75 + s.lux * 0.25 : s.lux
            lux = luxSmooth
            rawLux = s.rawLux
            exposureText = String(format: "1/%.0f s · ISO %.0f · f/%.1f", 1 / max(s.exposure, 1e-6), s.iso, s.fNumber)
        }
        // (@Observable notifies on every assignment, even of the same value: only write changes.)
        let pc = capture.photoCount
        if pc != photoCount { photoCount = pc }
        let acc = location.latest?.horizontalAccuracy ?? -1
        if acc != gpsAccuracy { gpsAccuracy = acc }
        let bat = UIDevice.current.batteryLevel
        if bat != batteryLevel { batteryLevel = bat }

        // Heat protection: two cameras + GPS for 2 hours gets warm.
        let th = ProcessInfo.processInfo.thermalState
        if th != lastThermal {
            lastThermal = th
            switch th {
            case .serious:
                thermalPause = false
                capture.photoInterval = max(photoInterval, 2)
                thermalText = "Phone is hot — photos slowed to every 2 s"
            case .critical:
                thermalPause = true
                thermalText = "Phone is very hot — photos paused. Take it out of your pocket / shade it."
            default:
                thermalPause = false
                capture.photoInterval = photoInterval
                thermalText = ""
            }
            capture.photosPaused = thermalPause || storagePause
            recorder?.logEvent("thermal", detail: "\(th.rawValue)", location: location.latest)
        }
    }

    // MARK: - Recording gate

    /// Record only while: walk running, app on screen, GPS fix, and within 20 m of the route.
    private func updateCollecting() {
        guard isRunning || isStarting else { return }
        let fixFresh = Date().timeIntervalSince(lastFixDate) < 10
        let should = isRunning && appActive && atStart && hasFix && fixFresh && onRoute
        let acc = location.latest?.horizontalAccuracy ?? -1
        let status: String
        if !atStart { status = "Walk to the start — \(Int(distToStart)) m" }
        else if !appActive { status = "Paused — app not on screen" }
        else if !hasFix || !fixFresh { status = "Paused — waiting for GPS" }
        else if !onRoute { status = "Paused — off route" }
        else if acc > Self.goodAccuracy { status = "Recording · weak GPS" }
        else { status = "Recording" }
        collectStatus = status
        offRoute = hasFix && !onRoute
        if should != collecting {
            collecting = should
            capture.collecting = should
            if should { collectingSince = Date() }
            recorder?.logEvent(should ? "collect_on" : "collect_off", detail: status, location: location.latest)
        }
    }

    private func arriveAtStart() {
        guard !atStart, let tracker else { return }
        atStart = true
        tracker.jump(to: startAlong)
        setTarget(nil, isGap: false)
        recorder?.logEvent("at_start", detail: String(format: "%.0f m along", startAlong), location: location.latest)
        voice.say("You're at the start. Recording now. Follow the line.")
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        updateNav()
        refreshCoverageRuns(force: true)
        updateCollecting()
    }

    /// Manual override if GPS won't settle at the start point.
    func startHere() { arriveAtStart() }

    /// Called from the app when it goes to the background / comes back.
    func setAppActive(_ active: Bool) {
        guard active != appActive else { return }
        appActive = active
        guard isRunning else { return }
        if !active {
            recorder?.logEvent("app_background", location: location.latest)
            recorder?.flushAll()
            coverage?.save(force: true)
        } else {
            recorder?.logEvent("app_foreground", location: location.latest)
            capture.restartIfNeeded()
            voice.say("Back in the app. Recording resumes on the route.")
        }
        updateCollecting()
    }

    // MARK: - Gaps & guidance target

    private func setTarget(_ along: Double?, isGap: Bool) {
        targetAlong = along
        targetIsGap = isGap
        if let along, let tracker {
            targetCoord = tracker.coordinate(at: along)
            targetText = isGap ? "Missing data — walk back to the red pin" : "Next spot to record — walk to the pin"
        } else {
            targetCoord = nil
            targetText = ""
        }
    }

    /// Point the walker at the most recent stretch that was walked but didn't get data.
    func guideToGap() {
        guard let cov = coverage else { return }
        let behind = cov.bin(at: max(0, progress - 25))
        guard let g = cov.gaps(before: behind).last else { return }
        setTarget(cov.start(ofBin: g.lowerBound) + CoverageStore.binSize / 2, isGap: true)
        recorder?.logEvent("guide_to_gap", detail: "bin \(g.lowerBound)-\(g.upperBound)", location: location.latest)
        voice.say("Go back to the red pin to re-record the missing stretch.")
    }

    private func checkGapsAndTarget(_ l: CLLocation) {
        guard let cov = coverage else { return }
        let behind = cov.bin(at: max(0, progress - 25))
        let gaps = cov.gaps(before: behind)
        gapCount = gaps.count
        gapMeters = Double(gaps.reduce(0) { $0 + $1.count }) * CoverageStore.binSize
        // New gap of 20 m or more just fell behind: speak up once.
        if let g = gaps.last, g.count >= 2, !announcedGaps.contains(g.lowerBound) {
            announcedGaps.insert(g.lowerBound)
            recorder?.logEvent("gap_detected", detail: "bins \(g.lowerBound)-\(g.upperBound)", location: l)
            voice.say("Missed about \(g.count * 10) meters of data behind you. Tap guide me back, or redo it later.")
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        if let along = targetAlong, let tc = targetCoord {
            distToTarget = l.distance(from: CLLocation(latitude: tc.latitude, longitude: tc.longitude))
            let filled = !cov.needsData(at: along)
            if (targetIsGap && filled) || (!targetIsGap && (distToTarget < 20 || filled)) {
                if targetIsGap { voice.say("Gap filled. Continue the route.") }
                setTarget(nil, isGap: false)
            }
        }
        if cov.firstUncovered() == nil, !completeAnnounced {
            completeAnnounced = true
            voice.say("Route complete. Every part of your route has data. You can end the walk.")
            recorder?.logEvent("route_complete", location: l)
        }
    }

    // MARK: - Map colouring

    private func refreshCoverageRuns(force: Bool = false) {
        guard let cov = coverage, let tracker, let total = route?.total else { return }
        let behind = cov.bin(at: max(0, progress - 25))
        if !force, !coverageChanged, behind == lastRunsBehindBin { return }
        if !force, Date().timeIntervalSince(lastRunsBuild) < 1.5 { return }
        lastRunsBuild = Date(); lastRunsBehindBin = behind; coverageChanged = false
        func state(_ i: Int) -> CoverageRun.State {
            cov.isCovered(i) ? .done : (i < behind ? .missed : .todo)
        }
        var runs: [CoverageRun] = []
        // The whole route is drawn.
        let range: ClosedRange<Double> = 0...total
        let lastBin = min(cov.count - 1, cov.bin(at: max(range.upperBound - 0.01, 0)))
        var i = cov.bin(at: range.lowerBound)
        while i <= lastBin {
            let st = state(i)
            var j = i
            while j + 1 <= lastBin && state(j + 1) == st { j += 1 }
            let c = tracker.slice(from: max(cov.start(ofBin: i), range.lowerBound), to: min(cov.start(ofBin: j + 1), range.upperBound, total))
            if c.count > 1 { runs.append(CoverageRun(id: i, state: st, coords: c)) }
            i = j + 1
        }
        // Publish only real changes: each new value redraws every coverage line on the map.
        if !Self.sameRuns(coverageRuns, runs) { coverageRuns = runs }
    }

    // MARK: - Background upload (every 5 min + at End)

    /// Queue everything captured since the last upload. Runs every 5 minutes while recording.
    private func uploadNew() {
        guard isRunning, let rec = recorder else { return }
        rec.flushAll()
        coverage?.save(force: true)
        let dir = rec.dir, w = selectedRouteID
        rec.logEvent("upload_chunk", location: location.latest)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            UploadManager.shared.uploadNew(sessionDir: dir, walker: w)
        }
    }

    // MARK: - Problem detection

    /// At most ONE banner at a time, and only for things you actually need to act on.
    /// Minor issues (weak GPS etc.) only change the small status chip.
    private func updateAlerts() {
        guard isRunning else { return }
        let now = Date()
        let nowE = now.timeIntervalSince1970
        var a: [SurveyAlert] = []

        // Cameras: only complain if frames have truly stopped arriving for a while.
        let warm = now.timeIntervalSince(collectingSince) > 5
        if collecting, warm, nowE - capture.lastFrontEpoch > 4 {
            frontStallSince = frontStallSince ?? now
        } else { frontStallSince = nil }
        if capture.mode == .multiCam, collecting, warm, nowE - capture.lastBackEpoch > 4 {
            backStallSince = backStallSince ?? now
        } else { backStallSince = nil }
        if let since = frontStallSince ?? backStallSince {
            autoRestart()
            if now.timeIntervalSince(since) > 8 {
                a.append(.init(id: "camera", level: .bad, icon: "camera.badge.ellipsis",
                               text: "Camera stopped — tap Retry. Data so far is saved.", action: .retryCamera))
            }
        }
        if capture.interrupted {
            a.append(.init(id: "interrupt", level: .bad, icon: "video.slash", text: "Camera paused by iOS (call / Control Center) — resumes on its own."))
        }
        if let s = capture.latest, nowE - s.epoch < 2 {
            badLuxSince = s.lux.isFinite ? nil : (badLuxSince ?? now)
        }
        if let since = badLuxSince, now.timeIntervalSince(since) > 8 {
            a.append(.init(id: "luxbad", level: .bad, icon: "exclamationmark.triangle", text: "No light reading — check the paper over the front camera."))
        }

        // Route
        if atStart {
            if !hasFix || now.timeIntervalSince(lastFixDate) > 15 {
                a.append(.init(id: "gps", level: .bad, icon: "location.slash", text: "No GPS — not recording. Step into the open for a moment."))
            } else if !onRoute {
                a.append(.init(id: "off", level: .bad, icon: "arrow.uturn.backward", text: "Off route (\(Int(distFromRoute)) m) — not recording. Go back to the line."))
            }
            if gapCount > 0, gapMeters >= 20 {
                a.append(.init(id: "gap", level: .warn, icon: "exclamationmark.arrow.triangle.2.circlepath",
                               text: "\(Int(gapMeters)) m behind you has no data (red).", action: .guideBack))
            }
        }

        // Power, storage, heat — only the serious cases.
        let bat = UIDevice.current.batteryLevel
        if bat >= 0 && bat <= 0.10 {
            a.append(.init(id: "bat", level: .bad, icon: "battery.0", text: "Battery \(Int(bat * 100))% — plug in, or End and Resume after charging."))
        } else if bat >= 0 && bat <= 0.20, !batteryWarned {
            batteryWarned = true
            voice.say("Battery is low. Plug in the power bank.")
        }
        let wasStoragePause = storagePause
        storagePause = freeGB >= 0 && freeGB < 0.4
        if storagePause != wasStoragePause { capture.photosPaused = thermalPause || storagePause }
        if storagePause {
            a.append(.init(id: "disk", level: .bad, icon: "externaldrive.badge.xmark", text: "Storage full — photos paused. Free up space."))
        }
        if thermalPause {
            a.append(.init(id: "heat", level: .bad, icon: "thermometer.high", text: thermalText))
        }
        if completeAnnounced {
            a.append(.init(id: "done", level: .good, icon: "checkmark.seal.fill", text: "Route complete — you can end the walk."))
        }

        a.sort { $0.level.rawValue > $1.level.rawValue }
        let top = Array(a.prefix(1))
        if top != alerts { alerts = top }

        // Speak each new serious problem once (re-arms after it clears).
        let ids = Set(a.filter { $0.level == .bad }.map { $0.id })
        for x in a where x.level == .bad && !spokenAlerts.contains(x.id) {
            voice.say(x.text.components(separatedBy: " — ").first ?? x.text)
            recorder?.logEvent("alert", detail: x.id, location: location.latest)
        }
        spokenAlerts = ids
    }

    private func autoRestart() {
        guard Date().timeIntervalSince(lastRestart) > 10 else { return }
        lastRestart = Date()
        recorder?.logEvent("camera_restart", location: location.latest)
        capture.restartIfNeeded(force: capture.restartCount < 3)
    }

    func retryCamera() {
        lastRestart = .distantPast
        guard Date().timeIntervalSince(lastRestart) > 10 else { return }
        lastRestart = Date()
        recorder?.logEvent("camera_restart_manual", location: location.latest)
        capture.restartIfNeeded(force: true)
    }

    // MARK: - Live dashboard

    private func sendLive() {
        guard isRunning, let route else { return }
        let l = location.latest
        let s = capture.latest
        func num(_ v: Double?) -> Any {
            guard let v, v.isFinite else { return NSNull() }
            return v
        }
        let payload: [String: Any] = [
            "walker": route.id,
            "device": UIDevice.current.name,
            "session": recorder?.dir.lastPathComponent ?? "",
            "t": Date().timeIntervalSince1970,
            "lat": num(l?.coordinate.latitude),
            "lon": num(l?.coordinate.longitude),
            "acc": num(l?.horizontalAccuracy),
            "heading": num(phoneHeading >= 0 ? phoneHeading : nil),
            "lux": num(s?.lux),
            "collecting": collecting,
            "status": collectStatus,
            "atStart": atStart,
            "coverage": coverageFraction,
            "part": NSNull(),
            "partCoverage": NSNull(),
            "progress_m": progress,
            "gaps": gapCount,
            "gap_m": gapMeters,
            "photos": capture.photoCount,
            "snapshots": capture.bracketCount,
            "battery": Double(UIDevice.current.batteryLevel),
            "thermal": ProcessInfo.processInfo.thermalState.rawValue,
            "freeGB": num(freeGB),
            "cameraRestarts": capture.restartCount,
            "cameraMode": capture.mode.rawValue,
            "alerts": alerts.map { $0.id + ": " + $0.text },
            "elapsed_s": elapsed,
            "uploadPending": uploadPending,
            "uploadDone": uploadDone,
            "uploadParts": NSNull(),
            "uploadError": uploadError,
        ]
        live.send(payload) { [weak self] ok in
            guard let self else { return }
            self.liveOK = ok
            self.liveStatus = self.live.lastResult
        }
    }

    // MARK: - Actions

    func mark(_ tag: String) {
        recorder?.logEvent("mark", detail: tag, location: location.latest, lux: lux)
        marks += 1
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// Manual step change when GPS is unreliable.
    func jumpStep(_ delta: Int) {
        guard let tracker, !steps.isEmpty else { return }
        let target = min(max(stepIndex + delta, 0), steps.count - 1)
        tracker.jump(to: steps[target].at + 1)
        recorder?.logEvent("manual_step", detail: "to \(target + 1)", location: location.latest)
        updateNav()
        refreshLayers(force: true)
    }

    func setVoice(_ on: Bool) {
        voiceOn = on
        voice.enabled = on
    }

    func spoken(_ txt: String) -> String {
        txt.replacingOccurrences(of: "&", with: "and")
    }
}
