import Foundation
import CoreLocation
import MapKit
import Observation

// Explore mode: "My Location", campus places and real addresses for the From / To fields.

// MARK: - Endpoint

/// A chosen From / To point.
struct ExploreEndpoint: Equatable {
    let title: String
    let subtitle: String?
    let latitude: Double
    let longitude: Double
    let isMyLocation: Bool

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }

    init(title: String, subtitle: String?, coordinate: CLLocationCoordinate2D) {
        self.title = title
        self.subtitle = subtitle
        self.latitude = coordinate.latitude
        self.longitude = coordinate.longitude
        self.isMyLocation = false
    }

    private init(myLocation: Bool) {
        self.title = "My Location"
        self.subtitle = nil
        self.latitude = 0
        self.longitude = 0
        self.isMyLocation = myLocation
    }

    /// Placeholder for "use the phone's position"; the coordinate is read from ExploreLocation when routing.
    static let myLocation: ExploreEndpoint = ExploreEndpoint(myLocation: true)
}

// MARK: - Location

@MainActor
@Observable
final class ExploreLocation: NSObject, CLLocationManagerDelegate {
    private let manager: CLLocationManager = CLLocationManager()

    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    private(set) var location: CLLocation? = nil
    /// Increments on every new fix (handy for onChange).
    private(set) var fixCount: Int = 0
    private(set) var isUpdating: Bool = false

    var isDenied: Bool { authorization == .denied || authorization == .restricted }
    var isAuthorized: Bool { authorization == .authorizedWhenInUse || authorization == .authorizedAlways }

