import Foundation
import CoreLocation

// Explore mode: the measured walking network and best-lit routing.
// Mirrors the website's route planner (site/js/map.js _buildGraph / _dijkstra / _routeCompute):
//   shortest cost = length
//   best-lit cost = length * (1 + 6 * (1 - glow(lux)))
// The graph itself is pre-built by tools/make_explore_data.py with the same 2 m endpoint merge
// and 30 m dead-end bridges, so the app and the website choose the same routes.

// MARK: - Geometry (local metres around the campus origin, same as js/app.js LUX.toXY)

struct ExploreXY: Equatable {
    var x: Double
    var y: Double
}

enum ExploreGeo {
    static let lat0: Double = 30.6150
    static let lon0: Double = -96.3400
    static let metersPerDegLat: Double = 111320.0
    static let metersPerDegLon: Double = 111320.0 * cos(30.6150 * Double.pi / 180.0)

    static let campusCenter: CLLocationCoordinate2D = CLLocationCoordinate2D(latitude: 30.6150, longitude: -96.3400)

    static func xy(_ c: CLLocationCoordinate2D) -> ExploreXY {
        ExploreXY(x: (c.longitude - lon0) * metersPerDegLon, y: (c.latitude - lat0) * metersPerDegLat)
    }

    static func coordinate(_ p: ExploreXY) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat0 + p.y / metersPerDegLat, longitude: lon0 + p.x / metersPerDegLon)
    }

    static func distance(_ a: ExploreXY, _ b: ExploreXY) -> Double {
        hypot(a.x - b.x, a.y - b.y)
    }

    /// Compass bearing in degrees (0 = north, 90 = east).
    static func bearing(_ a: ExploreXY, _ b: ExploreXY) -> Double {
        let deg: Double = atan2(b.x - a.x, b.y - a.y) * 180.0 / Double.pi
        return deg < 0 ? deg + 360.0 : deg
    }

    /// Signed difference b - a in (-180, 180]; positive = clockwise (right turn).
    static func turnAngle(from a: Double, to b: Double) -> Double {
        var d: Double = (b - a).truncatingRemainder(dividingBy: 360.0)
        if d > 180.0 { d -= 360.0 }
        if d <= -180.0 { d += 360.0 }
        return d
    }

    static func cardinal(_ bearing: Double) -> String {
        let names: [String] = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
        let i: Int = Int(((bearing + 22.5) / 45.0).rounded(.down)) % 8
        return names[max(0, min(7, i))]
    }
}

// MARK: - Light wording (same as js/app.js LUX.level / fmtLux / glow)

enum ExploreLux {
    static let guide: Double = 5.0

    static func glow(_ lux: Double?) -> Double {
        guard let l = lux, l > 0.3 else { return 0 }
        return max(0, min(1, log(l / 0.3) / log(200.0)))
    }

    static func level(_ lux: Double?) -> String {
        guard let l = lux, !l.isNaN else { return "No data" }
        if l < 1 { return "Dark" }
        if l < 3 { return "Very dim" }
        if l < 5 { return "Dim" }
        if l < 10 { return "Adequate" }
        if l < 30 { return "Well lit" }
        return "Bright"
    }

    static func format(_ lux: Double?) -> String {
        guard let l = lux, !l.isNaN else { return "—" }
        return l < 10 ? String(format: "%.1f", l) : String(Int(l.rounded()))
    }

    /// "Very dim · 1.1 lux"
    static func label(_ lux: Double?) -> String {
        guard let l = lux else { return "Not measured" }
        return "\(level(l)) · \(format(l)) lux"
    }

    static func distance(_ meters: Double) -> String {
        if meters < 1000 {
            let m: Int = meters < 100 ? Int((meters / 5.0).rounded()) * 5 : Int((meters / 10.0).rounded()) * 10
            return "\(max(m, 0)) m"
        }
        return String(format: "%.1f km", meters / 1000.0)
    }

    static func minutes(_ meters: Double) -> Int {
        max(1, Int((meters / ExploreGraph.walkingSpeed / 60.0).rounded()))
    }

