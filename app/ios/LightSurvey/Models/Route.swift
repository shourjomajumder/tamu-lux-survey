import Foundation
import CoreLocation
import SwiftUI

/// One turn-by-turn instruction. `at` = metres from the start of the loop where this step begins.
struct RouteStep: Codable, Identifiable {
    let i: Int
    let txt: String
    let hint: String
    let icon: String
    let at: Double
    let L: Double
    let rep: Bool
    var id: Int { i }
}

/// A walker's loop, bundled in Resources/routes.json.
struct SurveyRoute: Codable, Identifiable {
    var id: Int
    var name: String
    var covers: String
    var color: String
    let total: Double
    let new: Double
    let pts: [[Double]]
    let cum: [Double]
    let steps: [RouteStep]
    /// Set when this route was assigned from Survey Control: the library route id it came from.
    /// Coverage for an assigned route is saved separately, so the walker's original route progress is never overwritten.
    var variant: Int?

    var swiftColor: Color { Color(hex: color) }
    var start: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: pts[0][0], longitude: pts[0][1]) }
}

enum RouteStore {
    /// Routes for this phone: the bundled loops, with any route assigned from Survey Control
    /// (cached on the phone, so it still works offline) swapped in for that walker.
    static func current() -> [SurveyRoute] {
        var rs = load()
        for (i, r) in rs.enumerated() {
            if let data = UserDefaults.standard.data(forKey: "assigned-\(r.id)"),
               let a = try? JSONDecoder().decode(SurveyRoute.self, from: data) {
                rs[i] = a
            }
        }
        return rs
    }

    /// Turn a library route into walker `w`'s route (keeps the walker number as its id).
    static func assigned(_ lib: SurveyRoute, to w: Int) -> SurveyRoute {
        var r = lib
        r.variant = lib.id
        r.id = w
        return r
    }

    static func load() -> [SurveyRoute] {
        let url = Bundle.main.url(forResource: "routes", withExtension: "json")
            ?? Bundle.main.url(forResource: "routes", withExtension: "json", subdirectory: "Resources")
        guard let url, let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONDecoder().decode([SurveyRoute].self, from: data)
        } catch {
            print("routes.json decode error: \(error)")
            return []
        }
    }
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 0xFF) / 255.0,
                  green: Double((v >> 8) & 0xFF) / 255.0,
                  blue: Double(v & 0xFF) / 255.0)
    }
}

/// Snaps GPS fixes onto the route and tracks how far along the loop the walker is.
/// Progress only moves forward and is searched in a window just ahead of the current
/// position, so out-and-back spurs (which overlap themselves) are followed in order.
final class RouteTracker {
    let route: SurveyRoute
    let coords: [CLLocationCoordinate2D]
    let cum: [Double]

    private(set) var progress: Double = 0
    private(set) var distanceFromRoute: Double = 0
    private(set) var offRouteSince: Date?
    private var lastMatch: Date?
    /// Set by the controller: true for spots on the route that still need data. Used when the
    /// walker re-joins the route somewhere unexpected (after a restart, or going back for a gap).
    var needsData: ((Double) -> Bool)?

