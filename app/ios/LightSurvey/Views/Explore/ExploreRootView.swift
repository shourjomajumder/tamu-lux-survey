import SwiftUI
import MapKit
import UIKit

/// Explore mode (normal users): plain dark campus map and best-lit walking directions.
///
/// Smoothness notes:
/// - The Map lives in its own small view (`ExploreMapLayer`) that only reads the routes, so GPS fixes,
///   sheet changes and banner text never make SwiftUI rebuild the Map's content.
/// - GPS fixes are observed by a tiny invisible view (`ExploreFixListener`), so this root view does not
///   re-run its body on every fix either.
/// - The follow-cam moves with a linear animation as long as the gap between fixes, with a smoothed heading,
///   so consecutive fixes chain into one continuous glide instead of restarting an ease-in-out each time.
@MainActor
struct ExploreRootView: View {
    private let onSwitchMode: () -> Void

    @State private var model: ExploreModel = ExploreModel()
    @State private var position: MapCameraPosition = .camera(ExploreStyle.campusCamera)
    @State private var following: Bool = true
    /// Follow-cam bookkeeping. A plain class (not observed): writing to it never re-renders anything.
    @State private var follow: ExploreFollowCam = ExploreFollowCam()

    init(onSwitchMode: @escaping () -> Void) {
        self.onSwitchMode = onSwitchMode
    }

    var body: some View {
        ZStack {
            Lx.bg.ignoresSafeArea()
            ExploreMapLayer(model: model, position: $position, following: $following)
                .ignoresSafeArea()
            if let nav = model.navigator {
                ExploreNavigationView(model: model, navigator: nav, following: following,
                                      onRecenter: { following = true; followCamera(jump: true) },
                                      onEnd: { endNavigation() })
            } else {
                browseChrome
            }
        }
        .background {
            ExploreFixListener(location: model.location) { locationChanged() }
        }
        .environment(\.colorScheme, .dark)
        .preferredColorScheme(.dark)
        .onAppear { model.location.start() }
        .onDisappear {
            if model.isNavigating { endNavigation() }
        }
    }

    // MARK: Browse chrome (top bar, locate, bottom sheet)

