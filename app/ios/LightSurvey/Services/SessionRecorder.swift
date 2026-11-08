import Foundation
import CoreLocation
import UIKit

/// Buffered, thread-safe CSV file writer.
final class CSVWriter {
    private let handle: FileHandle
    private let queue: DispatchQueue
    private var buffer = Data()
    private var closed = false

    init?(url: URL, header: String) {
        FileManager.default.createFile(atPath: url.path, contents: (header + "\n").data(using: .utf8))
        guard let h = try? FileHandle(forWritingTo: url) else { return nil }
        h.seekToEndOfFile()
        handle = h
        queue = DispatchQueue(label: "csv." + url.lastPathComponent)
    }

    func write(_ line: String) {
        queue.async {
            guard !self.closed else { return }
            self.buffer.append(contentsOf: Array((line + "\n").utf8))
            if self.buffer.count > 32_768 { self.flushNow() }
        }
    }

    func flush() { queue.async { self.flushNow() } }

    private func flushNow() {
        guard !buffer.isEmpty, !closed else { return }
        try? handle.write(contentsOf: buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    func close() {
        queue.sync {
            self.flushNow()
            try? self.handle.synchronize()
            try? self.handle.close()
            self.closed = true
        }
    }
}

/// Formats a number for CSV; empty for nil / NaN / infinite.
@inline(__always) func fmt(_ v: Double?, _ digits: Int = 3) -> String {
    guard let v, v.isFinite else { return "" }
    return String(format: "%.\(digits)f", v)
}

/// One recording = one folder in Documents/Sessions that the Files app can browse.
///
/// Sessions/W1_2026-11-07_2105/
///   session.json    device, route, settings, start/end, capture formats
///   lux.csv         every front-camera frame (~15/s): lux + raw exposure data
///   gps.csv         every GPS fix (~1/s) + route progress
///   heading.csv     compass
///   motion.csv      phone orientation (10/s)
///   photos.csv      one row per time-lapse photo: file, time, GPS, exposure, intrinsics, orientation
///   events.csv      marks you tap (light out, very dark...), off-route, thermal, step changes
///   photos/IMG_000001.jpg ...  (with EXIF GPS + exposure)
///   frames.csv      one row per back-camera video frame (pose, exposure, intrinsics)
///   video/back_000.mov ...  continuous back-camera video (HEVC, 10-min segments)
///   altimeter.csv   barometric relative altitude
///   brackets.csv + lights/BRK_000001.jpg …  short-exposure "light snapshots" every 5 s for locating/classifying light sources
final class SessionRecorder {
    let dir: URL
    let photosDir: URL
    let startEpoch: Double
    let routeID: Int

    let lux: CSVWriter
    let gps: CSVWriter
    let heading: CSVWriter
    let motion: CSVWriter
    let photos: CSVWriter
    let events: CSVWriter
    let frames: CSVWriter
    let altimeter: CSVWriter
    let videoDir: URL
    let lightsDir: URL
    let brackets: CSVWriter

    private var meta: [String: Any]
    private let metaLock = NSLock()

    static var sessionsRoot: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("Sessions", isDirectory: true)
    }

    init(route: SurveyRoute, calibration: Double, photoInterval: Double) throws {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "yyyy-MM-dd_HHmmss"
        let now = Date()
        startEpoch = now.timeIntervalSince1970
        routeID = route.id
        let sessionDir = SessionRecorder.sessionsRoot.appendingPathComponent("W\(route.id)_\(df.string(from: now))", isDirectory: true)
        dir = sessionDir
        photosDir = sessionDir.appendingPathComponent("photos", isDirectory: true)
        videoDir = sessionDir.appendingPathComponent("video", isDirectory: true)
        lightsDir = sessionDir.appendingPathComponent("lights", isDirectory: true)
        try FileManager.default.createDirectory(at: photosDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: lightsDir, withIntermediateDirectories: true)

        func w(_ name: String, _ header: String) throws -> CSVWriter {
            guard let c = CSVWriter(url: sessionDir.appendingPathComponent(name), header: header) else {
                throw NSError(domain: "LightSurvey", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create \(name)"])
            }
            return c
        }
        lux = try w("lux.csv", "epoch,t,lux,raw_lux,exposure_s,iso,f_number,brightness_value,mean_y,linear_y,clip_frac,wb_temp_k,wb_tint,lat,lon,h_acc,pitch_deg,roll_deg,yaw_deg")
        gps = try w("gps.csv", "epoch,t,lat,lon,alt_m,h_acc,v_acc,speed_mps,course_deg,floor,route_progress_m,dist_from_route_m,step,phone_heading_deg,route_bearing_deg,facing_vs_route_deg,walk_vs_route_deg,facing_vs_walk_deg,walking,recording")
        heading = try w("heading.csv", "epoch,t,true_heading,magnetic_heading,accuracy")
        motion = try w("motion.csv", "epoch,t,qw,qx,qy,qz,pitch_deg,roll_deg,yaw_deg,grav_x,grav_y,grav_z,user_acc_x,user_acc_y,user_acc_z")
        photos = try w("photos.csv", "index,file,epoch,t,lat,lon,alt_m,h_acc,v_acc,speed_mps,course_deg,heading_deg,exposure_s,iso,f_number,brightness_value,focal_mm,fx_px,fy_px,cx_px,cy_px,width,height,exif_orientation,qw,qx,qy,qz,pitch_deg,roll_deg,yaw_deg,mean_y,linear_y,scene_ev100,route_progress_m")
        events = try w("events.csv", "epoch,t,type,detail,lat,lon,h_acc,lux")
        frames = try w("frames.csv", "segment,frame,pts_s,epoch,t,lat,lon,h_acc,heading_deg,exposure_s,iso,f_number,brightness_value,lens_position,fx_px,fy_px,cx_px,cy_px,width,height,qw,qx,qy,qz,pitch_deg,roll_deg,yaw_deg,mean_y,clip_frac,scene_ev100,route_progress_m,bracket")
        brackets = try w("brackets.csv", "index,file,epoch,t,lat,lon,h_acc,heading_deg,exposure_s,iso,f_number,fx_px,fy_px,cx_px,cy_px,width,height,qw,qx,qy,qz,pitch_deg,roll_deg,yaw_deg,mean_y,clip_frac,route_progress_m")
        altimeter = try w("altimeter.csv", "epoch,t,relative_altitude_m,pressure_kpa")

        let device = UIDevice.current
        meta = [
            "app": "LightSurvey 1.0",
            "walker": route.id,
            "route_name": route.name,
            "route_length_m": route.total,
            "start_iso": ISO8601DateFormatter().string(from: now),
            "start_epoch": startEpoch,
            "device_model": SessionRecorder.modelIdentifier(),
            "device_name": device.name,
            "ios": device.systemVersion,
            "calibration_factor": calibration,
            "lux_formula": "lux = calibration * K * N^2 / (t * ISO) * (linear_y / y_ref), K=250, y_ref=0.18 (front camera, diffuser)",
            "photo_interval_s": photoInterval,
            "photo_exif_orientation_note": "6 = rotate 90° clockwise for portrait display; intrinsics in photos.csv are in the unrotated sensor frame",
            "time_note": "epoch = Unix seconds (UTC); t = seconds since session start",
            "status": "recording",
        ]
        writeMeta()
    }

    func t(_ epoch: Double) -> Double { epoch - startEpoch }

    func update(meta extra: [String: Any]) {
        metaLock.lock(); for (k, v) in extra { meta[k] = v }; metaLock.unlock()
        writeMeta()
    }

    private func writeMeta() {
        metaLock.lock(); let m = meta; metaLock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: m, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("session.json"), options: .atomic)
        }
    }

