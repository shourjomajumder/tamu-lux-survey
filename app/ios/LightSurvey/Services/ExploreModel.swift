import Foundation
import CoreLocation
import MapKit
import Observation

/// State for the Explore (normal user) mode: endpoints, routes and navigation.
@MainActor
@Observable
final class ExploreModel {
    enum Field { case from, to }
    enum Sheet: Equatable { case home, search, route }

    let graph: ExploreGraph?
    let location: ExploreLocation = ExploreLocation()
    let search: ExploreSearch = ExploreSearch()

    // endpoints
    var from: ExploreEndpoint = ExploreEndpoint.myLocation
    var to: ExploreEndpoint? = nil
    var activeField: Field = .to
    var sheet: Sheet = .home

    // results
    private(set) var bestLit: ExploreRoute? = nil
    private(set) var shortest: ExploreRoute? = nil
    /// Short line under the route card ("Outside the surveyed area · routing to the nearest surveyed point").
    private(set) var notice: String? = nil
    /// Problem that stops routing ("Location off — pick a start").
    private(set) var error: String? = nil

    // navigation
    private(set) var navigator: ExploreNavigator? = nil
    var isNavigating: Bool { navigator != nil }

    init() {
        let g: ExploreGraph? = ExploreGraph.shared
        self.graph = g
        self.search.places = g?.places ?? []
    }

    // MARK: Endpoints

    func choose(_ endpoint: ExploreEndpoint, for field: Field) {
        switch field {
        case .from: from = endpoint
        case .to: to = endpoint
        }
        error = nil
    }

    func swapEndpoints() {
        guard let t = to else { return }
        let f: ExploreEndpoint = from
        from = t
        to = f
        if sheet == .route { computeRoutes() }
    }

    func clearRoute() {
        bestLit = nil
        shortest = nil
        notice = nil
        error = nil
        to = nil
        from = ExploreEndpoint.myLocation
        sheet = .home
        search.clear()
    }

    private func coordinate(of e: ExploreEndpoint) -> CLLocationCoordinate2D? {
        if e.isMyLocation { return location.usableCoordinate }
        return e.coordinate
    }

    // MARK: Routing

    /// Computes best-lit and shortest routes for the current From / To. Returns false if it could not.
    @discardableResult
    func computeRoutes() -> Bool {
        bestLit = nil
        shortest = nil
        notice = nil
        error = nil
        guard let g = graph else { error = "No map data"; return false }
        guard let toEnd = to else { return false }
        guard let a = coordinate(of: from) else {
            if from.isMyLocation {
                error = location.isDenied ? "Location off · choose a start" : "Finding your location…"
            }
            return false
        }
        guard let b = coordinate(of: toEnd) else {
            error = location.isDenied ? "Location off · choose an end" : "Finding your location…"
            return false
        }
        guard let pair = g.snapPair(a, b) else { error = "No route"; return false }
        let destName: String = toEnd.isMyLocation ? "your location" : toEnd.title
        let lit: ExploreRoute? = g.route(kind: .bestLit, from: pair.0, to: pair.1, start: a, end: b, destinationName: destName)
        let short: ExploreRoute? = g.route(kind: .shortest, from: pair.0, to: pair.1, start: a, end: b, destinationName: destName)
        guard let l = lit else { error = "Not connected"; return false }
        bestLit = l
        // only offer the shortest as an alternative when it is actually a different line
        if let s = short, abs(s.length - l.length) > 5 || s.summary.shareBelowGuide != l.summary.shareBelowGuide {
            shortest = s
        }
        var bits: [String] = []
        if pair.0.isOutside { bits.append("Start outside the surveyed area") }
        if pair.1.isOutside { bits.append("End outside the surveyed area") }
        if !bits.isEmpty { notice = bits.joined(separator: " · ") + " · routing to the nearest surveyed point" }
        return true
    }

    // MARK: Navigation

    func startNavigation() {
        guard let r = bestLit else { return }
        location.start()
        location.setNavigating(true)
        let dest: CLLocationCoordinate2D? = to.flatMap { coordinate(of: $0) }
        navigator = ExploreNavigator(route: r, destination: dest)
    }

    func endNavigation() {
        navigator = nil
        location.setNavigating(false)
    }

    /// Feed a new GPS fix to the navigator; re-routes when it reports the walker left the route.
    func navigationFix() {
        guard let nav = navigator, let loc = location.location else { return }
        let wantsReroute: Bool = nav.update(with: loc)
        if wantsReroute { reroute(from: loc.coordinate) }
    }

    private func reroute(from c: CLLocationCoordinate2D) {
        guard let g = graph, let nav = navigator else { return }
        let target: CLLocationCoordinate2D = nav.destination ?? g.coordinate(ofNode: nav.route.destinationNode)
        guard let pair = g.snapPair(c, target) else { return }
        let destName: String = to?.title ?? ""
        guard let r = g.route(kind: .bestLit, from: pair.0, to: pair.1, start: c, end: nav.destination, destinationName: destName) else { return }
        bestLit = r
        shortest = nil
        nav.replace(route: r)
    }
}

