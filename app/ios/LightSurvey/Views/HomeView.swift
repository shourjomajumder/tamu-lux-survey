import SwiftUI

/// Pick a walker and go. Everything else lives in Settings.
struct HomeView: View {
    @Environment(SurveyController.self) private var c
    @State private var freeGB: Double = -1
    @AppStorage("liveURL") private var liveURL = ""
    @AppStorage("lx.mode") private var modeRaw: String = AppMode.survey.rawValue

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topBar
                SvHairline()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 8) {
                            SvSectionTitle("Who's walking")
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                                ForEach(c.routes) { r in walkerTile(r) }
                            }
                        }

                        if !c.assignmentNote.isEmpty {
                            note(c.assignmentNote, icon: "map", color: Lx.light)
                        }
                        if c.recoveredSessions > 0 {
                            note("\(c.recoveredSessions) walk(s) stopped early. Data is saved — tap Resume.",
                                 icon: "arrow.clockwise", color: Lx.orange)
                        }

                        SvSection("Before you go") {
                            check(true, "Paper over the front camera")
                            check(!liveURL.trimmingCharacters(in: .whitespaces).isEmpty,
                                  liveURL.isEmpty ? "Dashboard not set (Settings)" : "Dashboard set")
                            check(powerOK, powerText)
                        }

                        if c.uploadPending > 0 {
                            note("Uploading \(c.uploadPending) files — keep the app open.\(c.uploadError.isEmpty ? "" : " Retrying: " + c.uploadError)",
                                 icon: "arrow.up", color: Lx.muted)
                        }
                        if let e = c.errorMessage {
                            note(e, icon: "exclamationmark.triangle", color: Lx.red)
                        }
                    }
                    .padding(16)
                }
                .refreshable { @MainActor in
                    c.checkAssignments()
                    c.hello()
                }
                SvHairline()
                startButton
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
            .background(Lx.bg.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .onAppear {
                UIDevice.current.isBatteryMonitoringEnabled = true
                freeGB = StorageInfo.freeGB()
                c.refreshWalkerStats()
                c.checkAssignments()
                c.hello()
            }
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 12) {
            LxLogo(height: 26)
            Text("Survey")
                .font(Lx.font(14, .medium))
                .foregroundStyle(Lx.muted)
            Spacer()
            NavigationLink { SessionsView() } label: {
                Image(systemName: "folder").frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Sessions"))
            NavigationLink { SurveySettingsView() } label: {
                Image(systemName: "gearshape").frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Settings"))
            Button {
                if !c.isRunning && !c.isStarting { modeRaw = "" }
            } label: {
                Text("Mode")
                    .font(Lx.font(12, .medium))
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
            }
            .buttonStyle(.plain)
            .disabled(c.isRunning || c.isStarting)
        }
        .font(.system(size: 17, weight: .regular))
        .foregroundStyle(Lx.fgStrong)
        .padding(.horizontal, 16)
        .frame(height: 56)
        .background(Lx.bg)
    }

    // MARK: Start

    private var startButton: some View {
        let f: Double = c.walkerFractions[c.selectedRouteID] ?? 0
        let title: String = c.isStarting ? "Starting cameras…"
            : (f > 0 ? "Resume walker \(c.selectedRouteID)" : "Start walker \(c.selectedRouteID)")
        return Button { c.start() } label: {
            HStack(spacing: 10) {
                if c.isStarting { ProgressView().tint(Lx.bg) }
                Text(title).font(Lx.font(17, .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(LxButtonStyle(primary: true))
        .disabled(c.isStarting || c.routes.isEmpty)
    }

    // MARK: Walker tile

    private func walkerTile(_ r: SurveyRoute) -> some View {
        let f: Double = c.walkerFractions[r.id] ?? 0
        let selected: Bool = c.selectedRouteID == r.id
        return Button { c.select(r.id) } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Rectangle().fill(r.swiftColor).frame(width: 8, height: 8)
                    Text(c.walkerTitle(r.id))
                        .font(Lx.font(15, .semibold))
                        .foregroundStyle(Lx.fgStrong)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if selected {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Lx.light)
                    }
                }
                SvBar(fraction: f, fill: f >= 0.995 ? Lx.light : Lx.red)
                Text(f >= 0.995 ? "Done" : (f > 0 ? "\(Int((f * 100).rounded()))% captured" : "Not started"))
                    .font(Lx.font(12))
                    .foregroundStyle(f >= 0.995 ? Lx.light : Lx.muted)
                Text("\(Fmt.km(r.total)) · ~\(Fmt.duration(r.total / 1.34))")
                    .font(Lx.font(11))
                    .foregroundStyle(Lx.muted)
                if r.variant != nil {
                    Text(r.name)
                        .font(Lx.font(11))
                        .foregroundStyle(Lx.light)
                        .lineLimit(2)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(selected ? Color.white.opacity(0.06) : Lx.panel))
            .overlay(Rectangle().strokeBorder(selected ? Lx.fgStrong : Lx.line, lineWidth: Lx.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Helpers

    private var powerOK: Bool {
        let bat = UIDevice.current.batteryLevel
        return (bat < 0 || bat > 0.5) && (freeGB < 0 || freeGB > 5)
    }

    private var powerText: String {
        let bat = UIDevice.current.batteryLevel
        let b = bat >= 0 ? "\(Int(bat * 100))%" : "—"
        let g = freeGB >= 0 ? String(format: "%.0f GB free", freeGB) : "—"
        return "Battery \(b) · \(g)"
    }

    private func check(_ ok: Bool, _ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: ok ? "checkmark" : "exclamationmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ok ? Lx.light : Lx.orange)
                .frame(width: 16)
            Text(text)
                .font(Lx.font(14))
                .foregroundStyle(ok ? Lx.fg : Lx.orange)
        }
    }

    private func note(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold))
            Text(text).font(Lx.font(13)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(color)
    }
}

/// Sharp 3 pt progress bar.
struct SvBar: View {
    let fraction: Double
    var fill: Color = Lx.red

    var body: some View {
        GeometryReader { (g: GeometryProxy) in
            ZStack(alignment: .leading) {
                Rectangle().fill(Lx.line2)
                Rectangle().fill(fill)
                    .frame(width: g.size.width * CGFloat(min(max(fraction, 0), 1)))
            }
        }
        .frame(height: 3)
    }
}

/// Everything that doesn't need to be on the home screen.
struct SurveySettingsView: View {
    @Environment(SurveyController.self) private var c
    @AppStorage("liveURL") private var liveURL = ""
    @AppStorage("lx.mode") private var modeRaw: String = AppMode.survey.rawValue
    @State private var confirmReset = false
    @State private var freeGB: Double = -1
    @State private var testResult = ""
    @AppStorage("uploadEnabled") private var uploadEnabled = true

    var body: some View {
        @Bindable var c = c
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SvSection("Live dashboard", footer: "Location, light, progress and problems go to the team every 2 s. No signal? Nothing is lost — it's all on the phone.") {
                    TextField("", text: $liveURL, prompt: Text("tamu-lux-survey.netlify.app").foregroundColor(Lx.muted))
                        .font(Lx.font(15))
                        .foregroundStyle(Lx.fgStrong)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(.horizontal, 10)
                        .frame(height: 40)
                        .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
                    Button("Test connection") {
                        testResult = "Testing…"
                        c.live.test { testResult = $0 }
                    }
                    .buttonStyle(LxButtonStyle())
                    if !testResult.isEmpty {
                        Text(testResult)
                            .font(Lx.font(12))
                            .foregroundStyle(testResult.hasSuffix("✓") ? Lx.light : Lx.orange)
                    }
                }

                SvSection("Light sensor") {
                    row("Calibration") {
                        Text(String(format: "× %.3f", c.calibration)).monospacedDigit().foregroundStyle(Lx.muted)
                    }
                    SvHairline()
                    NavigationLink { CalibrationView() } label: {
                        HStack {
                            Text("Calibrate this phone").font(Lx.font(15)).foregroundStyle(Lx.fgStrong)
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Lx.muted)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }

                SvSection("Recording") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Photo every").font(Lx.font(14)).foregroundStyle(Lx.fg)
                        SvChoice(options: [(label: "1 s", value: 1.0), (label: "2 s", value: 2.0), (label: "5 s", value: 5.0)],
                                 selection: $c.photoInterval)
                    }
                    SvHairline()
                    toggle("Video (for 3D)", isOn: $c.recordVideo)
                    toggle("Light snapshots every 5 s", isOn: $c.lightSnapshots)
                    toggle("Voice directions", isOn: Binding(get: { c.voiceOn }, set: { c.setVoice($0) }))
                    toggle("Upload every 5 min", isOn: $uploadEnabled)
                    SvHairline()
                    row("Free storage") {
                        Text(freeGB >= 0 ? String(format: "%.1f GB", freeGB) : "—")
                            .foregroundStyle(freeGB >= 0 && freeGB < 5 ? Lx.red : Lx.muted)
                    }
                }

                SvSection("Progress", footer: "Clears the progress map only. Recorded data stays in Sessions.") {
                    Button("Reset walker \(c.selectedRouteID)'s progress…") { confirmReset = true }
                        .font(Lx.font(15))
                        .foregroundStyle(Lx.red)
                        .buttonStyle(.plain)
                }

                SvSection("App mode", footer: "Explore finds the best-lit route. Survey records light for the team.") {
                    Button {
                        if !c.isRunning && !c.isStarting { modeRaw = "" }
                    } label: {
                        Text("Switch mode").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(LxButtonStyle())
                    .disabled(c.isRunning || c.isStarting)
                }
            }
            .padding(16)
        }
        .svNavChrome("Settings")
        .onAppear { freeGB = StorageInfo.freeGB() }
        .confirmationDialog("Clear walker \(c.selectedRouteID)'s progress map? Recorded data is kept.",
                            isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset progress", role: .destructive) { c.resetProgress(c.selectedRouteID) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func row<V: View>(_ title: String, @ViewBuilder value: () -> V) -> some View {
        HStack {
            Text(title).font(Lx.font(15)).foregroundStyle(Lx.fg)
            Spacer()
            value().font(Lx.font(15))
        }
    }

    private func toggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title).font(Lx.font(15)).foregroundStyle(Lx.fg)
        }
        .tint(Lx.red)
    }
}

enum StorageInfo {
    static func freeGB() -> Double {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        if let v = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let cap = v.volumeAvailableCapacityForImportantUsage {
            return Double(cap) / 1_000_000_000
        }
        return -1
    }
}

struct SurveySummarySheet: View {
    @Environment(SurveyController.self) private var c
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                LxLogo(height: 22)
                Spacer()
            }
            Text("Walk saved")
                .font(Lx.font(26, .semibold))
                .foregroundStyle(Lx.fgStrong)
            Text(c.summaryText)
                .font(Lx.font(15))
                .foregroundStyle(Lx.fg)
                .fixedSize(horizontal: false, vertical: true)
            if let url = c.lastSessionURL {
                Text(url.lastPathComponent)
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
                Text("Files app → On My iPhone → LightSurvey → Sessions. Upload status is in Sessions.")
                    .font(Lx.font(13))
                    .foregroundStyle(Lx.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button { dismiss() } label: {
                Text("Done").frame(maxWidth: .infinity)
            }
            .buttonStyle(LxButtonStyle(primary: true))
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Lx.bg.ignoresSafeArea())
        .presentationDetents([.medium])
        .presentationBackground(Lx.bg)
    }
}
