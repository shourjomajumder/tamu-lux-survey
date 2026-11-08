import SwiftUI
import CoreLocation

/// Step-by-step walking overlay: instruction banner on top, time / distance / light and End at the bottom.
@MainActor
struct ExploreNavigationView: View {
    let model: ExploreModel
    let navigator: ExploreNavigator
    let following: Bool
    let onRecenter: () -> Void
    let onEnd: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            banner
            Spacer(minLength: 0)
            HStack {
                Spacer()
                if !following {
                    ExploreIconButton(symbol: "location.north.line.fill", label: "Re-centre", action: onRecenter)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            bottomBar
        }
    }

    // MARK: Banner

    @ViewBuilder
    private var banner: some View {
        if navigator.arrived {
            LxPanel {
                HStack(spacing: 14) {
                    Image(systemName: ExploreManeuver.arrive.symbol)
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(Lx.light)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Arrived").font(Lx.font(24, .semibold)).foregroundStyle(Lx.fgStrong)
                        Text(model.to?.title ?? "").font(Lx.font(15)).foregroundStyle(Lx.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
        } else {
            VStack(spacing: 0) {
                LxPanel {
                    HStack(alignment: .center, spacing: 14) {
                        Image(systemName: (navigator.upcomingStep ?? navigator.currentStep)?.maneuver.symbol ?? "arrow.up")
                            .font(.system(size: 34, weight: .semibold))
                            .foregroundStyle(Lx.fgStrong)
                            .frame(width: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ExploreLux.distance(navigator.distanceToManeuver))
                                .font(Lx.font(28, .semibold))
                                .foregroundStyle(Lx.fgStrong)
                                .monospacedDigit()
                            Text(primaryText)
                                .font(Lx.font(17, .medium))
                                .foregroundStyle(Lx.fg)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                }
                if let line = secondaryText {
                    HStack(spacing: 8) {
                        if let sym = line.symbol {
                            Image(systemName: sym)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Lx.fg)
                        }
                        Text(line.text)
                            .font(Lx.font(13))
                            .foregroundStyle(navigator.offRoute ? Lx.orange : Lx.fg)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Rectangle().fill(Lx.bg.opacity(0.94)))
                    .overlay(Rectangle().strokeBorder(Lx.line, lineWidth: Lx.hairline))
                }
            }
        }
    }

    private var primaryText: String {
        if let up = navigator.upcomingStep { return up.instruction }
        return navigator.currentStep?.instruction ?? ""
    }

    private var secondaryText: (text: String, symbol: String?)? {
        if navigator.offRoute { return (text: "Off route · finding the best-lit way back", symbol: nil) }
        if !navigator.hasFix {
            return (text: model.location.isDenied ? "Location off · turn it on in Settings" : "Waiting for GPS", symbol: nil)
        }
        if navigator.stepIndex == 0 && navigator.progress < 20, let first = navigator.currentStep, navigator.upcomingStep != nil {
            return (text: first.instruction, symbol: first.maneuver.symbol)
        }
        if let t = navigator.thenStep { return (text: "Then \(t.instruction)", symbol: t.maneuver.symbol) }
        return nil
    }

    // MARK: Bottom bar

    private var bottomBar: some View {
        LxPanel {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(timeLine)
                        .font(Lx.font(17, .semibold))
                        .foregroundStyle(Lx.fgStrong)
                        .monospacedDigit()
                    Text(navigator.arrived ? "Best-lit route" : "Here · \(navigator.lightHere)")
                        .font(Lx.font(13))
                        .foregroundStyle(Lx.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Button(navigator.arrived ? "Done" : "End") { onEnd() }
                    .buttonStyle(LxButtonStyle(primary: navigator.arrived))
            }
        }
    }

    private var timeLine: String {
        if navigator.arrived { return "0 min · 0 m" }
        let rem: Double = navigator.remaining
        let mins: Int = ExploreLux.minutes(rem)
        let eta: Date = Date().addingTimeInterval(rem / ExploreGraph.walkingSpeed)
        let f: DateFormatter = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return "\(mins) min · \(ExploreLux.distance(rem)) · \(f.string(from: eta))"
    }
}