    /// A usable recent fix (< 2 min old, < 100 m accuracy).
    var usableCoordinate: CLLocationCoordinate2D? {
        guard let l = location, l.horizontalAccuracy >= 0, l.horizontalAccuracy < 100,
              abs(l.timestamp.timeIntervalSinceNow) < 120 else { return nil }
        return l.coordinate
    }

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 3
        manager.activityType = .fitness
        authorization = manager.authorizationStatus
    }

    /// Asks for when-in-use permission (first time) and starts updates when allowed.
    func start() {
        authorization = manager.authorizationStatus
        if authorization == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else if isAuthorized && !isUpdating {
            manager.startUpdatingLocation()
            isUpdating = true
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        isUpdating = false
    }

    func setNavigating(_ on: Bool) {
        manager.desiredAccuracy = on ? kCLLocationAccuracyBestForNavigation : kCLLocationAccuracyBest
        manager.distanceFilter = on ? kCLDistanceFilterNone : 3
    }

    private func apply(status: CLAuthorizationStatus) {
        authorization = status
        if isAuthorized {
            if !isUpdating {
                manager.startUpdatingLocation()
                isUpdating = true
            }
        } else if isUpdating {
            manager.stopUpdatingLocation()
            isUpdating = false
        }
    }

    private func apply(location l: CLLocation) {
        location = l
        fixCount += 1
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status: CLAuthorizationStatus = manager.authorizationStatus
        Task { @MainActor in
            self.apply(status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        Task { @MainActor in
            self.apply(location: last)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // kCLErrorLocationUnknown is transient; denial arrives through the authorization callback.
    }
}

// MARK: - Suggestions

enum ExploreSuggestionKind {
    case myLocation
    case place(ExplorePlace)
    case address(MKLocalSearchCompletion)
}

struct ExploreSuggestion: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let symbol: String
    let kind: ExploreSuggestionKind
}

@MainActor
@Observable
final class ExploreSearch: NSObject, MKLocalSearchCompleterDelegate {
    /// Region the address search is biased to (campus and College Station / Bryan).
    static let region: MKCoordinateRegion = MKCoordinateRegion(center: ExploreGeo.campusCenter,
                                                               latitudinalMeters: 9000, longitudinalMeters: 9000)
    /// Address results farther than this from campus are rejected.
    static let maxDistanceFromCampus: Double = 12000

    var places: [ExplorePlace] = []
    private(set) var query: String = ""
    private(set) var placeResults: [ExploreSuggestion] = []
    private(set) var addressResults: [ExploreSuggestion] = []
    private(set) var isResolving: Bool = false

    private let completer: MKLocalSearchCompleter = MKLocalSearchCompleter()

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
        completer.region = ExploreSearch.region
    }

    func update(query q: String) {
        query = q
        let trimmed: String = q.trimmingCharacters(in: .whitespacesAndNewlines)
        placeResults = matchPlaces(trimmed)
        if trimmed.count >= 3 {
            completer.queryFragment = trimmed
        } else {
            completer.cancel()
            addressResults = []
        }
    }

    func clear() {
        query = ""
        placeResults = []
        addressResults = []
        completer.cancel()
    }

    /// Campus places: prefix > word-prefix > contains > in-order letters.
    func matchPlaces(_ q: String, limit: Int = 8) -> [ExploreSuggestion] {
        let key: String = ExploreGraph.foldKey(q)
        let qWords: [String] = ExploreGraph.words(key)
        if qWords.isEmpty { return [] }
        let compact: String = qWords.joined(separator: " ")
        var scored: [(score: Int, place: ExplorePlace)] = []
        for p in places {
            var score: Int = -1
            if p.key.hasPrefix(compact) {
                score = 0
            } else if qWords.allSatisfy({ (w: String) -> Bool in p.words.contains { $0.hasPrefix(w) } }) {
                score = 1
            } else if p.key.contains(compact) {
                score = 2
            } else if compact.count >= 3 && ExploreSearch.isSubsequence(compact.replacingOccurrences(of: " ", with: ""), of: p.key) {
                score = 3
            }
            if score >= 0 { scored.append((score: score, place: p)) }
        }
        scored.sort { (a: (score: Int, place: ExplorePlace), b: (score: Int, place: ExplorePlace)) -> Bool in
            if a.score != b.score { return a.score < b.score }
            return a.place.name.count < b.place.name.count
        }
        return scored.prefix(limit).map { (item: (score: Int, place: ExplorePlace)) -> ExploreSuggestion in
            ExploreSuggestion(id: "place-\(item.place.id)", title: item.place.name, subtitle: item.place.kindLabel + " · Campus",
                              symbol: "building.2", kind: .place(item.place))
        }
    }

    private static func isSubsequence(_ needle: String, of hay: String) -> Bool {
        var it = needle.makeIterator()
        var want: Character? = it.next()
        for ch in hay {
            guard let w = want else { return true }
            if ch == w { want = it.next() }
        }
        return want == nil
    }

    /// Looks up the coordinate for an address suggestion. Returns nil (with a message) if not found or too far.
    func resolve(_ completion: MKLocalSearchCompletion) async -> (ExploreEndpoint?, String?) {
        isResolving = true
        defer { isResolving = false }
        let request: MKLocalSearch.Request = MKLocalSearch.Request(completion: completion)
        request.region = ExploreSearch.region
        let search: MKLocalSearch = MKLocalSearch(request: request)
        do {
            let response: MKLocalSearch.Response = try await search.start()
            guard let item = response.mapItems.first else { return (nil, "No match") }
            let c: CLLocationCoordinate2D = item.placemark.coordinate
            let campus: CLLocation = CLLocation(latitude: ExploreGeo.campusCenter.latitude, longitude: ExploreGeo.campusCenter.longitude)
            let here: CLLocation = CLLocation(latitude: c.latitude, longitude: c.longitude)
            if here.distance(from: campus) > ExploreSearch.maxDistanceFromCampus { return (nil, "Too far from campus") }
            let title: String = completion.title.isEmpty ? (item.name ?? "Pin") : completion.title
            let sub: String? = completion.subtitle.isEmpty ? nil : completion.subtitle
            return (ExploreEndpoint(title: title, subtitle: sub, coordinate: c), nil)
        } catch {
            return (nil, "Search unavailable")
        }
    }

    private func applyCompletions(_ results: [MKLocalSearchCompletion]) {
        guard query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3 else { addressResults = []; return }
        var out: [ExploreSuggestion] = []
        for (i, r) in results.prefix(6).enumerated() {
            out.append(ExploreSuggestion(id: "addr-\(i)-\(r.title)-\(r.subtitle)", title: r.title, subtitle: r.subtitle,
                                         symbol: "mappin", kind: .address(r)))
        }
        addressResults = out
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let results: [MKLocalSearchCompletion] = completer.results
        Task { @MainActor in
            self.applyCompletions(results)
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        Task { @MainActor in
            self.applyCompletions([])
        }
    }
}