    static func percent(_ share: Double) -> String {
        "\(Int((share * 100.0).rounded()))%"
    }
}

// MARK: - Bundled data

struct ExploreEdge {
    let a: Int
    let b: Int
    let length: Double
    /// nil = no measurement (a bridge across a small gap in the walked network).
    let lux: Double?
    let name: String?
    let glow: Double

    var isGap: Bool { lux == nil }
    var isDark: Bool { (lux ?? 0) < ExploreLux.guide }

    func other(_ n: Int) -> Int { n == a ? b : a }
}

struct ExplorePlace: Identifiable, Hashable {
    let id: Int
    let name: String
    let kind: String
    let latitude: Double
    let longitude: Double
    /// Lower-cased, diacritic-free name for matching.
    let key: String
    let words: [String]

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }

    var kindLabel: String {
        switch kind {
        case "building": return "Building"
        case "field": return "Field"
        case "plaza": return "Plaza"
        default: return "Landmark"
        }
    }
}

private struct ExplorePathsFile: Decodable {
    let v: Int
    let lat0: Double
    let lon0: Double
    let guideLux: Double
    let names: [String]
    let nodes: [[Double]]
    let edges: [[Double]]
}

private enum ExploreBundle {
    static func url(_ name: String) -> URL? {
        Bundle.main.url(forResource: name, withExtension: "json")
            ?? Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "Explore")
            ?? Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "Resources/Explore")
    }

    static func data(_ name: String) -> Data? {
        guard let u = url(name) else { return nil }
        return try? Data(contentsOf: u)
    }

    static func rows(_ name: String) -> [[Any]] {
        guard let d = data(name),
              let obj = try? JSONSerialization.jsonObject(with: d, options: []),
              let arr = obj as? [[Any]] else { return [] }
        return arr
    }

    static func number(_ v: Any?) -> Double? {
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }
}

// MARK: - Route results

enum ExploreRouteKind {
    case bestLit, shortest
}

struct ExploreDarkSpot {
    let lux: Double
    let coordinate: CLLocationCoordinate2D
    let name: String?
}

struct ExploreRouteSummary {
    let length: Double
    let minutes: Int
    /// Length-weighted median of measured stretches.
    let medianLux: Double?
    /// Share of network length under 5 lux (unmeasured gaps count as dark, like the website).
    let shareBelowGuide: Double
    let darkest: ExploreDarkSpot?

    /// "18 min · 1.3 km · median 4.2 lux · 12% below 5 lux"
    var line: String {
        var bits: [String] = ["\(minutes) min", ExploreLux.distance(length)]
        if let m = medianLux { bits.append("median \(ExploreLux.format(m)) lux") }
        bits.append("\(ExploreLux.percent(shareBelowGuide)) below 5 lux")
        return bits.joined(separator: " · ")
    }
}

enum ExploreManeuver {
    case depart, straight, slightLeft, slightRight, left, right, sharpLeft, sharpRight, uTurn, arrive

    var symbol: String {
        switch self {
        case .depart: return "figure.walk"
        case .straight: return "arrow.up"
        case .slightLeft: return "arrow.up.left"
        case .slightRight: return "arrow.up.right"
        case .left, .sharpLeft: return "arrow.turn.up.left"
        case .right, .sharpRight: return "arrow.turn.up.right"
        case .uTurn: return "arrow.uturn.down"
        case .arrive: return "mappin.and.ellipse"
        }
    }

    var verb: String {
        switch self {
        case .depart: return "Head"
        case .straight: return "Continue"
        case .slightLeft: return "Bear left"
        case .slightRight: return "Bear right"
        case .left: return "Turn left"
        case .right: return "Turn right"
        case .sharpLeft: return "Sharp left"
        case .sharpRight: return "Sharp right"
        case .uTurn: return "Turn around"
        case .arrive: return "Arrive"
        }
    }

