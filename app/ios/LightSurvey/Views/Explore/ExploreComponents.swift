import SwiftUI
import MapKit

/// Small shared pieces for the Explore screens. Everything sharp: no corner radius, 1 px hairlines.

enum ExploreStyle {
    /// Initial camera over the surveyed part of campus.
    static let campusCamera: MapCamera = MapCamera(centerCoordinate: CLLocationCoordinate2D(latitude: 30.61389, longitude: -96.34027),
                                                   distance: 2600, heading: 0, pitch: 0)
}

/// Triangle like the logo's: used for low-light warnings.
struct ExploreTriangle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

/// Red low-light marker: 40 % fill + full stroke, like the logo triangle.
struct ExploreWarningMark: View {
    var size: CGFloat = 11

    var body: some View {
        ZStack {
            ExploreTriangle().fill(Lx.red.opacity(0.4))
            ExploreTriangle().stroke(Lx.red, style: StrokeStyle(lineWidth: 1.2, lineJoin: .miter))
        }
        .frame(width: size, height: size * 0.9)
        .allowsHitTesting(false)
    }
}

/// Square end marker for From (white) / To (lamplight).
struct ExploreEndMark: View {
    let isDestination: Bool

    var body: some View {
        Rectangle()
            .fill(isDestination ? Lx.light : Lx.fgStrong)
            .frame(width: 12, height: 12)
            .overlay(Rectangle().strokeBorder(Lx.bg, lineWidth: 2))
            .allowsHitTesting(false)
    }
}

/// Line key for the route card: solid white (best-lit) or dashed grey (shortest).
struct ExploreLineKey: View {
    let dashed: Bool

    var body: some View {
        Canvas { ctx, size in
            var p = Path()
            p.move(to: CGPoint(x: 0, y: size.height / 2))
            p.addLine(to: CGPoint(x: size.width, y: size.height / 2))
            if dashed {
                ctx.stroke(p, with: .color(Lx.muted), style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
            } else {
                ctx.stroke(p, with: .color(Color.white), style: StrokeStyle(lineWidth: 3))
            }
        }
        .frame(width: 22, height: 8)
    }
}

/// Hairline divider.
struct ExploreRule: View {
    var body: some View {
        Rectangle().fill(Lx.line).frame(height: Lx.hairline)
    }
}

/// Square icon button used on the map (locate, recentre).
struct ExploreIconButton: View {
    let symbol: String
    let label: String
    var active: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(active ? Lx.bg : Lx.fgStrong)
                .frame(width: 44, height: 44)
                .background(Rectangle().fill(active ? Lx.fgStrong : Lx.panel.opacity(0.94)))
                .overlay(Rectangle().strokeBorder(active ? Lx.fgStrong : Lx.line2, lineWidth: Lx.hairline))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

/// One turn-by-turn row (Steps list).
struct ExploreStepRow: View {
    let step: ExploreStep

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: step.maneuver.symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Lx.fgStrong)
                .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.instruction)
                    .font(Lx.font(15, .medium))
                    .foregroundStyle(Lx.fgStrong)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    if step.maneuver != .arrive {
                        Text(ExploreLux.distance(step.length))
                    }
                    if let l = step.light {
                        Text("·")
                        Text(l)
                    }
                }
                .font(Lx.font(12))
                .foregroundStyle(Lx.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
    }
}
