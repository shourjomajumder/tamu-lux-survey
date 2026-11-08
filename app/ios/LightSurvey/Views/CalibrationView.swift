import SwiftUI

/// Calibrate the per-phone factor.
/// With a lux meter: hold both side by side (meter sensor and the phone's front camera facing the same way),
/// type the meter's reading, tap Set.
/// Without one: calibrate every phone against Phone 1 under the same streetlight, so all 4 agree.
struct CalibrationView: View {
    @Environment(SurveyController.self) private var c
    @State private var running = false
    @State private var raw: Double = .nan
    @State private var samples: [Double] = []
    @State private var reference = ""
    @State private var message = ""
    @State private var timer: Timer?

    var avgRaw: Double {
        let v = samples.suffix(30).filter { $0.isFinite && $0 > 0 }
        return v.isEmpty ? .nan : v.reduce(0, +) / Double(v.count)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                SvSection("Front camera · keep the paper on") {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Raw").font(Lx.font(14)).foregroundStyle(Lx.muted)
                        Spacer()
                        Text(avgRaw.isFinite ? String(format: "%.2f", avgRaw) : "—")
                            .font(Lx.font(34, .light))
                            .foregroundStyle(Lx.light)
                            .monospacedDigit()
                        Text("lx").font(Lx.font(14)).foregroundStyle(Lx.muted)
                    }
                    SvHairline()
                    HStack {
                        Text("Calibrated × \(String(format: "%.3f", c.calibration))").font(Lx.font(14)).foregroundStyle(Lx.fg)
                        Spacer()
                        Text(avgRaw.isFinite ? String(format: "%.2f lx", avgRaw * c.calibration) : "—")
                            .font(Lx.font(14)).foregroundStyle(Lx.fgStrong).monospacedDigit()
                    }
                    if let s = c.capture.latest {
                        Text(String(format: "1/%.0f s · ISO %.0f · f/%.2f · brightness %.2f", 1 / max(s.exposure, 1e-6), s.iso, s.fNumber, s.meanY))
                            .font(Lx.font(11)).foregroundStyle(Lx.muted)
                    }
                }

                SvSection("Set factor", footer: "Best: a lux meter held flat next to the front camera under a streetlight — wait 5 s, enter its reading. No meter? Put all phones under the same light and enter Phone 1's calibrated value on the others. Stand still.") {
                    TextField("", text: $reference, prompt: Text("Reference lux (meter or Phone 1)").foregroundColor(Lx.muted))
                        .keyboardType(.decimalPad)
                        .font(Lx.font(15))
                        .foregroundStyle(Lx.fgStrong)
                        .padding(.horizontal, 10)
                        .frame(height: 40)
                        .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
                    HStack(spacing: 8) {
                        Button {
                            guard let ref = Double(reference.replacingOccurrences(of: ",", with: ".")), ref > 0, avgRaw.isFinite, avgRaw > 0 else {
                                message = "Need a reference value and a live reading."; return
                            }
                            c.setCalibration(ref / avgRaw)
                            message = String(format: "Saved: × %.3f", ref / avgRaw)
                        } label: { Text("Set").frame(maxWidth: .infinity) }
                        .buttonStyle(LxButtonStyle(primary: true))
                        Button { c.setCalibration(1.0); message = "Reset." } label: {
                            Text("Reset to 1.0").foregroundStyle(Lx.red).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(LxButtonStyle())
                    }
                    if !message.isEmpty { Text(message).font(Lx.font(12)).foregroundStyle(Lx.light) }
                }
            }
            .padding(16)
        }
        .svNavChrome("Calibrate")
        .onAppear {
            c.capture.calibration = c.calibration
            c.capture.start(frontOnly: true) { err in
                if let err { message = err } else { running = true }
            }
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
                MainActor.assumeIsolated {
                    if let s = c.capture.latest { samples.append(s.rawLux); if samples.count > 60 { samples.removeFirst(samples.count - 60) } }
                }
            }
        }
        .onDisappear {
            timer?.invalidate(); timer = nil
            c.capture.stop()
        }
    }
}