    private var browseChrome: some View {
        VStack(spacing: 0) {
            topBar
            HStack(alignment: .top) {
                Spacer(minLength: 0)
                ExploreIconButton(symbol: "location", label: "My location") { centerOnUser() }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            Spacer(minLength: 0)
            ExploreSheet(model: model, onRoute: { frameRoute() }, onGo: { startNavigation() })
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            LxLogo(height: 22)
                .padding(.leading, 2)
            Spacer(minLength: 0)
            Button {
                onSwitchMode()
            } label: {
                Text("Survey")
            }
            .buttonStyle(LxButtonStyle())
            .accessibilityLabel(Text("Switch to survey mode"))
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .background(
            LinearGradient(colors: [Lx.bg.opacity(0.92), Lx.bg.opacity(0.0)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        )
    }

    // MARK: Camera

    private func frameRoute() {
        guard let r = model.bestLit else { return }
        var coords: [CLLocationCoordinate2D] = r.coordinates
        if let s = model.shortest { coords.append(contentsOf: s.coordinates) }
        guard let first = coords.first else { return }
        var minX: Double = Double.infinity
        var minY: Double = Double.infinity
        var maxX: Double = -Double.infinity
        var maxY: Double = -Double.infinity
        for c in coords {
            let p: MKMapPoint = MKMapPoint(c)
            minX = min(minX, p.x); maxX = max(maxX, p.x)
            minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        let ppm: Double = MKMapPointsPerMeterAtLatitude(first.latitude)
        let minSide: Double = 250.0 * ppm
        let w: Double = max(maxX - minX, minSide)
        let h: Double = max(maxY - minY, minSide)
        let cx: Double = (minX + maxX) / 2
        let cy: Double = (minY + maxY) / 2
        // leave room for the top bar (above) and the route card (below)
        let rect: MKMapRect = MKMapRect(x: cx - w * 0.8, y: cy - h * 1.1, width: w * 1.6, height: h * 3.0)
        withAnimation(.easeInOut(duration: 0.6)) {
            position = .rect(rect)
        }
    }

    private func centerOnUser() {
        model.location.start()
        guard let c = model.location.usableCoordinate else { return }
        withAnimation(.easeInOut(duration: 0.6)) {
            position = .camera(MapCamera(centerCoordinate: c, distance: 900, heading: 0, pitch: 0))
        }
    }

    /// `jump`: a deliberate move (Go, Re-centre) with an ease-in-out; otherwise one step of the continuous follow-cam.
    private func followCamera(jump: Bool) {
        guard let nav = model.navigator, let loc = model.location.location else { return }
        let raw: Double = (loc.course >= 0 && loc.speed > 0.6) ? loc.course : nav.route.bearing(at: nav.progress)
        let now: Date = Date()
        if jump {
            let heading: Double = follow.reset(heading: raw, at: now)
            let cam: MapCamera = MapCamera(centerCoordinate: loc.coordinate, distance: 420, heading: heading, pitch: 50)
            withAnimation(.easeInOut(duration: 0.8)) { position = .camera(cam) }
            return
        }
        // a jump animation is still running: let it land, the next fix picks up from there
        if now < follow.busyUntil { return }
        guard let step = follow.step(heading: raw, at: now) else { return }
        let cam: MapCamera = MapCamera(centerCoordinate: loc.coordinate, distance: 420, heading: step.heading, pitch: 50)
        withAnimation(.linear(duration: step.duration)) { position = .camera(cam) }
    }

    // MARK: Navigation

    private func startNavigation() {
        guard model.bestLit != nil else { return }
        following = true
        model.startNavigation()
        UIApplication.shared.isIdleTimerDisabled = true
        if model.location.location != nil {
            followCamera(jump: true)
        } else if let first = model.bestLit?.coordinates.first {
            let heading: Double = model.bestLit?.bearing(at: 0) ?? 0
            _ = follow.reset(heading: heading, at: Date())
            withAnimation(.easeInOut(duration: 0.8)) {
                position = .camera(MapCamera(centerCoordinate: first, distance: 420, heading: heading, pitch: 50))
            }
        }
    }

    private func endNavigation() {
        model.endNavigation()
        UIApplication.shared.isIdleTimerDisabled = false
        following = true
        frameRoute()
    }

    private func locationChanged() {
        if model.isNavigating {
            model.navigationFix()
            if following { followCamera(jump: false) }
        } else if model.sheet == .route && model.bestLit == nil && model.from.isMyLocation && model.to != nil {
            // the route was waiting for the first GPS fix
            if model.computeRoutes() { frameRoute() }
        }
    }
}

// MARK: - Map (isolated so unrelated state changes never rebuild its content)

@MainActor
struct ExploreMapLayer: View {
    let model: ExploreModel
    @Binding var position: MapCameraPosition
    @Binding var following: Bool

    var body: some View {
        Map(position: $position, interactionModes: .all) {
            if let alt = model.shortest, !model.isNavigating {
                MapPolyline(coordinates: alt.coordinates)
                    .stroke(Color(white: 0.62).opacity(0.95), style: StrokeStyle(lineWidth: 3, lineCap: .butt, lineJoin: .round, dash: [7, 6]))
            }
            if let lit = model.navigator?.route ?? model.bestLit {
                MapPolyline(coordinates: lit.coordinates)
                    .stroke(Color.white.opacity(0.22), style: StrokeStyle(lineWidth: 12, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: lit.coordinates)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                if let dk = lit.summary.darkest, !model.isNavigating {
                    Annotation("", coordinate: dk.coordinate, anchor: .bottom) {
                        ExploreDarkestLabel(spot: dk)
                    }
                }
                if let first = lit.coordinates.first {
                    Annotation("", coordinate: first, anchor: .center) {
                        ExploreEndMark(isDestination: false)
                    }
                }
                if let last = lit.coordinates.last {
                    Annotation("", coordinate: last, anchor: .center) {
                        ExploreEndMark(isDestination: true)
                    }
                }
            }
            UserAnnotation()
        }
        .mapStyle(.standard(elevation: .realistic, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
        .mapControls {
            MapCompass().mapControlVisibility(.hidden)
        }
        .onMapCameraChange(frequency: .onEnd) { _ in
            if model.isNavigating && position.positionedByUser { following = false }
        }
    }
}

/// Label at the darkest point of the best-lit route.
private struct ExploreDarkestLabel: View {
    let spot: ExploreDarkSpot

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 5) {
                ExploreWarningMark(size: 9)
                Text(ExploreLux.label(spot.lux))
                    .font(Lx.font(11, .medium))
                    .foregroundStyle(Lx.fgStrong)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Rectangle().fill(Lx.panel.opacity(0.94)))
            .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
            Rectangle().fill(Lx.line2).frame(width: Lx.hairline, height: 8)
        }
        .allowsHitTesting(false)
    }
}

/// Invisible view that watches the GPS fix counter, so only it (not the whole screen) re-renders per fix.
@MainActor
private struct ExploreFixListener: View {
    let location: ExploreLocation
    let onFix: () -> Void

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .onChange(of: location.fixCount) { _, _ in onFix() }
    }
}

/// Follow-cam timing and heading smoothing (shared by Explore navigation).
final class ExploreFollowCam {
    /// Fastest camera update rate while following (s between updates).
    static let minInterval: Double = 0.2
    /// Longest linear glide (a slower GPS just holds the camera at the last fix).
    static let maxGlide: Double = 1.0
    /// Heading smoothing time constant (s): corners turn the camera over about this long.
    static let headingTau: Double = 0.6

    private(set) var lastUpdate: Date = Date.distantPast
    private(set) var heading: Double = -1
    /// End of the last deliberate (ease-in-out) camera move.
    private(set) var busyUntil: Date = Date.distantPast

    /// Starts over at `heading` (Go / Re-centre). Returns the heading to use.
    func reset(heading h: Double, at now: Date) -> Double {
        heading = ExploreFollowCam.normalized(h)
        lastUpdate = now
        busyUntil = now.addingTimeInterval(0.8)
        return heading
    }

    /// One follow step: the smoothed heading and how long the linear move should take. Nil = too soon, skip.
    func step(heading raw: Double, at now: Date) -> (heading: Double, duration: Double)? {
        let dt: Double = now.timeIntervalSince(lastUpdate)
        if dt < ExploreFollowCam.minInterval { return nil }
        lastUpdate = now
        let target: Double = ExploreFollowCam.normalized(raw)
        if heading < 0 || dt > 3 {
            heading = target
        } else {
            var diff: Double = target - heading
            if diff > 180 { diff -= 360 }
            if diff < -180 { diff += 360 }
            let alpha: Double = 1.0 - exp(-dt / ExploreFollowCam.headingTau)
            heading = ExploreFollowCam.normalized(heading + diff * alpha)
        }
        return (heading, min(max(dt, ExploreFollowCam.minInterval), ExploreFollowCam.maxGlide))
    }

    static func normalized(_ h: Double) -> Double {
        let r: Double = h.truncatingRemainder(dividingBy: 360)
        return r < 0 ? r + 360 : r
    }
}