    // MARK: - logging helpers

    /// Signed difference a − b folded into −180…180.
    static func angleDiff(_ a: Double?, _ b: Double?) -> Double? {
        guard let a, let b else { return nil }
        var d = (a - b).truncatingRemainder(dividingBy: 360)
        if d > 180 { d -= 360 }
        if d < -180 { d += 360 }
        return d
    }

    /// One GPS fix plus which way the phone faced and which way the walker moved, both
    /// relative to the direction the route runs (so walking a stretch backwards, or facing
    /// backwards while walking, is visible in the data).
    func logLocation(_ l: CLLocation, progress: Double, distFromRoute: Double, step: Int,
                     phoneHeading: Double?, routeBearing: Double?, recording: Bool) {
        let e = l.timestamp.timeIntervalSince1970
        let course: Double? = (l.course >= 0 && l.speed > 0.4) ? l.course : nil
        let facingVsRoute = SessionRecorder.angleDiff(phoneHeading, routeBearing)
        let walkVsRoute = SessionRecorder.angleDiff(course, routeBearing)
        let facingVsWalk = SessionRecorder.angleDiff(phoneHeading, course)
        var walking = "stopped"
        if let w = walkVsRoute { walking = abs(w) <= 60 ? "forward" : (abs(w) >= 120 ? "backward" : "sideways") }
        gps.write([fmt(e, 3), fmt(t(e), 3), fmt(l.coordinate.latitude, 7), fmt(l.coordinate.longitude, 7),
                   fmt(l.altitude, 2), fmt(l.horizontalAccuracy, 1), fmt(l.verticalAccuracy, 1),
                   fmt(l.speed >= 0 ? l.speed : nil, 2), fmt(l.course >= 0 ? l.course : nil, 1),
                   l.floor.map { String($0.level) } ?? "", fmt(progress, 1), fmt(distFromRoute, 1), String(step),
                   fmt(phoneHeading, 1), fmt(routeBearing, 1), fmt(facingVsRoute, 1), fmt(walkVsRoute, 1), fmt(facingVsWalk, 1),
                   walking, recording ? "1" : "0"].joined(separator: ","))
    }