    static func from(angle: Double) -> ExploreManeuver {
        let a: Double = abs(angle)
        if a < 30 { return .straight }
        if a >= 160 { return .uTurn }
        if angle < 0 {
            if a < 55 { return .slightLeft }
            if a < 130 { return .left }
            return .sharpLeft
        } else {
            if a < 55 { return .slightRight }
            if a < 130 { return .right }
            return .sharpRight
        }
    }
}

struct ExploreStep: Identifiable {
    let id: Int
    let maneuver: ExploreManeuver
    let instruction: String
    /// Light along the leg that follows this step, e.g. "Dim · 4.2 lux".
    let light: String?
    /// Distance from route start to this maneuver (m).
    let startDistance: Double
    /// Length of the leg after this maneuver (m).
    let length: Double
    let coordinate: CLLocationCoordinate2D
}

struct ExploreRoute: Identifiable {
    let id: UUID = UUID()
    let kind: ExploreRouteKind
    /// Polyline in local metres (includes short connectors from the real start / to the real end).
    let points: [ExploreXY]
    let coordinates: [CLLocationCoordinate2D]
    /// cumulative[i] = distance from start to points[i]
    let cumulative: [Double]
    /// Per segment i (points[i] -> points[i+1]): measured lux (nil = gap / connector).
    let segmentLux: [Double?]
    let segmentName: [String?]
    let destinationNode: Int
    let summary: ExploreRouteSummary
    let steps: [ExploreStep]

    var length: Double { cumulative.last ?? 0 }

    /// Point at a distance along the route.
    func point(at distance: Double) -> ExploreXY {
        guard let first = points.first else { return ExploreXY(x: 0, y: 0) }
        if distance <= 0 || points.count < 2 { return first }
        if distance >= length { return points[points.count - 1] }
        var lo: Int = 0
        var hi: Int = cumulative.count - 1
        while hi - lo > 1 {
            let mid: Int = (lo + hi) / 2
            if cumulative[mid] <= distance { lo = mid } else { hi = mid }
        }
        let seg: Double = cumulative[hi] - cumulative[lo]
        let t: Double = seg > 0 ? (distance - cumulative[lo]) / seg : 0
        let a: ExploreXY = points[lo]
        let b: ExploreXY = points[hi]
        return ExploreXY(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    }

    /// Segment index containing a distance along the route.
    func segmentIndex(at distance: Double) -> Int {
        if points.count < 2 { return 0 }
        var lo: Int = 0
        var hi: Int = cumulative.count - 1
        if distance <= 0 { return 0 }
        if distance >= length { return max(0, points.count - 2) }
        while hi - lo > 1 {
            let mid: Int = (lo + hi) / 2
            if cumulative[mid] <= distance { lo = mid } else { hi = mid }
        }
        return min(lo, points.count - 2)
    }

    func bearing(at distance: Double) -> Double {
        let a: ExploreXY = point(at: max(0, distance - 5))
        let b: ExploreXY = point(at: min(length, distance + 10))
        return ExploreGeo.bearing(a, b)
    }
}

/// Where a point snapped onto the network.
struct ExploreSnap {
    let node: Int
    /// Straight-line distance from the requested point to the node (m).
    let offset: Double
    var isOutside: Bool { offset > ExploreGraph.outsideDistance }
}

// MARK: - Graph

final class ExploreGraph {
    static let walkingSpeed: Double = 1.3          // m/s
    static let outsideDistance: Double = 300       // m from the surveyed network

    let nodeXY: [ExploreXY]
    let edges: [ExploreEdge]
    let adjacency: [[Int]]
    let component: [Int]
    let places: [ExplorePlace]

    private let gridCell: Double = 30
    private let grid: [ExploreGridKey: [Int]]

    private struct ExploreGridKey: Hashable {
        let i: Int
        let j: Int
    }

    var nodeCount: Int { nodeXY.count }

    /// Loaded once per launch (SwiftUI may re-create views that own an ExploreModel).
    static let shared: ExploreGraph? = ExploreGraph.loadBundled()

    /// Loads Resources/Explore/lx_*.json. Returns nil if the graph file is missing or empty.
    static func loadBundled() -> ExploreGraph? {
        guard let d = ExploreBundle.data("lx_paths"),
              let file = try? JSONDecoder().decode(ExplorePathsFile.self, from: d),
              !file.nodes.isEmpty, !file.edges.isEmpty else { return nil }
        return ExploreGraph(file: file)
    }

