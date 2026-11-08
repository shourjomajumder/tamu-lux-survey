import SwiftUI

// Survey-mode building blocks on top of the shared Lx theme (App/LxTheme.swift).
// Names start with "Sv" / "AppMode" so they can't clash with the Explore mode's files.

/// First-open screen: choose Explore or Survey. Styled like the website's landing view.
struct AppModeChooserView: View {
    let onPick: (AppMode) -> Void

    var body: some View {
        ZStack {
            Lx.bg.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 40)
                LxLogo(height: 64)
                Text("Night light on campus")
                    .font(Lx.font(15))
                    .foregroundStyle(Lx.muted)
                    .padding(.top, 14)
                Spacer(minLength: 40)
                VStack(spacing: 12) {
                    option(.explore, title: "Explore", detail: "Find the best-lit route", icon: "figure.walk")
                    option(.survey, title: "Survey", detail: "Record light for the team", icon: "camera.aperture")
                }
                Text("You can switch later.")
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
                    .padding(.top, 14)
                Spacer(minLength: 24)
            }
            .padding(.horizontal, 24)
        }
    }

    private func option(_ mode: AppMode, title: String, detail: String, icon: String) -> some View {
        Button { onPick(mode) } label: {
            HStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(Lx.light)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(Lx.font(22, .semibold))
                        .foregroundStyle(Lx.fgStrong)
                    Text(detail)
                        .font(Lx.font(14))
                        .foregroundStyle(Lx.muted)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Lx.muted)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Rectangle().fill(Lx.panel))
            .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Small uppercase label above a panel, like the website's .label.
struct SvSectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(Lx.font(11, .medium))
            .tracking(0.8)
            .foregroundStyle(Lx.muted)
    }
}

/// Title + panel + optional footer note.
struct SvSection<Content: View>: View {
    let title: String
    let footer: String?
    private let content: Content

    init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !title.isEmpty { SvSectionTitle(title) }
            LxPanel {
                VStack(alignment: .leading, spacing: 12) { content }
            }
            if let footer {
                Text(footer)
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// 1 px horizontal rule.
struct SvHairline: View {
    var body: some View {
        Rectangle().fill(Lx.line).frame(height: Lx.hairline)
    }
}

/// Sharp chip-style choice row (replaces rounded segmented pickers).
struct SvChoice<Value: Hashable>: View {
    let options: [(label: String, value: Value)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<options.count, id: \.self) { (i: Int) in
                let o = options[i]
                let on: Bool = o.value == selection
                Button { selection = o.value } label: {
                    Text(o.label)
                        .font(Lx.font(13, on ? .semibold : .regular))
                        .foregroundStyle(on ? Lx.bg : Lx.fg)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background(Rectangle().fill(on ? Lx.fgStrong : Color.clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
    }
}

extension View {
    /// Dark navigation bar with a small lx logo, for pushed survey screens.
    func svNavChrome(_ title: String) -> some View {
        self
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 8) {
                        LxLogo(height: 16)
                        Text(title)
                            .font(Lx.font(15, .medium))
                            .foregroundStyle(Lx.fgStrong)
                    }
                }
            }
            .toolbarBackground(Lx.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .background(Lx.bg.ignoresSafeArea())
    }
}
