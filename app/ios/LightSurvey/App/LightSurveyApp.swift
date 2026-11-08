import SwiftUI

@main
struct LightSurveyApp: App {
    @State private var controller = SurveyController()

    init() {
        // Every launch opens on the mode chooser (Explore / Survey). The last pick is only kept as "lx.lastMode".
        let d = UserDefaults.standard
        if let last = d.string(forKey: "lx.mode"), !last.isEmpty { d.set(last, forKey: "lx.lastMode") }
        d.set("", forKey: "lx.mode")
    }

    var body: some Scene {
        WindowGroup {
            AppModeRoot()
                .environment(controller)
                .preferredColorScheme(.dark)
                .tint(Lx.light)
        }
    }
}

/// Every launch: pick Explore or Survey (the app always opens here). Each mode has a button to come back here.
struct AppModeRoot: View {
    @AppStorage("lx.mode") private var modeRaw: String = ""

    var body: some View {
        Group {
            switch AppMode(rawValue: modeRaw) {
            case .some(.explore):
                ExploreRootView(onSwitchMode: { modeRaw = "" })
            case .some(.survey):
                RootView()
            case .none:
                AppModeChooserView { (m: AppMode) in modeRaw = m.rawValue }
            }
        }
        .background(Lx.bg.ignoresSafeArea())
    }
}

/// The surveyor (walker) app.
struct RootView: View {
    @Environment(SurveyController.self) private var c
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var c = c
        Group {
            if c.isRunning {
                NavScreen()
            } else {
                HomeView()
            }
        }
        .sheet(isPresented: $c.showSummary) { SurveySummarySheet() }
        .onAppear { c.location.requestPermission() }
        // Leaving the app (lock button, call, switching apps) pauses recording and saves
        // everything to disk; coming back resumes automatically.
        .onChange(of: scenePhase) { _, phase in
            c.setAppActive(phase == .active)
            // only once a walker was picked on the home screen (tapping an assignment) this launch
            if phase == .active, let w = c.chosenWalker { c.hello(w) }
        }
    }
}