    private init(file: ExplorePathsFile) {
        // nodes
        var xy: [ExploreXY] = []
        xy.reserveCapacity(file.nodes.count)
        for n in file.nodes where n.count >= 2 {
            xy.append(ExploreGeo.xy(CLLocationCoordinate2D(latitude: n[0], longitude: n[1])))
        }
        let nCount: Int = xy.count

        // edges + adjacency (same order and duplicates as the website's adjacency lists)
        var es: [ExploreEdge] = []
        es.reserveCapacity(file.edges.count)
        var adj: [[Int]] = Array(repeating: [], count: nCount)
        for row in file.edges where row.count >= 4 {
            let a: Int = Int(row[0])
            let b: Int = Int(row[1])
            guard a >= 0, b >= 0, a < nCount, b < nCount, a != b else { continue }
            let lux: Double? = row[3] < 0 ? nil : row[3]
            var name: String? = nil
            if row.count >= 5 {
                let ni: Int = Int(row[4])
                if ni >= 0 && ni < file.names.count { name = file.names[ni] }
            }
            let e: ExploreEdge = ExploreEdge(a: a, b: b, length: max(row[2], 0.01), lux: lux, name: name, glow: ExploreLux.glow(lux))
            adj[a].append(es.count)
            adj[b].append(es.count)
            es.append(e)
        }

        // connected components
        var comp: [Int] = Array(repeating: -1, count: nCount)
        var c: Int = 0
        for s in 0..<nCount where comp[s] < 0 {
            var stack: [Int] = [s]
            comp[s] = c
            while let u = stack.popLast() {
                for k in adj[u] {
                    let v: Int = es[k].other(u)
                    if comp[v] < 0 { comp[v] = c; stack.append(v) }
                }
            }
            c += 1
        }

        // grid for snapping
        var g: [ExploreGridKey: [Int]] = [:]
        for (i, p) in xy.enumerated() {
            let key: ExploreGridKey = ExploreGridKey(i: Int((p.x / 30).rounded(.down)), j: Int((p.y / 30).rounded(.down)))
            g[key, default: []].append(i)
        }

        self.nodeXY = xy
        self.edges = es
        self.adjacency = adj
        self.component = comp
        self.grid = g
        self.places = ExploreGraph.loadPlaces()
    }

    // MARK: Loading helpers

    static func foldKey(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US"))
            .lowercased()
            .replacingOccurrences(of: "&", with: " and ")
    }

