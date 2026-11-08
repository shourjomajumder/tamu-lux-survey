import SwiftUI
import UIKit

/// Shared look for both app modes, copied from the website (css/app.css):
/// dark, sharp corners, 1 px hairlines, Inter-like type, lamplight accent, logo red.
enum Lx {
    static let bg: Color = Color(red: 8.0 / 255.0, green: 9.0 / 255.0, blue: 11.0 / 255.0)            // #08090B
    static let panel: Color = Color(red: 12.0 / 255.0, green: 13.0 / 255.0, blue: 16.0 / 255.0)       // #0C0D10
    static let line: Color = Color(red: 31.0 / 255.0, green: 34.0 / 255.0, blue: 40.0 / 255.0)        // #1F2228 hairline
    static let line2: Color = Color(red: 42.0 / 255.0, green: 45.0 / 255.0, blue: 52.0 / 255.0)       // #2A2D34
    static let fg: Color = Color(red: 232.0 / 255.0, green: 233.0 / 255.0, blue: 236.0 / 255.0)       // #E8E9EC
    static let fgStrong: Color = Color(red: 242.0 / 255.0, green: 242.0 / 255.0, blue: 242.0 / 255.0) // #F2F2F2
    static let muted: Color = Color(red: 139.0 / 255.0, green: 144.0 / 255.0, blue: 153.0 / 255.0)    // #8B9099
    static let light: Color = Color(red: 255.0 / 255.0, green: 226.0 / 255.0, blue: 170.0 / 255.0)    // #FFE2AA lamplight accent
    static let red: Color = Color(red: 192.0 / 255.0, green: 0.0, blue: 0.0)                           // #C00000 brand red
    static let orange: Color = Color(red: 255.0 / 255.0, green: 138.0 / 255.0, blue: 30.0 / 255.0)    // #FF8A1E stripe orange

    static let hairline: CGFloat = 1

    /// True when an "Inter" font family is bundled with the app (and listed under UIAppFonts).
    private static let hasInter: Bool = UIFont.familyNames.contains { $0 == "Inter" }

    /// Inter if bundled, else the system font (SF Pro, the closest built-in match).
    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        if hasInter {
            return Font.custom("Inter", size: size).weight(weight)
        }
        return Font.system(size: size, weight: weight, design: .default)
    }
}

/// Which half of the app is shown. Saved in @AppStorage("lx.mode").
enum AppMode: String {
    case explore, survey
}

// MARK: - Logo

/// The "lx" glyph outlines from img/logo.svg, in the SVG's own units (viewBox 74.42 183.93 92.61 × 43.69).
private struct LxGlyphShape: Shape {
    func path(in rect: CGRect) -> Path {
        let t = LxLogoGeometry.transform(in: rect)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { t(x, y) }
        var path = Path()
        // "l"
        path.move(to: p(74.916, 224.906))
        path.addLine(to: p(82.098, 224.906))
        path.addLine(to: p(82.098, 185.0))
        path.addLine(to: p(74.916, 185.0))
        path.closeSubpath()
        // "x"
        path.move(to: p(83.324, 224.906))
        path.addLine(to: p(91.964, 224.906))
        path.addLine(to: p(98.228, 214.646))
        path.addLine(to: p(104.492, 224.906))
        path.addLine(to: p(113.132, 224.906))
        path.addLine(to: p(102.494, 209.462))
        path.addLine(to: p(111.62, 194.99))
        path.addLine(to: p(103.52, 194.99))
        path.addLine(to: p(98.228, 204.008))
        path.addLine(to: p(92.828, 194.99))
        path.addLine(to: p(84.728, 194.99))
        path.addLine(to: p(93.908, 209.462))
        path.closeSubpath()
        return path
    }
}

/// The red triangle from img/logo.svg.
private struct LxTriangleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let t = LxLogoGeometry.transform(in: rect)
        var path = Path()
        path.move(to: t(143.16, 188.65))
        path.addLine(to: t(164.22, 225.37))
        path.addLine(to: t(122.10, 225.37))
        path.closeSubpath()
        return path
    }
}

private enum LxLogoGeometry {
    static let minX: CGFloat = 74.42
    static let minY: CGFloat = 183.93
    static let width: CGFloat = 92.61
    static let height: CGFloat = 43.69
    static let strokeWidth: CGFloat = 3.51

    /// Maps SVG coordinates into `rect`, keeping the aspect ratio (centred, like preserveAspectRatio="xMidYMid meet").
    static func transform(in rect: CGRect) -> (CGFloat, CGFloat) -> CGPoint {
        let s: CGFloat = min(rect.width / width, rect.height / height)
        let ox: CGFloat = rect.minX + (rect.width - width * s) / 2
        let oy: CGFloat = rect.minY + (rect.height - height * s) / 2
        let x0: CGFloat = minX
        let y0: CGFloat = minY
        return { (x: CGFloat, y: CGFloat) -> CGPoint in
            CGPoint(x: ox + (x - x0) * s, y: oy + (y - y0) * s)
        }
    }
}

/// "lx" + red triangle, drawn natively from the website logo's path data.
struct LxLogo: View {
    let height: CGFloat

    init(height: CGFloat = 28) {
        self.height = height
    }

    var body: some View {
        let scale: CGFloat = height / LxLogoGeometry.height
        let width: CGFloat = LxLogoGeometry.width * scale
        ZStack {
            LxGlyphShape()
                .fill(Lx.fgStrong)
            LxTriangleShape()
                .fill(Lx.red.opacity(0.4))
            LxTriangleShape()
                .stroke(Lx.red, style: StrokeStyle(lineWidth: LxLogoGeometry.strokeWidth * scale, lineCap: .butt, lineJoin: .miter, miterLimit: 8))
        }
        .frame(width: width, height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("lx"))
    }
}

// MARK: - Button

/// Sharp button like the website's .btn / .btn.primary: no corner radius, 1 px border.
struct LxButtonStyle: ButtonStyle {
    let primary: Bool

    init(primary: Bool = false) {
        self.primary = primary
    }

    func makeBody(configuration: Configuration) -> some View {
        LxButtonBody(label: configuration.label, primary: primary, pressed: configuration.isPressed)
    }
}

private struct LxButtonBody<L: View>: View {
    let label: L
    let primary: Bool
    let pressed: Bool
    @Environment(\.isEnabled) private var isEnabled: Bool

    var body: some View {
        let fill: Color = primary ? Lx.fgStrong : Color.white.opacity(pressed ? 0.12 : 0.07)
        let border: Color = primary ? Lx.fgStrong : Lx.line2
        let text: Color = primary ? Lx.bg : Lx.fgStrong
        label
            .font(Lx.font(15, .medium))
            .foregroundStyle(text)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(Rectangle().fill(fill))
            .overlay(Rectangle().strokeBorder(border, lineWidth: Lx.hairline))
            .opacity(isEnabled ? (pressed && primary ? 0.85 : 1.0) : 0.4)
            .contentShape(Rectangle())
    }
}

// MARK: - Panel

/// Panel background + 1 px Lx.line border, no radius. Pads its content by 14 pt and fills the width.
struct LxPanel<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(Lx.panel))
            .overlay(Rectangle().strokeBorder(Lx.line, lineWidth: Lx.hairline))
    }
}
