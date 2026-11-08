import Foundation

/// Which 10 m pieces of a walker's route already have good data.
///
/// Saved to Documents/Coverage/W{n}.json every few seconds (atomic write), so it survives
/// crashes, a dead battery, force-quits and restarts, and it adds up across any number of
/// sessions. A piece counts as "covered" once it has enough valid light readings AND at least
/// one back-camera photo taken on the route with good GPS.
final class CoverageStore {
    static let binSize = 10.0
    static let luxNeeded = 3
    static let photosNeeded = 1

    private struct Saved: Codable {
        var routeID: Int
        var binSize: Double
        var lux: [Int]
        var photos: [Int]
        var updated: Double
    }

    let routeID: Int
    let variant: Int?
    private(set) var lux: [Int]
    private(set) var photos: [Int]
    /// False when this iPhone can't run both cameras (then light readings alone count).
    var photosRequired = true
    private(set) var dirty = false

    init(route: SurveyRoute) {
        routeID = route.id
        variant = route.variant
        let n = max(1, Int((route.total / Self.binSize).rounded(.up)))
        lux = Array(repeating: 0, count: n)
        photos = Array(repeating: 0, count: n)
        if let data = try? Data(contentsOf: Self.url(for: route.id, variant: route.variant)),
           let s = try? JSONDecoder().decode(Saved.self, from: data),
           s.lux.count == n, s.photos.count == n {
            lux = s.lux
            photos = s.photos
        }
    }

    static var folder: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Coverage", isDirectory: true)
    }

    static func url(for id: Int, variant: Int? = nil) -> URL {
        folder.appendingPathComponent(variant.map { "W\(id)_route\($0).json" } ?? "W\(id).json")
    }

    var count: Int { lux.count }

    func isCovered(_ i: Int) -> Bool {
        lux[i] >= Self.luxNeeded && (!photosRequired || photos[i] >= Self.photosNeeded)
    }

    var coveredCount: Int { (0..<count).filter { isCovered($0) }.count }
    var fraction: Double { Double(coveredCount) / Double(max(count, 1)) }

    func bin(at along: Double) -> Int { min(max(Int(along / Self.binSize), 0), count - 1) }
    func start(ofBin i: Int) -> Double { Double(i) * Self.binSize }

    func needsData(at along: Double) -> Bool { !isCovered(bin(at: along)) }

    /// Add a light reading and/or a photo to every bin in `bins`. Returns how many bins became covered.
    @discardableResult
    func credit(_ bins: Set<Int>, lux addLux: Bool, photo addPhoto: Bool) -> Int {
        guard addLux || addPhoto else { return 0 }
        var newly = 0
        for i in bins where i >= 0 && i < count {
            let was = isCovered(i)
            if addLux { lux[i] += 1 }
            if addPhoto { photos[i] += 1 }
            if !was && isCovered(i) { newly += 1 }
        }
        dirty = true
        return newly
    }

    func firstUncovered(from start: Int = 0) -> Int? {
        guard start < count else { return nil }
        return (start..<count).first { !isCovered($0) }
    }

    /// Runs of uncovered bins that lie entirely before `bin` (i.e. already walked past).
    func gaps(before bin: Int) -> [ClosedRange<Int>] {
        var out: [ClosedRange<Int>] = []
        var runStart: Int?
        let end = min(bin, count)
        for i in 0..<end {
            if !isCovered(i) {
                if runStart == nil { runStart = i }
            } else if let s = runStart {
                out.append(s...(i - 1)); runStart = nil
            }
        }
        if let s = runStart { out.append(s...(end - 1)) }
        return out
    }

    func save(force: Bool = false) {
        guard dirty || force else { return }
        let s = Saved(routeID: routeID, binSize: Self.binSize, lux: lux, photos: photos,
                      updated: Date().timeIntervalSince1970)
        do {
            try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(s)
            try data.write(to: Self.url(for: routeID, variant: variant), options: .atomic)
            dirty = false
        } catch {
            print("coverage save failed: \(error)")
        }
    }

    func reset() {
        lux = Array(repeating: 0, count: count)
        photos = Array(repeating: 0, count: count)
        dirty = true
        save()
    }
}
