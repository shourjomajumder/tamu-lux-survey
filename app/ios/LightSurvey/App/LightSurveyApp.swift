import SwiftUI

@main
struct LightSurveyApp: App {
    @State private var controller = SurveyController()

    var body: some Scene {
        WindowGroup {
            AppModeRoot()
                .environment(controller)
                .preferredColorScheme(.dark)
                .tint(Lx.light)
        }
    }
}

/// First open: pick Explore or Survey. The choice is remembered; each mode has a button to come back here.
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
            if phase == .active { c.hello() }
        }
    }
}