    init(route: SurveyRoute) {
        self.route = route
        self.coords = route.pts.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) }
        self.cum = route.cum
    }

    /// Off route if no route segment has been within tolerance for 12+ seconds.
    func isOffRoute(now: Date = Date()) -> Bool {
        guard let since = offRouteSince else { return false }
        return now.timeIntervalSince(since) > 12
    }

    /// Returns (distance in metres from point to segment, metres along route of the projection).
    private func project(_ p: CLLocationCoordinate2D, seg i: Int) -> (Double, Double) {
        let a = coords[i], b = coords[i + 1]
        let mx = 111_320.0 * cos(p.latitude * .pi / 180)
        let my = 111_320.0
        let ax = (a.longitude - p.longitude) * mx, ay = (a.latitude - p.latitude) * my
        let bx = (b.longitude - p.longitude) * mx, by = (b.latitude - p.latitude) * my
        let dx = bx - ax, dy = by - ay
        let len2 = dx * dx + dy * dy
        var t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0
        t = min(max(t, 0), 1)
        let px = ax + t * dx, py = ay + t * dy
        let along = cum[i] + t * (cum[i + 1] - cum[i])
        return ((px * px + py * py).squareRoot(), along)
    }

    func update(location: CLLocation) {
        let now = location.timestamp
        // Search window: a little behind, and as far ahead as someone could have walked (≤3 m/s)
        // since the last fix that matched the route.
        let sinceMatch = lastMatch.map { max(0, now.timeIntervalSince($0)) } ?? 10
        let lo = progress - 15
        let hi = progress + 40 + min(sinceMatch, 300) * 3.0

        var cands: [(dist: Double, along: Double)] = []
        if coords.count > 1 {
            for i in 0..<(coords.count - 1) {
                if cum[i + 1] < lo || cum[i] > hi { continue }
                let (d, a) = project(location.coordinate, seg: i)
                if a < lo || a > hi { continue }
                cands.append((d, a))
            }
        }
        let tol = max(30, min(max(location.horizontalAccuracy, 5) * 2.5, 70))
        guard let best = cands.min(by: { $0.dist < $1.dist }), best.dist < tol else {
            distanceFromRoute = cands.min(by: { $0.dist < $1.dist })?.dist ?? tol
            if offRouteSince == nil { offRouteSince = now }
            // Not where we expected. If they're standing on another part of the route
            // (restart, went back for a gap, skipped ahead), re-lock onto it after 6 s.
            let lost = lastMatch == nil || now.timeIntervalSince(offRouteSince ?? now) > 6
            if lost { relocate(location.coordinate, tol: min(tol, 35), now: now) }
            return
        }
        // Several segments can be about equally close (e.g. both directions of a spur):
        // take the earliest one along the route.
        let chosen = cands.filter { $0.dist <= best.dist + 8 }.min(by: { $0.along < $1.along }) ?? best
        distanceFromRoute = chosen.dist
        offRouteSince = nil
        lastMatch = now
        if chosen.along > progress { progress = chosen.along }
    }

    /// Search the whole route; jump to the earliest nearby spot that still needs data,
    /// otherwise the earliest nearby spot. Progress may move backwards here.
    private func relocate(_ p: CLLocationCoordinate2D, tol: Double, now: Date) {
        let near = nearby(p, radius: tol)
        guard !near.hits.isEmpty else { return }
        let alongs = near.hits.map { $0.along }
        let pick = alongs.filter { needsData?($0) ?? false }.min() ?? alongs.min()!
        progress = pick
        distanceFromRoute = near.minDist
        offRouteSince = nil
        lastMatch = now
    }

    /// Every part of the route within `radius` metres of p (one hit per segment), plus the
    /// distance to the closest point of the whole route.
    func nearby(_ p: CLLocationCoordinate2D, radius: Double) -> (minDist: Double, hits: [(dist: Double, along: Double, halfWidth: Double)]) {
        var minDist = Double.infinity
        var hits: [(dist: Double, along: Double, halfWidth: Double)] = []
        guard coords.count > 1 else { return (minDist, hits) }
        for i in 0..<(coords.count - 1) {
            let (d, a) = project(p, seg: i)
            minDist = min(minDist, d)
            if d <= radius {
                let half = (radius * radius - d * d).squareRoot()
                hits.append((d, a, half))
            }
        }
        return (minDist, hits)
    }

    /// Route coordinates between two distances along the loop.
    func slice(from s0: Double, to s1: Double) -> [CLLocationCoordinate2D] {
        guard coords.count > 1, s1 > s0 else { return [] }
        let a = point(at: s0), b = point(at: s1)
        var out = [a.coord]
        if b.index > a.index { out += coords[(a.index + 1)...b.index] }
        out.append(b.coord)
        return out
    }

    func coordinate(at s: Double) -> CLLocationCoordinate2D { point(at: s).coord }

    /// Compass direction (0 = north, clockwise) the route runs at distance s.
    func bearing(at s: Double) -> Double {
        guard coords.count > 1 else { return 0 }
        let i = min(point(at: s).index, coords.count - 2)
        let a = coords[i], b = coords[i + 1]
        let dx = (b.longitude - a.longitude) * cos(a.latitude * .pi / 180)
        let dy = b.latitude - a.latitude
        let deg = atan2(dx, dy) * 180 / .pi
        return deg < 0 ? deg + 360 : deg
    }

    /// Manual override (GPS trouble): put progress at a given distance.
    func jump(to at: Double) {
        progress = max(0, min(at, cum.last ?? 0))
        offRouteSince = nil
        lastMatch = Date()
    }

    /// Coordinates split at the walker's progress (done / remaining) plus the current leg.
    func layers(currentEnd: Double) -> (done: [CLLocationCoordinate2D], remaining: [CLLocationCoordinate2D], current: [CLLocationCoordinate2D]) {
        let split = point(at: progress)
        var done = Array(coords[0...split.index])
        done.append(split.coord)
        var remaining = [split.coord]
        if split.index + 1 < coords.count { remaining += coords[(split.index + 1)...] }
        let end = point(at: currentEnd)
        var current = [split.coord]
        if end.index > split.index { current += coords[(split.index + 1)...end.index] }
        current.append(end.coord)
        return (done, remaining, current)
    }

    private func point(at s: Double) -> (index: Int, coord: CLLocationCoordinate2D) {
        guard coords.count > 1 else { return (0, coords.first ?? CLLocationCoordinate2D()) }
        var lo = 0, hi = coords.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if cum[mid] <= s { lo = mid } else { hi = mid }
        }
        let i = min(lo, coords.count - 2)
        let segLen = cum[i + 1] - cum[i]
        let t = segLen > 0 ? min(max((s - cum[i]) / segLen, 0), 1) : 0
        let a = coords[i], b = coords[i + 1]
        return (i, CLLocationCoordinate2D(latitude: a.latitude + (b.latitude - a.latitude) * t,
                                          longitude: a.longitude + (b.longitude - a.longitude) * t))
    }
}