/// Follows the walker along a route: current step, distance to the next maneuver, off-route detection.
@MainActor
@Observable
final class ExploreNavigator {
    static let offRouteDistance: Double = 25
    static let arrivalDistance: Double = 15

    private(set) var route: ExploreRoute
    let destination: CLLocationCoordinate2D?

    /// Distance walked along the route (m).
    private(set) var progress: Double = 0
    private(set) var stepIndex: Int = 0
    private(set) var distanceToManeuver: Double = 0
    private(set) var offRoute: Bool = false
    private(set) var arrived: Bool = false
    private(set) var hasFix: Bool = false
    private(set) var rerouteCount: Int = 0

    private var offCount: Int = 0
    private var lastReroute: Date = Date.distantPast

    init(route: ExploreRoute, destination: CLLocationCoordinate2D?) {
        self.route = route
        self.destination = destination
        recompute()
    }

    var remaining: Double { max(0, route.length - progress) }

    var currentStep: ExploreStep? {
        guard !route.steps.isEmpty else { return nil }
        return route.steps[min(stepIndex, route.steps.count - 1)]
    }

    /// The maneuver the walker is heading to (the step after the current leg).
    var upcomingStep: ExploreStep? {
        let i: Int = stepIndex + 1
        return i < route.steps.count ? route.steps[i] : nil
    }

    /// The maneuver after the upcoming one.
    var thenStep: ExploreStep? {
        let i: Int = stepIndex + 2
        return i < route.steps.count ? route.steps[i] : nil
    }

    /// Light on the stretch the walker is on.
    var lightHere: String {
        let i: Int = route.segmentIndex(at: progress)
        guard i < route.segmentLux.count else { return ExploreLux.label(nil) }
        return ExploreLux.label(route.segmentLux[i])
    }

    func replace(route r: ExploreRoute) {
        route = r
        progress = 0
        offRoute = false
        offCount = 0
        rerouteCount += 1
        lastReroute = Date()
        recompute()
    }

    /// Returns true when a re-route should be computed.
    func update(with loc: CLLocation) -> Bool {
        guard loc.horizontalAccuracy >= 0 else { return false }
        hasFix = true
        let p: ExploreXY = ExploreGeo.xy(loc.coordinate)
        let (along, lateral) = project(p)
        // ignore jumps backwards caused by GPS noise
        if along >= progress - 15 || lateral < 10 { progress = along }
        let accurate: Bool = loc.horizontalAccuracy <= 35
        if lateral > ExploreNavigator.offRouteDistance && accurate {
            offCount += 1
        } else if lateral <= ExploreNavigator.offRouteDistance {
            offCount = 0
        }
        offRoute = offCount >= 2
        if let d = destination {
            let dist: Double = ExploreGeo.distance(p, ExploreGeo.xy(d))
            if dist < ExploreNavigator.arrivalDistance { arrived = true }
        }
        if remaining < ExploreNavigator.arrivalDistance && lateral < ExploreNavigator.offRouteDistance { arrived = true }
        recompute()
        if offRoute && !arrived && Date().timeIntervalSince(lastReroute) > 8 {
            lastReroute = Date()
            return true
        }
        return false
    }

    private func recompute() {
        var idx: Int = 0
        for (i, s) in route.steps.enumerated() where s.startDistance <= progress + 3 {
            if s.maneuver != .arrive { idx = i }
        }
        stepIndex = idx
        let next: Double = idx + 1 < route.steps.count ? route.steps[idx + 1].startDistance : route.length
        distanceToManeuver = max(0, next - progress)
    }

    /// Distance along the route of the closest point, and the lateral distance to it.
    /// Looks near the current progress first so out-and-back routes do not jump ahead.
    private func project(_ p: ExploreXY) -> (Double, Double) {
        let pts: [ExploreXY] = route.points
        let cum: [Double] = route.cumulative
        guard pts.count >= 2 else { return (0, pts.first.map { ExploreGeo.distance($0, p) } ?? 0) }
        func best(in range: Range<Int>) -> (Double, Double) {
            var bestAlong: Double = 0
            var bestD: Double = Double.infinity
            for i in range {
                let a: ExploreXY = pts[i]
                let b: ExploreXY = pts[i + 1]
                let dx: Double = b.x - a.x
                let dy: Double = b.y - a.y
                let len2: Double = dx * dx + dy * dy
                var t: Double = 0
                if len2 > 1e-9 { t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) }
                let q: ExploreXY = ExploreXY(x: a.x + t * dx, y: a.y + t * dy)
                let d: Double = ExploreGeo.distance(p, q)
                if d < bestD {
                    bestD = d
                    bestAlong = cum[i] + t * (cum[i + 1] - cum[i])
                }
            }
            return (bestAlong, bestD)
        }
        let segCount: Int = pts.count - 1
        let lo: Int = route.segmentIndex(at: max(0, progress - 40))
        let hi: Int = min(segCount, route.segmentIndex(at: progress + 250) + 1)
        if lo < hi {
            let local: (Double, Double) = best(in: lo..<hi)
            if local.1 <= ExploreNavigator.offRouteDistance { return local }
        }
        return best(in: 0..<segCount)
    }
}