    static func words(_ key: String) -> [String] {
        key.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    private static func loadPlaces() -> [ExplorePlace] {
        var out: [ExplorePlace] = []
        for row in ExploreBundle.rows("lx_places") where row.count >= 4 {
            guard let name = row[0] as? String,
                  let lat = ExploreBundle.number(row[2]),
                  let lon = ExploreBundle.number(row[3]) else { continue }
            let kind: String = (row[1] as? String) ?? "landmark"
            let key: String = foldKey(name)
            out.append(ExplorePlace(id: out.count, name: name, kind: kind, latitude: lat, longitude: lon, key: key, words: words(key)))
        }
        return out
    }

    // MARK: Snapping

    func coordinate(ofNode n: Int) -> CLLocationCoordinate2D { ExploreGeo.coordinate(nodeXY[n]) }

    /// Nearest node to a point (optionally restricted to one connected piece). Never fails while the graph has nodes.
    func snap(_ c: CLLocationCoordinate2D, component comp: Int? = nil) -> ExploreSnap? {
        let p: ExploreXY = ExploreGeo.xy(c)
        var best: Int = -1
        var bd: Double = Double.infinity
        for r in [30.0, 90.0, 250.0] {
            let i0: Int = Int(((p.x - r) / gridCell).rounded(.down))
            let i1: Int = Int(((p.x + r) / gridCell).rounded(.down))
            let j0: Int = Int(((p.y - r) / gridCell).rounded(.down))
            let j1: Int = Int(((p.y + r) / gridCell).rounded(.down))
            for i in i0...i1 {
                for j in j0...j1 {
                    guard let ids = grid[ExploreGridKey(i: i, j: j)] else { continue }
                    for n in ids {
                        if let cc = comp, component[n] != cc { continue }
                        let d: Double = ExploreGeo.distance(p, nodeXY[n])
                        if d < bd { bd = d; best = n }
                    }
                }
            }
            if best >= 0 && bd <= r { break }
        }
        if best < 0 {
            // far from campus: brute force over every node
            for n in 0..<nodeXY.count {
                if let cc = comp, component[n] != cc { continue }
                let d: Double = ExploreGeo.distance(p, nodeXY[n])
                if d < bd { bd = d; best = n }
            }
        }
        return best >= 0 ? ExploreSnap(node: best, offset: bd) : nil
    }

    /// Snaps both ends onto one connected piece of the network, choosing the pairing with the smallest total offset.
    func snapPair(_ from: CLLocationCoordinate2D, _ to: CLLocationCoordinate2D) -> (ExploreSnap, ExploreSnap)? {
        guard let a = snap(from), let b = snap(to) else { return nil }
        if component[a.node] == component[b.node] { return (a, b) }
        var best: (ExploreSnap, ExploreSnap)? = nil
        var bestCost: Double = Double.infinity
        if let b2 = snap(to, component: component[a.node]) {
            let cost: Double = a.offset + b2.offset
            if cost < bestCost { bestCost = cost; best = (a, b2) }
        }
        if let a2 = snap(from, component: component[b.node]) {
            let cost: Double = a2.offset + b.offset
            if cost < bestCost { bestCost = cost; best = (a2, b) }
        }
        return best
    }

    // MARK: Dijkstra

    func cost(_ e: ExploreEdge, _ kind: ExploreRouteKind) -> Double {
        switch kind {
        case .shortest: return e.length
        case .bestLit: return e.length * (1.0 + 6.0 * (1.0 - e.glow))
        }
    }

    /// Node and edge sequence from s to t, or nil when not connected.
    func path(from s: Int, to t: Int, kind: ExploreRouteKind) -> (nodes: [Int], edges: [Int])? {
        let n: Int = nodeXY.count
        guard s >= 0, t >= 0, s < n, t < n else { return nil }
        if s == t { return (nodes: [s], edges: []) }
        var dist: [Double] = Array(repeating: Double.infinity, count: n)
        var prevNode: [Int] = Array(repeating: -1, count: n)
        var prevEdge: [Int] = Array(repeating: -1, count: n)
        var heap: ExploreHeap = ExploreHeap()
        dist[s] = 0
        heap.push(0, s)
        while let top = heap.pop() {
            let du: Double = top.0
            let u: Int = top.1
            if u == t { break }
            if du > dist[u] { continue }
            for k in adjacency[u] {
                let e: ExploreEdge = edges[k]
                let v: Int = e.other(u)
                let nd: Double = du + cost(e, kind)
                if nd < dist[v] {
                    dist[v] = nd
                    prevNode[v] = u
                    prevEdge[v] = k
                    heap.push(nd, v)
                }
            }
        }
        if !dist[t].isFinite { return nil }
        var nodes: [Int] = []
        var es: [Int] = []
        var v: Int = t
        while v != -1 {
            nodes.append(v)
            if v != s && prevEdge[v] >= 0 { es.append(prevEdge[v]) }
            v = prevNode[v]
        }
        nodes.reverse()
        es.reverse()
        return (nodes: nodes, edges: es)
    }

    // MARK: Route building

    /// Builds a route between two snapped nodes. `start` / `end` are the real requested points: if they are
    /// within the surveyed area a short straight connector is added (counted as unmeasured, not in the light stats).
    func route(kind: ExploreRouteKind, from a: ExploreSnap, to b: ExploreSnap,
               start: CLLocationCoordinate2D?, end: CLLocationCoordinate2D?, destinationName: String) -> ExploreRoute? {
        guard let p = path(from: a.node, to: b.node, kind: kind) else { return nil }

        var pts: [ExploreXY] = []
        var segLux: [Double?] = []
        var segName: [String?] = []
        var networkEdges: [ExploreEdge] = []

        if let s = start, !a.isOutside, a.offset > 3 {
            pts.append(ExploreGeo.xy(s))
            segLux.append(nil)
            segName.append(nil)
        }
        pts.append(nodeXY[p.nodes[0]])
        for (i, k) in p.edges.enumerated() {
            let e: ExploreEdge = edges[k]
            networkEdges.append(e)
            segLux.append(e.lux)
            segName.append(e.name)
            pts.append(nodeXY[p.nodes[i + 1]])
        }
        if let f = end, !b.isOutside, b.offset > 3 {
            pts.append(ExploreGeo.xy(f))
            segLux.append(nil)
            segName.append(nil)
        }
        if pts.count == 1 {
            // start and end on the same node: a zero-length route still needs two points to draw
            pts.append(pts[0])
            segLux.append(nil)
            segName.append(nil)
        }

        var cum: [Double] = [0]
        cum.reserveCapacity(pts.count)
        for i in 1..<pts.count {
            cum.append(cum[i - 1] + ExploreGeo.distance(pts[i - 1], pts[i]))
        }
        let summary: ExploreRouteSummary = summarize(networkEdges: networkEdges, totalLength: cum.last ?? 0)
        let steps: [ExploreStep] = buildSteps(points: pts, cumulative: cum, segLux: segLux, segName: segName,
                                              destinationName: destinationName)
        return ExploreRoute(kind: kind, points: pts, coordinates: pts.map { ExploreGeo.coordinate($0) }, cumulative: cum,
                            segmentLux: segLux, segmentName: segName, destinationNode: b.node, summary: summary, steps: steps)
    }

    private func summarize(networkEdges: [ExploreEdge], totalLength: Double) -> ExploreRouteSummary {
        var netLen: Double = 0
        var darkLen: Double = 0
        var measured: [(lux: Double, len: Double)] = []
        var darkest: ExploreDarkSpot? = nil
        for e in networkEdges {
            netLen += e.length
            if e.isDark { darkLen += e.length }
            if let l = e.lux {
                measured.append((lux: l, len: e.length))
                if darkest == nil || l < (darkest?.lux ?? Double.infinity) {
                    let mid: ExploreXY = ExploreXY(x: (nodeXY[e.a].x + nodeXY[e.b].x) / 2, y: (nodeXY[e.a].y + nodeXY[e.b].y) / 2)
                    darkest = ExploreDarkSpot(lux: l, coordinate: ExploreGeo.coordinate(mid), name: e.name ?? nearestPlaceName(to: mid, within: 80))
                }
            }
        }
        let median: Double? = ExploreGraph.weightedMedian(measured)
        return ExploreRouteSummary(length: totalLength, minutes: ExploreLux.minutes(totalLength), medianLux: median,
                                   shareBelowGuide: netLen > 0 ? darkLen / netLen : 0, darkest: darkest)
    }

    static func weightedMedian(_ items: [(lux: Double, len: Double)]) -> Double? {
        if items.isEmpty { return nil }
        let sorted: [(lux: Double, len: Double)] = items.sorted { $0.lux < $1.lux }
        let total: Double = sorted.reduce(0) { $0 + $1.len }
        if total <= 0 { return sorted[sorted.count / 2].lux }
        var acc: Double = 0
        for it in sorted {
            acc += it.len
            if acc >= total / 2 { return it.lux }
        }
        return sorted[sorted.count - 1].lux
    }

    func nearestPlaceName(to p: ExploreXY, within radius: Double) -> String? {
        var best: String? = nil
        var bd: Double = radius
        for pl in places {
            let d: Double = ExploreGeo.distance(p, ExploreGeo.xy(pl.coordinate))
            if d < bd { bd = d; best = pl.name }
        }
        return best
    }

    // MARK: Turn-by-turn

    private struct Candidate {
        var index: Int
        var distance: Double
        var angle: Double
        var nameChange: Bool
    }

    private func buildSteps(points pts: [ExploreXY], cumulative cum: [Double], segLux: [Double?], segName: [String?],
                            destinationName: String) -> [ExploreStep] {
        let total: Double = cum.last ?? 0
        let n: Int = pts.count
        func pointAt(_ d: Double) -> ExploreXY {
            if d <= 0 { return pts[0] }
            if d >= total { return pts[n - 1] }
            var lo: Int = 0
            var hi: Int = n - 1
            while hi - lo > 1 {
                let mid: Int = (lo + hi) / 2
                if cum[mid] <= d { lo = mid } else { hi = mid }
            }
            let seg: Double = cum[hi] - cum[lo]
            let t: Double = seg > 0 ? (d - cum[lo]) / seg : 0
            return ExploreXY(x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, y: pts[lo].y + (pts[hi].y - pts[lo].y) * t)
        }
        func bearingIn(_ d: Double) -> Double { ExploreGeo.bearing(pointAt(d - 12), pointAt(d)) }
        func bearingOut(_ d: Double) -> Double { ExploreGeo.bearing(pointAt(d), pointAt(d + 12)) }
        func named(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }

        // 1. corner candidates: Douglas-Peucker vertices (4 m) + every point where the street name changes
        var keep: Set<Int> = Set<Int>(ExploreGraph.simplify(pts, epsilon: 4))
        var nameChangeAt: Set<Int> = []
        if n >= 3 {
            for i in 1..<(n - 1) {
                let before: String? = named(segName[i - 1])
                let after: String? = named(segName[i])
                if before != after && after != nil { nameChangeAt.insert(i); keep.insert(i) }
            }
        }
        var cands: [Candidate] = []
        for i in keep.sorted() where i > 0 && i < n - 1 {
            let d: Double = cum[i]
            if d < 4 || total - d < 4 { continue }
            let ang: Double = ExploreGeo.turnAngle(from: bearingIn(d), to: bearingOut(d))
            let nc: Bool = nameChangeAt.contains(i)
            if abs(ang) >= 25 || nc { cands.append(Candidate(index: i, distance: d, angle: ang, nameChange: nc)) }
        }

        // 2. merge candidates closer than 15 m into one maneuver (rounded corners, short jogs)
        var groups: [[Candidate]] = []
        for c in cands {
            if var last = groups.last, let tail = last.last, c.distance - tail.distance < 15 {
                last.append(c)
                groups[groups.count - 1] = last
            } else {
                groups.append([c])
            }
        }
        var maneuvers: [Candidate] = []
        for g in groups {
            guard let first = g.first, let last = g.last else { continue }
            let ang: Double = ExploreGeo.turnAngle(from: bearingIn(first.distance), to: bearingOut(last.distance))
            var pick: Candidate = first
            for c in g where abs(c.angle) > abs(pick.angle) { pick = c }
            let nc: Bool = g.contains { $0.nameChange }
            if abs(ang) < 30 && !nc { continue }
            maneuvers.append(Candidate(index: pick.index, distance: pick.distance, angle: ang, nameChange: nc))
        }

        // 3. instructions
        func nameAfter(_ i: Int) -> String? { i < segName.count ? named(segName[i]) : nil }
        func legLight(_ d0: Double, _ d1: Double) -> String? {
            var items: [(lux: Double, len: Double)] = []
            for i in 0..<(n - 1) {
                let a: Double = max(cum[i], d0)
                let b: Double = min(cum[i + 1], d1)
                if b > a, let l = segLux[i] { items.append((lux: l, len: b - a)) }
            }
            guard let m = ExploreGraph.weightedMedian(items) else { return nil }
            return ExploreLux.label(m)
        }

        var raw: [(ExploreManeuver, String, Double, ExploreXY)] = []
        let departBearing: Double = ExploreGeo.bearing(pts[0], pointAt(min(total, 15)))
        var departText: String = "Head \(ExploreGeo.cardinal(departBearing))"
        if let nm = nameAfter(0) { departText += " on \(nm)" }
        raw.append((.depart, departText, 0, pts[0]))
        for m in maneuvers {
            let kind: ExploreManeuver = ExploreManeuver.from(angle: m.angle)
            let street: String? = nameAfter(m.index)
            var text: String
            if kind == .straight {
                guard let s = street else { continue }
                text = "Continue onto \(s)"
            } else {
                text = kind.verb
                if let s = street {
                    text += " onto \(s)"
                } else if let pl = nearestPlaceName(to: pts[m.index], within: 50) {
                    text += " near \(pl)"
                }
            }
            raw.append((kind, text, m.distance, pts[m.index]))
        }
        raw.append((.arrive, destinationName.isEmpty ? "Arrive" : "Arrive at \(destinationName)", total, pts[n - 1]))

        var steps: [ExploreStep] = []
        for (i, r) in raw.enumerated() {
            let next: Double = i + 1 < raw.count ? raw[i + 1].2 : r.2
            let len: Double = max(0, next - r.2)
            let light: String? = r.0 == .arrive ? nil : legLight(r.2, next)
            steps.append(ExploreStep(id: i, maneuver: r.0, instruction: r.1, light: light, startDistance: r.2,
                                     length: len, coordinate: ExploreGeo.coordinate(r.3)))
        }
        return steps
    }

    /// Douglas-Peucker; returns the kept indices (always includes both ends).
    static func simplify(_ pts: [ExploreXY], epsilon: Double) -> [Int] {
        if pts.count < 3 { return Array(0..<pts.count) }
        var keep: [Bool] = Array(repeating: false, count: pts.count)
        keep[0] = true
        keep[pts.count - 1] = true
        var stack: [(Int, Int)] = [(0, pts.count - 1)]
        while let span = stack.popLast() {
            let s: Int = span.0
            let e: Int = span.1
            if e - s < 2 { continue }
            let a: ExploreXY = pts[s]
            let b: ExploreXY = pts[e]
            let dx: Double = b.x - a.x
            let dy: Double = b.y - a.y
            let len2: Double = dx * dx + dy * dy
            var maxD: Double = -1
            var maxI: Int = -1
            for i in (s + 1)..<e {
                let p: ExploreXY = pts[i]
                var d: Double
                if len2 < 1e-9 {
                    d = hypot(p.x - a.x, p.y - a.y)
                } else {
                    var t: Double = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
                    t = max(0, min(1, t))
                    d = hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
                }
                if d > maxD { maxD = d; maxI = i }
            }
            if maxD > epsilon && maxI > 0 {
                keep[maxI] = true
                stack.append((s, maxI))
                stack.append((maxI, e))
            }
        }
        var out: [Int] = []
        for (i, k) in keep.enumerated() where k { out.append(i) }
        return out
    }
}

// MARK: - Binary min-heap for Dijkstra

struct ExploreHeap {
    private var keys: [Double] = []
    private var values: [Int] = []

    var isEmpty: Bool { keys.isEmpty }

    mutating func push(_ key: Double, _ value: Int) {
        keys.append(key)
        values.append(value)
        var i: Int = keys.count - 1
        while i > 0 {
            let p: Int = (i - 1) / 2
            if keys[p] <= keys[i] { break }
            keys.swapAt(p, i)
            values.swapAt(p, i)
            i = p
        }
    }

    mutating func pop() -> (Double, Int)? {
        guard !keys.isEmpty else { return nil }
        let top: (Double, Int) = (keys[0], values[0])
        let lastKey: Double = keys.removeLast()
        let lastValue: Int = values.removeLast()
        if !keys.isEmpty {
            keys[0] = lastKey
            values[0] = lastValue
            var i: Int = 0
            let n: Int = keys.count
            while true {
                let l: Int = 2 * i + 1
                let r: Int = l + 1
                var m: Int = i
                if l < n && keys[l] < keys[m] { m = l }
                if r < n && keys[r] < keys[m] { m = r }
                if m == i { break }
                keys.swapAt(m, i)
                values.swapAt(m, i)
                i = m
            }
        }
        return top
    }
}