    func logHeading(_ h: CLHeading) {
        let e = h.timestamp.timeIntervalSince1970
        heading.write([fmt(e, 3), fmt(t(e), 3), fmt(h.trueHeading >= 0 ? h.trueHeading : nil, 1),
                       fmt(h.magneticHeading, 1), fmt(h.headingAccuracy, 1)].joined(separator: ","))
    }

    func logMotion(_ m: MotionSnapshot) {
        motion.write([fmt(m.epoch, 3), fmt(t(m.epoch), 3), fmt(m.qw, 5), fmt(m.qx, 5), fmt(m.qy, 5), fmt(m.qz, 5),
                      fmt(m.pitch, 2), fmt(m.roll, 2), fmt(m.yaw, 2), fmt(m.gx, 4), fmt(m.gy, 4), fmt(m.gz, 4),
                      fmt(m.ax, 4), fmt(m.ay, 4), fmt(m.az, 4)].joined(separator: ","))
    }

    func logEvent(_ type: String, detail: String = "", location l: CLLocation? = nil, lux: Double? = nil) {
        let e = Date().timeIntervalSince1970
        let clean = detail.replacingOccurrences(of: ",", with: ";").replacingOccurrences(of: "\n", with: " ")
        events.write([fmt(e, 3), fmt(t(e), 3), type, clean, fmt(l?.coordinate.latitude, 7), fmt(l?.coordinate.longitude, 7),
                      fmt(l?.horizontalAccuracy, 1), fmt(lux, 3)].joined(separator: ","))
    }

    /// Push buffered rows to disk (called every 2 s and when the app leaves the screen),
    /// so a crash or dead battery loses at most ~2 s of readings.
    func flushAll() {
        [lux, gps, heading, motion, photos, events, frames, altimeter, brackets].forEach { $0.flush() }
        update(meta: ["last_saved_epoch": Date().timeIntervalSince1970])
    }

    /// Sessions whose app was killed mid-walk still say "recording": label them so the data is
    /// clearly kept (everything up to the last 2-second save is on disk).
    /// Returns each such session folder with its walker number, so the tail since the last
    /// 5-minute upload can still be sent.
    static func markInterruptedSessions() -> [(dir: URL, walker: Int)] {
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: sessionsRoot, includingPropertiesForKeys: nil) else { return [] }
        var found: [(dir: URL, walker: Int)] = []
        for d in dirs {
            let url = d.appendingPathComponent("session.json")
            guard let data = try? Data(contentsOf: url),
                  var m = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (m["status"] as? String) == "recording" else { continue }
            m["status"] = "interrupted_data_kept"
            if let out = try? JSONSerialization.data(withJSONObject: m, options: [.prettyPrinted, .sortedKeys]) {
                try? out.write(to: url, options: .atomic)
                found.append((dir: d, walker: (m["walker"] as? Int) ?? 1))
            }
        }
        return found
    }

    func finish(extra: [String: Any]) {
        update(meta: extra.merging(["end_iso": ISO8601DateFormatter().string(from: Date()),
                                    "end_epoch": Date().timeIntervalSince1970,
                                    "status": "finished"]) { $1 })
        [lux, gps, heading, motion, photos, events, frames, altimeter, brackets].forEach { $0.close() }
    }

    static func modelIdentifier() -> String {
        var sys = utsname()
        uname(&sys)
        let mirror = Mirror(reflecting: sys.machine)
        return mirror.children.reduce("") { acc, el in
            guard let v = el.value as? Int8, v != 0 else { return acc }
            return acc + String(UnicodeScalar(UInt8(v)))
        }
    }
}
