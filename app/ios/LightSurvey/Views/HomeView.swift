import SwiftUI

/// Survey home: only the assignments sent from Survey Control (website). Tap one to get ready; nothing starts before that.
struct HomeView: View {
    @Environment(SurveyController.self) private var c
    @AppStorage("lx.mode") private var modeRaw: String = AppMode.survey.rawValue
    @State private var picked: SurveyAssignment?
    @State private var showPreWalk = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topBar
                SvHairline()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if c.assignments.isEmpty {
                            emptyState
                        } else {
                            VStack(alignment: .leading, spacing: 8) {
                                SvSectionTitle("Your assignments")
                                ForEach(c.assignments) { (a: SurveyAssignment) in assignmentCard(a) }
                            }
                        }
                        if c.uploadPending > 0 {
                            note("Uploading \(c.uploadPending) files — keep the app open.\(c.uploadError.isEmpty ? "" : " Retrying: " + c.uploadError)",
                                 icon: "arrow.up", color: Lx.muted)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { @MainActor in
                    c.checkAssignments()
                }
            }
            .background(Lx.bg.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(isPresented: $showPreWalk) {
                if let a = picked {
                    PreWalkView(assignment: a)
                }
            }
            .onAppear {
                UIDevice.current.isBatteryMonitoringEnabled = true
                c.checkAssignments()
            }
            .task {
                // keep the list current while the Survey home is on screen
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
                    if Task.isCancelled { break }
                    await MainActor.run { c.checkAssignments() }
                }
            }
        }
    }

    // MARK: Empty state

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("No assignments yet — waiting for Survey Control")
                .font(Lx.font(13))
                .foregroundStyle(Lx.muted)
                .multilineTextAlignment(.center)
            if !c.assignmentsStatus.isEmpty {
                Text(c.assignmentsStatus)
                    .font(Lx.font(11))
                    .foregroundStyle(Lx.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
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

    // MARK: Assignment card

    private func assignmentCard(_ a: SurveyAssignment) -> some View {
        let f: Double = c.fraction(for: a)
        let resume: Bool = f > 0 && f < 0.995
        let len: String = a.length_m.map { "\(Fmt.km($0)) · ~\(Fmt.duration($0 / 1.34))" } ?? ""
        return Button {
            guard !c.isRunning && !c.isStarting else { return }
            picked = a
            c.chooseAssignment(a)
            showPreWalk = true
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text(c.walkerTitle(a.walker))
                    .font(Lx.font(16, .semibold))
                    .foregroundStyle(Lx.fgStrong)
                    .lineLimit(1)
                Text(a.route_name)
                    .font(Lx.font(14))
                    .foregroundStyle(Lx.light)
                    .lineLimit(2)
                if !len.isEmpty {
                    Text(len)
                        .font(Lx.font(12))
                        .foregroundStyle(Lx.muted)
                }
                if f > 0 {
                    SvBar(fraction: f, fill: f >= 0.995 ? Lx.light : Lx.red)
                }
                HStack(spacing: 6) {
                    Text(resume ? "Tap to resume · \(Int((f * 100).rounded()))% captured" : (f >= 0.995 ? "Done · tap to walk again" : "Tap to start"))
                        .font(Lx.font(12, .medium))
                        .foregroundStyle(Lx.fgStrong)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(Lx.muted)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(Lx.panel))
            .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(c.isRunning || c.isStarting)
    }

    private func note(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold))
            Text(text).font(Lx.font(13)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(color)
    }
}

/// After tapping an assignment: the route is loaded for that walker, the usual checks are shown, and the walk
/// starts only from the Start button here (same start flow as before: camera access, walk to the start pin…).
struct PreWalkView: View {
    @Environment(SurveyController.self) private var c
    let assignment: SurveyAssignment
    @State private var freeGB: Double = -1
    @AppStorage("liveURL") private var liveURL = ""

    /// Still assigned in Survey Control (same walker, same route)?
    private var stillAssigned: Bool {
        c.assignments.contains { $0.walker == assignment.walker && $0.route_id == assignment.route_id }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(c.walkerTitle(assignment.walker))
                            .font(Lx.font(22, .semibold))
                            .foregroundStyle(Lx.fgStrong)
                        Text(assignment.route_name)
                            .font(Lx.font(15))
                            .foregroundStyle(Lx.light)
                        if let m = assignment.length_m {
                            Text("\(Fmt.km(m)) · ~\(Fmt.duration(m / 1.34))")
                                .font(Lx.font(12))
                                .foregroundStyle(Lx.muted)
                        }
                    }

                    if !stillAssigned {
                        note("This assignment was changed or cleared in Survey Control. Go back to see your assignments.",
                             icon: "exclamationmark.triangle", color: Lx.orange)
                    } else if !c.isReady(assignment) {
                        HStack(spacing: 8) {
                            ProgressView().tint(Lx.muted)
                            Text("Loading the route from Survey Control…")
                                .font(Lx.font(13))
                                .foregroundStyle(Lx.muted)
                        }
                    } else if c.recoveredSessions > 0 && fraction > 0 && fraction < 0.995 {
                        note("A walk on this route stopped early. Data is saved — tap Resume.",
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
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { @MainActor in
                c.chooseAssignment(assignment)
                c.checkAssignments()
            }
            SvHairline()
            startButton
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
        }
        .svNavChrome("Get ready")
        .onAppear {
            UIDevice.current.isBatteryMonitoringEnabled = true
            freeGB = StorageInfo.freeGB()
            if c.selectedRouteID != assignment.walker || !c.isReady(assignment) { c.chooseAssignment(assignment) }
            c.refreshWalkerStats()
        }
        .task {
            // retry loading the route until it's here, and notice if the assignment is cleared
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { break }
                await MainActor.run {
                    c.checkAssignments()
                    if !c.isRunning && !c.isStarting && !c.isReady(assignment) { c.chooseAssignment(assignment) }
                }
            }
        }
    }

    private var fraction: Double { c.isReady(assignment) ? (c.walkerFractions[assignment.walker] ?? 0) : 0 }

    private var canStart: Bool {
        stillAssigned && c.isReady(assignment) && c.selectedRouteID == assignment.walker && !c.isStarting && !c.isRunning
    }

    private var startButton: some View {
        let f: Double = fraction
        let title: String = c.isStarting ? "Starting cameras…"
            : (f > 0 && f < 0.995 ? "Resume walker \(assignment.walker)" : "Start walker \(assignment.walker)")
        return Button {
            guard canStart else { return }
            c.start()
        } label: {
            HStack(spacing: 10) {
                if c.isStarting { ProgressView().tint(Lx.bg) }
                Text(title).font(Lx.font(17, .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(LxButtonStyle(primary: true))
        .disabled(!canStart)
    }

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
