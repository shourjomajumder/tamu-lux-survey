import SwiftUI
import MapKit
import Observation

/// Google-Maps-style walking guidance: live GPS, route on the map, turn banner, voice prompts.
struct NavScreen: View {
    @Environment(SurveyController.self) private var c
    @State private var camera: MapCameraPosition = .userLocation(followsHeading: true, fallback: .automatic)
    @State private var confirmStop = false
    @State private var following = true
    @State private var bigPreview = false
    /// Follow-cam timing / heading smoothing. Plain class: writing to it never re-renders anything.
    @State private var follow = NavFollowCam()

    /// Route line looks, same as the website's "Route Indicators".
    fileprivate enum RouteLine {
        static let todo: Color = Color(white: 0.88)
        static let todoStyle = StrokeStyle(lineWidth: 3, lineCap: .butt, lineJoin: .round, dash: [7, 6])
        static let doneWidth: CGFloat = 6
        static let stripeStyle = StrokeStyle(lineWidth: 4, lineCap: .butt, lineJoin: .round, dash: [2, 6])
        static let missedWidth: CGFloat = 6
    }

    var body: some View {
        ZStack(alignment: .top) {
            // The Map is its own view: lux, timers, battery, banners etc. update this screen 4×/s,
            // but only route / coverage / position changes reach the Map's content.
            NavMapView(camera: $camera, following: $following)
                .onChange(of: c.locationTick) { _, _ in followCam() }
                .onAppear { followCam(animated: false) }
                .ignoresSafeArea()

            VStack(spacing: 8) {
                topBar
                HStack(alignment: .top, spacing: 8) {
                    turnBanner
                    luxBadge
                }
                .padding(.horizontal, 10)
                if !c.atStart {
                    startBanner
                } else if !c.targetText.isEmpty {
                    infoChip("\(c.targetText) · \(Int(c.distToTarget)) m", icon: "mappin")
                }
                ForEach(c.alerts.prefix(1)) { a in alertRow(a) }
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        if !following {
                            mapButton("Re-center", icon: "location.north.line") {
                                following = true
                                followCam(jump: true)
                            }
                        }
                        mapButton("Overview", icon: "map") {
                            following = false
                            withAnimation(.easeInOut(duration: 0.8)) { camera = .automatic }   // fits the whole route
                        }
                    }
                    Spacer()
                    viewfinder
                }
                .padding(.horizontal, 10)
                bottomPanel
            }
            .padding(.top, 2)
        }
        .confirmationDialog("End this walk and save the data?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("End & save", role: .destructive) { c.stop() }
            Button("Keep walking", role: .cancel) {}
        }
    }

    // MARK: Follow-cam (like Google Maps navigation)

    /// Close-up, tilted view centred just ahead of you, turned to face your direction of travel.
    /// Per fix: a linear glide as long as the gap between fixes (so fixes chain into one smooth motion)
    /// with a smoothed heading. `jump`: a deliberate move (Re-center) with an ease-in-out.
    private func followCam(animated: Bool = true, jump: Bool = false) {
        guard following, let u = c.userCoord else { return }
        let now = Date()
        let raw = c.travelHeading
        if !animated || jump {
            let heading = follow.reset(heading: raw, at: now, busy: jump ? 0.8 : 0)
            let mc = MapCamera(centerCoordinate: u, distance: c.atStart ? 320 : 650, heading: heading, pitch: c.atStart ? 50 : 30)
            if jump {
                withAnimation(.easeInOut(duration: 0.8)) { camera = .camera(mc) }
            } else {
                camera = .camera(mc)
            }
            return
        }
        if now < follow.busyUntil { return }
        guard let step = follow.step(heading: raw, at: now) else { return }
        let mc = MapCamera(centerCoordinate: u, distance: c.atStart ? 320 : 650, heading: step.heading, pitch: c.atStart ? 50 : 30)
        withAnimation(.linear(duration: step.duration)) { camera = .camera(mc) }
    }

    // MARK: Top bar: logo + recording status

    private var topBar: some View {
        HStack(spacing: 10) {
            LxLogo(height: 20)
            Rectangle().fill(c.collecting ? Lx.red : Lx.muted).frame(width: 8, height: 8)
            Text(c.collectStatus)
                .font(Lx.font(12, .medium))
                .foregroundStyle(c.collecting ? Lx.fgStrong : Lx.fg)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(c.walkerTitle(c.selectedRouteID))
                .font(Lx.font(12))
                .foregroundStyle(Lx.muted)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(Rectangle().fill(Lx.bg.opacity(0.92)))
        .overlay(Rectangle().strokeBorder(Lx.line, lineWidth: Lx.hairline))
        .padding(.horizontal, 10)
    }

    private func mapButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(Lx.font(13, .medium))
        }
        .buttonStyle(LxButtonStyle())
        .background(Rectangle().fill(Lx.bg.opacity(0.85)))
    }

    private var luxBadge: some View {
        let v = c.lux
        let text = v.isFinite ? String(format: v < 10 ? "%.1f" : "%.0f", v) : "—"
        let tint: Color = !v.isFinite ? Lx.muted : (v < 1 ? Lx.red : (v < 5 ? Lx.orange : Lx.light))
        return VStack(alignment: .trailing, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(text)
                    .font(Lx.font(30, .light))
                    .foregroundStyle(tint)
                    .monospacedDigit()
                Text("lx").font(Lx.font(13, .medium)).foregroundStyle(Lx.muted)
            }
            Text("LIVE")
                .font(Lx.font(9, .semibold))
                .tracking(1)
                .foregroundStyle(Lx.muted)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Rectangle().fill(Lx.panel.opacity(0.94)))
        .overlay(Rectangle().strokeBorder(Lx.line, lineWidth: Lx.hairline))
        .overlay(alignment: .top) { Rectangle().fill(tint).frame(height: 2) }
    }

    // MARK: Back-camera viewfinder (tap to enlarge)

    private var viewfinder: some View {
        let w: CGFloat = bigPreview ? 210 : 105
        return ZStack(alignment: .bottomLeading) {
            if let img = c.previewImage {
                Image(decorative: img, scale: 1, orientation: .right)
                    .resizable()
                    .scaledToFill()
            } else {
                Lx.bg
                Text(c.captureModeText.contains("only") ? "No back camera" : "Starting camera…")
                    .font(Lx.font(10)).foregroundStyle(Lx.muted).padding(6)
            }
            HStack(spacing: 3) {
                Image(systemName: "camera.fill")
                Text("\(c.photoCount)")
            }
            .font(Lx.font(10, .semibold))
            .foregroundStyle(Lx.fgStrong)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(Rectangle().fill(Lx.bg.opacity(0.7)))
        }
        .frame(width: w, height: w * 4 / 3)
        .clipShape(Rectangle())
        .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
        .onTapGesture { withAnimation(.snappy) { bigPreview.toggle() } }
    }

    // MARK: Turn banner

    private var turnBanner: some View {
        let next = c.nextStep
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: StepIcon.symbol(next?.icon ?? "finish"))
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(Lx.light)
                    .frame(width: 40)
                VStack(alignment: .leading, spacing: 1) {
                    Text(next == nil ? "Arrive" : Fmt.distance(c.distToNext))
                        .font(Lx.font(24, .semibold))
                        .foregroundStyle(Lx.fgStrong)
                        .monospacedDigit()
                    Text(next?.txt ?? "Finish")
                        .font(Lx.font(14, .medium))
                        .foregroundStyle(Lx.fg)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            if let then = c.thenStep {
                Text("Then: \(then.txt)")
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
                    .lineLimit(1)
            }
        }
        .padding(12)
        .background(Rectangle().fill(Lx.panel.opacity(0.94)))
        .overlay(Rectangle().strokeBorder(Lx.line, lineWidth: Lx.hairline))
    }

    /// Step 1: get to the start point before anything records.
    private var startBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "flag").font(.system(size: 18, weight: .semibold)).foregroundStyle(Lx.light)
            VStack(alignment: .leading, spacing: 2) {
                Text(c.hasFix ? "Walk to the pin — \(Int(c.distToStart)) m" : "Finding you…")
                    .font(Lx.font(15, .semibold))
                    .foregroundStyle(Lx.fgStrong)
                Text(c.resumed ? "Recording resumes where your data stops." : "Recording starts at the start.")
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
            }
            Spacer(minLength: 0)
            Button("I'm here") { c.startHere() }
                .buttonStyle(LxButtonStyle(primary: true))
        }
        .padding(12)
        .background(Rectangle().fill(Lx.panel.opacity(0.96)))
        .overlay(Rectangle().strokeBorder(Lx.light.opacity(0.6), lineWidth: Lx.hairline))
        .padding(.horizontal, 10)
    }

    private func alertRow(_ a: SurveyAlert) -> some View {
        let accent: Color = a.level == .bad ? Lx.red : (a.level == .warn ? Lx.orange : (a.level == .good ? Lx.light : Lx.muted))
        let bg: Color = a.level == .bad ? Lx.red : Lx.panel.opacity(0.96)
        return HStack(spacing: 10) {
            Image(systemName: a.icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(a.level == .bad ? Lx.fgStrong : accent)
            Text(a.text)
                .font(Lx.font(13, .medium))
                .foregroundStyle(Lx.fgStrong)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if a.action == .guideBack {
                Button("Guide me") { c.guideToGap() }
                    .buttonStyle(LxButtonStyle(primary: true))
            } else if a.action == .retryCamera {
                Button("Retry") { c.retryCamera() }
                    .buttonStyle(LxButtonStyle(primary: true))
            }
        }
        .padding(10)
        .background(Rectangle().fill(bg))
        .overlay(Rectangle().strokeBorder(accent, lineWidth: Lx.hairline))
        .padding(.horizontal, 10)
    }

    private func infoChip(_ text: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(Lx.red)
            Text(text).foregroundStyle(Lx.fgStrong)
        }
        .font(Lx.font(12, .medium))
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Rectangle().fill(Lx.panel.opacity(0.94)))
        .overlay(Rectangle().strokeBorder(Lx.line, lineWidth: Lx.hairline))
    }

    // MARK: Bottom panel

    private var bottomPanel: some View {
        VStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(c.atStart ? "\(Fmt.duration(c.remaining / 1.34)) left" : "Head to start")
                    .font(Lx.font(18, .semibold))
                    .foregroundStyle(Lx.fgStrong)
                Spacer()
                Text("\(Int((c.coverageFraction * 100).rounded()))% captured")
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
            }
            SvBar(fraction: c.coverageFraction, fill: Lx.red)
            routeLegend
            HStack {
                Label("\(c.photoCount)", systemImage: "camera")
                Spacer()
                Label(c.gpsAccuracy >= 0 ? "±\(Int(c.gpsAccuracy)) m" : "—", systemImage: "location")
                    .foregroundStyle(c.gpsAccuracy > SurveyController.goodAccuracy ? Lx.orange : Lx.muted)
                Spacer()
                Label(c.batteryLevel >= 0 ? "\(Int(c.batteryLevel * 100))%" : "—", systemImage: "battery.75")
                    .foregroundStyle(c.batteryLevel >= 0 && c.batteryLevel <= 0.2 ? Lx.red : Lx.muted)
                Spacer()
                Label(Fmt.duration(c.elapsed), systemImage: "clock")
                Spacer()
                Label(c.liveOK ? "Live" : "Offline", systemImage: c.liveOK ? "wifi" : "wifi.slash")
                    .foregroundStyle(c.liveOK ? Lx.light : Lx.muted)
            }
            .font(Lx.font(12))
            .foregroundStyle(Lx.muted)
            .labelStyle(CompactLabel())
            if UploadManager.shared.enabled {
                HStack(spacing: 4) {
                    Image(systemName: c.uploadPending > 0 ? "arrow.up" : "checkmark")
                    Text(uploadText)
                }
                .font(Lx.font(11))
                .foregroundStyle(c.uploadError.isEmpty ? Lx.muted : Lx.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !c.liveOK && c.liveStatus != "Not tried yet" {
                Text("Dashboard: \(c.liveStatus)")
                    .font(Lx.font(11)).foregroundStyle(Lx.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if c.captureModeText.contains("only") {
                Text("This iPhone can't run both cameras: light only, no photos.")
                    .font(Lx.font(11)).foregroundStyle(Lx.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                Menu {
                    Button("Light out / broken") { c.mark("light_out") }
                    Button("Flickering light") { c.mark("flicker") }
                    Button("Very dark spot") { c.mark("very_dark") }
                    Button("Glare / too bright") { c.mark("glare") }
                    Button("Blocked path / detour") { c.mark("blocked_path") }
                    Button("Other note") { c.mark("other") }
                } label: {
                    Label("Mark", systemImage: "mappin")
                        .font(Lx.font(15, .medium))
                        .foregroundStyle(Lx.fgStrong)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(Rectangle().fill(Color.white.opacity(0.07)))
                        .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
                }
                Button { c.setVoice(!c.voiceOn) } label: {
                    Image(systemName: c.voiceOn ? "speaker.wave.2" : "speaker.slash")
                        .frame(width: 22)
                }
                .buttonStyle(LxButtonStyle())
                .accessibilityLabel(Text(c.voiceOn ? "Voice on" : "Voice off"))
                Button { confirmStop = true } label: {
                    Label("End", systemImage: "stop.fill")
                        .font(Lx.font(15, .semibold))
                        .foregroundStyle(Lx.fgStrong)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(Rectangle().fill(Lx.red))
                        .overlay(Rectangle().strokeBorder(Lx.red, lineWidth: Lx.hairline))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(Rectangle().fill(Lx.bg.opacity(0.94)))
        .overlay(alignment: .top) { Rectangle().fill(Lx.line).frame(height: Lx.hairline) }
    }

    /// Key for the three route looks.
    private var routeLegend: some View {
        HStack(spacing: 14) {
            legendItem("To record") {
                RouteSwatch(dashed: true, base: RouteLine.todo, stripe: nil)
            }
            legendItem("Captured") {
                RouteSwatch(dashed: false, base: Lx.red, stripe: Lx.orange)
            }
            legendItem("Missed") {
                RouteSwatch(dashed: false, base: Lx.red.opacity(0.3), stripe: nil)
            }
            Spacer(minLength: 0)
        }
    }

    private func legendItem<S: View>(_ title: String, @ViewBuilder swatch: () -> S) -> some View {
        HStack(spacing: 6) {
            swatch().frame(width: 22, height: 6)
            Text(title).font(Lx.font(11)).foregroundStyle(Lx.muted)
        }
    }

    private var uploadText: String {
        var t = "Uploads every 5 min"
        if !c.uploadChunksDone.isEmpty { t += " · \(c.uploadChunksDone.count) sent" }
        if c.uploadPending > 0 {
            t += " · \(c.uploadPending) files waiting"
            if !c.uploadError.isEmpty { t += " (retrying: \(c.uploadError))" }
        }
        return t
    }
}

/// Survey map. Its content reads only what is drawn as map content (coverage runs, next-leg halo,
/// start / target pins), so GPS fixes, compass updates and the 4×/s status updates of the screen above
/// never make MapKit rebuild its overlays. The phone-heading beam follows the walker in a light overlay.
private struct NavMapView: View {
    @Environment(SurveyController.self) private var c
    @Binding var camera: MapCameraPosition
    @Binding var following: Bool
    /// Map camera for the beam overlay. Updated every frame while the camera moves,
    /// so it lives in its own observable box that only the beam reads.
    @State private var mapCamera = NavMapCamera()

    private typealias RouteLine = NavScreen.RouteLine

    var body: some View {
        let runs: [CoverageRun] = c.coverageRuns
        MapReader { proxy in
        Map(position: $camera) {
            // Next leg: soft lamplight halo under the route lines.
            if c.layerCurrent.count > 1 {
                MapPolyline(coordinates: c.layerCurrent)
                    .stroke(Lx.light.opacity(0.28), style: StrokeStyle(lineWidth: 14, lineCap: .round, lineJoin: .round))
            }
            // Still to record: dashed light line.
            ForEach(runs.filter { $0.state == .todo }) { run in
                MapPolyline(coordinates: run.coords)
                    .stroke(RouteLine.todo, style: RouteLine.todoStyle)
            }
            // Missed (walked past, no data): faded red.
            ForEach(runs.filter { $0.state == .missed }) { run in
                MapPolyline(coordinates: run.coords)
                    .stroke(Lx.red.opacity(0.3), style: StrokeStyle(lineWidth: RouteLine.missedWidth, lineCap: .butt, lineJoin: .round))
            }
            // Captured: solid red …
            ForEach(runs.filter { $0.state == .done }) { run in
                MapPolyline(coordinates: run.coords)
                    .stroke(Lx.red, style: StrokeStyle(lineWidth: RouteLine.doneWidth, lineCap: .butt, lineJoin: .round))
            }
            // … with short orange dashes on top, which read as stripes.
            ForEach(runs.filter { $0.state == .done }) { run in
                MapPolyline(coordinates: run.coords)
                    .stroke(Lx.orange, style: RouteLine.stripeStyle)
            }
            if let start = c.route?.start {
                Annotation("Start", coordinate: start) {
                    Rectangle()
                        .fill(Lx.fgStrong)
                        .frame(width: 12, height: 12)
                        .overlay(Rectangle().strokeBorder(Lx.bg, lineWidth: 2))
                }
            }
            if let t = c.targetCoord {
                Annotation("Record here", coordinate: t) {
                    Image(systemName: "mappin.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(Lx.fgStrong, Lx.red)
                }
            }
            UserAnnotation()
        }
        .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll, showsTraffic: false))
        .mapControls { MapCompass(); MapScaleView() }
        .onMapCameraChange(frequency: .continuous) { ctx in
            mapCamera.heading = ctx.camera.heading
            mapCamera.tick &+= 1
        }
        // Beam showing which way the phone (back camera) points.
        .overlay {
            NavHeadingBeamOverlay(controller: c, mapCamera: mapCamera, proxy: proxy)
        }
        }
        // Touching the map (pan / pinch / rotate) stops the follow-cam; Re-center brings it back.
        .simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { _ in following = false })
        .simultaneousGesture(MagnifyGesture().onChanged { _ in following = false })
    }
}

/// Map camera as last reported, observed only by the heading beam.
@Observable
final class NavMapCamera {
    var heading: Double = 0
    /// Bumps on every camera change (so the beam re-projects its position while the map moves).
    var tick: Int = 0
}

/// The phone-heading beam, drawn over the map at the walker's position. Re-renders on fixes, compass
/// and camera changes without touching the Map's content. The centre is cut out so the
/// location dot under it shows exactly as before.
private struct NavHeadingBeamOverlay: View {
    let controller: SurveyController
    let mapCamera: NavMapCamera
    let proxy: MapProxy

    var body: some View {
        GeometryReader { g in
            let origin = g.frame(in: .global).origin
            ZStack(alignment: .topLeading) {
                if controller.hasPhoneHeading, mapCamera.tick >= 0,
                   let u = beamCoordinate(), let p = proxy.convert(u, to: .global) {
                    HeadingBeam()
                        .overlay(Circle().frame(width: 22, height: 22).blendMode(.destinationOut))
                        .compositingGroup()
                        .rotationEffect(.degrees(controller.phoneHeading - mapCamera.heading))
                        .position(x: p.x - origin.x, y: p.y - origin.y)
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private func beamCoordinate() -> CLLocationCoordinate2D? {
        let real = controller.userCoord
        return real
    }
}

/// Follow-cam timing and heading smoothing for the survey map.
final class NavFollowCam {
    static let minInterval: Double = 0.2
    static let maxGlide: Double = 1.0
    static let headingTau: Double = 0.6

    private(set) var lastUpdate: Date = Date.distantPast
    private(set) var heading: Double = 0
    private(set) var busyUntil: Date = Date.distantPast

    /// Starts over (first frame / Re-center). A negative heading keeps the last one.
    func reset(heading raw: Double, at now: Date, busy: Double) -> Double {
        if raw >= 0 { heading = ExploreFollowCam.normalized(raw) }
        lastUpdate = now
        busyUntil = now.addingTimeInterval(busy)
        return heading
    }

    /// One follow step; nil = too soon after the last one.
    func step(heading raw: Double, at now: Date) -> (heading: Double, duration: Double)? {
        let dt = now.timeIntervalSince(lastUpdate)
        if dt < NavFollowCam.minInterval { return nil }
        lastUpdate = now
        if raw >= 0 {
            let target = ExploreFollowCam.normalized(raw)
            if dt > 3 {
                heading = target
            } else {
                var diff = target - heading
                if diff > 180 { diff -= 360 }
                if diff < -180 { diff += 360 }
                heading = ExploreFollowCam.normalized(heading + diff * (1.0 - exp(-dt / NavFollowCam.headingTau)))
            }
        }
        return (heading, min(max(dt, NavFollowCam.minInterval), NavFollowCam.maxGlide))
    }
}

/// A short horizontal sample of a route line style, for the legend.
private struct RouteSwatch: View {
    let dashed: Bool
    let base: Color
    let stripe: Color?

    var body: some View {
        Canvas { (ctx: inout GraphicsContext, size: CGSize) in
            var p = Path()
            p.move(to: CGPoint(x: 0, y: size.height / 2))
            p.addLine(to: CGPoint(x: size.width, y: size.height / 2))
            if dashed {
                ctx.stroke(p, with: .color(base), style: StrokeStyle(lineWidth: 2, lineCap: .butt, dash: [4, 3]))
            } else {
                ctx.stroke(p, with: .color(base), style: StrokeStyle(lineWidth: size.height, lineCap: .butt))
                if let stripe {
                    ctx.stroke(p, with: .color(stripe), style: StrokeStyle(lineWidth: size.height * 0.66, lineCap: .butt, dash: [1.5, 3.5]))
                }
            }
        }
    }
}

/// Icon + text, tight spacing, for the stats row.
struct CompactLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon; configuration.title }
    }
}

enum StepIcon {
    static func symbol(_ icon: String) -> String {
        switch icon {
        case "start": return "location.north.fill"
        case "straight": return "arrow.up"
        case "left": return "arrow.turn.up.left"
        case "right": return "arrow.turn.up.right"
        case "slight-left": return "arrow.up.left"
        case "slight-right": return "arrow.up.right"
        case "sharp-left": return "arrow.turn.left.down"
        case "sharp-right": return "arrow.turn.right.down"
        case "uturn": return "arrow.uturn.down"
        case "finish": return "flag.checkered"
        default: return "arrow.up"
        }
    }
}

enum Fmt {
    static func distance(_ m: Double) -> String {
        if m >= 1000 { return String(format: "%.1f km", m / 1000) }
        if m >= 100 { return "\(Int((m / 10).rounded()) * 10) m" }
        return "\(max(0, Int((m / 5).rounded()) * 5)) m"
    }
    static func km(_ m: Double) -> String { String(format: "%.1f km", m / 1000) }
    static func duration(_ s: Double) -> String {
        let total = Int(max(0, s))
        let h = total / 3600, m = (total % 3600) / 60
        return h > 0 ? "\(h) h \(m) min" : "\(m) min"
    }
}

/// Lamplight fan like Apple Maps' heading beam; points up = the phone's heading.
struct HeadingBeam: View {
    var body: some View {
        Wedge(spread: 50)
            .fill(RadialGradient(colors: [Lx.light.opacity(0.5), Lx.light.opacity(0.0)],
                                 center: .center, startRadius: 4, endRadius: 46))
            .frame(width: 92, height: 92)
    }
}

private struct Wedge: Shape {
    let spread: Double   // total angle in degrees
    func path(in r: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: r.midX, y: r.midY)
        p.move(to: c)
        p.addArc(center: c, radius: r.width / 2,
                 startAngle: .degrees(-90 - spread / 2), endAngle: .degrees(-90 + spread / 2), clockwise: false)
        p.closeSubpath()
        return p
    }
}
