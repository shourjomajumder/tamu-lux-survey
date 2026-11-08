import SwiftUI
import MapKit

/// Apple-Maps-style bottom sheet: "Where to?" → From / To with suggestions → route card.
@MainActor
struct ExploreSheet: View {
    let model: ExploreModel
    /// Called after a route was computed, so the map can frame it.
    let onRoute: () -> Void
    let onGo: () -> Void

    @FocusState private var focus: ExploreModel.Field?
    @State private var fromText: String = ""
    @State private var toText: String = ""
    @State private var message: String? = nil
    @State private var showSteps: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Lx.line2).frame(width: 36, height: 3).padding(.top, 8).padding(.bottom, 10)
            switch model.sheet {
            case .home: home
            case .search: searchPanel
            case .route: routeCard
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(Rectangle().fill(Lx.panel).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { ExploreRule() }
    }

    // MARK: Home

    private var home: some View {
        Button {
            beginSearch(.to)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(Lx.muted)
                Text("Where to?").font(Lx.font(17)).foregroundStyle(Lx.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 46)
            .background(Rectangle().fill(Lx.bg))
            .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 4)
    }

    // MARK: Search

    private var searchPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                VStack(spacing: 0) {
                    fieldRow(label: "From", text: $fromText, field: .from, prompt: "My Location")
                    ExploreRule()
                    fieldRow(label: "To", text: $toText, field: .to, prompt: "Search campus or address")
                }
                .background(Rectangle().fill(Lx.bg))
                .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
                VStack(spacing: 6) {
                    ExploreIconButton(symbol: "arrow.up.arrow.down", label: "Swap") { swapFields() }
                    ExploreIconButton(symbol: "xmark", label: "Cancel") { cancelSearch() }
                }
            }
            if let m = message {
                Text(m).font(Lx.font(13)).foregroundStyle(Lx.orange)
            }
            suggestionList
        }
        .onChange(of: focus) { _, newFocus in
            guard let f = newFocus else { return }
            model.activeField = f
            model.search.update(query: f == .from ? fromText : toText)
        }
    }

    private func fieldRow(label: String, text: Binding<String>, field: ExploreModel.Field, prompt: String) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(Lx.font(12, .medium))
                .foregroundStyle(Lx.muted)
                .frame(width: 38, alignment: .leading)
            TextField("", text: text, prompt: Text(prompt).foregroundColor(Lx.muted))
                .font(Lx.font(16))
                .foregroundStyle(Lx.fgStrong)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .submitLabel(.search)
                .focused($focus, equals: field)
                .onSubmit { submit(field) }
            if !text.wrappedValue.isEmpty && focus == field {
                Button {
                    text.wrappedValue = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Lx.muted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 44)
        .onChange(of: text.wrappedValue) { _, newValue in
            if focus == field { model.search.update(query: newValue) }
        }
    }

    private var suggestions: [ExploreSuggestion] {
        var out: [ExploreSuggestion] = []
        let q: String = model.search.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower: String = q.lowercased()
        if q.isEmpty || "my location".hasPrefix(lower) {
            let sub: String = model.location.isDenied ? "Location off in Settings" : "Current position"
            out.append(ExploreSuggestion(id: "me", title: "My Location", subtitle: sub, symbol: "location.fill", kind: .myLocation))
        }
        if q.isEmpty {
            let featured: [String] = ["Academic Building", "Evans Library", "Rudder Tower", "Kyle Field",
                                      "Sbisa Dining Hall", "Duncan Dining Hall", "Fish Pond", "All Faiths Chapel"]
            var seen: Set<Int> = []
            for f in featured {
                if let s = model.search.matchPlaces(f, limit: 1).first, case .place(let p) = s.kind, !seen.contains(p.id) {
                    seen.insert(p.id)
                    out.append(s)
                }
            }
            return out
        }
        out.append(contentsOf: model.search.placeResults)
        out.append(contentsOf: model.search.addressResults)
        return out
    }

    private var suggestionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(suggestions) { s in
                    Button {
                        pick(s)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: s.symbol)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Lx.fgStrong)
                                .frame(width: 30, height: 30)
                                .overlay(Rectangle().strokeBorder(Lx.line2, lineWidth: Lx.hairline))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.title).font(Lx.font(15, .medium)).foregroundStyle(Lx.fgStrong).lineLimit(1)
                                if !s.subtitle.isEmpty {
                                    Text(s.subtitle).font(Lx.font(12)).foregroundStyle(Lx.muted).lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    ExploreRule()
                }
                if model.search.isResolving {
                    Text("Searching…").font(Lx.font(13)).foregroundStyle(Lx.muted).padding(.vertical, 8)
                }
            }
        }
        .frame(maxHeight: 280)
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: Route card

    private var routeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Button {
                    beginSearch(.to)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.to?.title ?? "Choose destination")
                            .font(Lx.font(19, .semibold))
                            .foregroundStyle(Lx.fgStrong)
                            .lineLimit(1)
                        Text("From \(model.from.title)")
                            .font(Lx.font(13))
                            .foregroundStyle(Lx.muted)
                            .lineLimit(1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                ExploreIconButton(symbol: "arrow.up.arrow.down", label: "Swap") {
                    model.swapEndpoints()
                    onRoute()
                }
                ExploreIconButton(symbol: "xmark", label: "Close") {
                    showSteps = false
                    model.clearRoute()
                }
            }

            if let err = model.error {
                Text(err).font(Lx.font(14)).foregroundStyle(Lx.orange)
                if model.location.isDenied && model.from.isMyLocation {
                    Button("Choose start") { beginSearch(.from) }
                        .buttonStyle(LxButtonStyle())
                }
            }

            if let lit = model.bestLit {
                ExploreRule()
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        ExploreLineKey(dashed: false)
                        Text("Best-lit").font(Lx.font(13, .semibold)).foregroundStyle(Lx.fgStrong)
                    }
                    Text(lit.summary.line)
                        .font(Lx.font(15, .medium))
                        .foregroundStyle(Lx.fgStrong)
                        .fixedSize(horizontal: false, vertical: true)
                    if let dk = lit.summary.darkest {
                        Text(darkestLine(dk))
                            .font(Lx.font(12))
                            .foregroundStyle(Lx.muted)
                            .lineLimit(1)
                    }
                }
                if let s = model.shortest {
                    HStack(spacing: 8) {
                        ExploreLineKey(dashed: true)
                        Text("Shortest · \(s.summary.minutes) min · \(ExploreLux.distance(s.length)) · \(ExploreLux.percent(s.summary.shareBelowGuide)) below 5 lux")
                            .font(Lx.font(12))
                            .foregroundStyle(Lx.muted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                if let n = model.notice {
                    HStack(alignment: .top, spacing: 6) {
                        ExploreWarningMark(size: 10).padding(.top, 3)
                        Text(n).font(Lx.font(12)).foregroundStyle(Lx.fg).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if showSteps {
                    ExploreRule()
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(lit.steps) { st in
                                ExploreStepRow(step: st)
                                ExploreRule()
                            }
                        }
                    }
                    .frame(maxHeight: 260)
                }
                HStack(spacing: 8) {
                    Button(showSteps ? "Hide steps" : "Steps") { showSteps.toggle() }
                        .buttonStyle(LxButtonStyle())
                    Button {
                        onGo()
                    } label: {
                        Text("Go").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(LxButtonStyle(primary: true))
                }
            }
        }
    }

    private func darkestLine(_ d: ExploreDarkSpot) -> String {
        var s: String = "Darkest · \(ExploreLux.label(d.lux))"
        if let n = d.name { s += " · \(n)" }
        return s
    }

    // MARK: Actions

    private func beginSearch(_ field: ExploreModel.Field) {
        message = nil
        showSteps = false
        fromText = model.from.isMyLocation ? "" : model.from.title
        toText = model.to?.title ?? ""
        model.activeField = field
        model.sheet = .search
        model.search.update(query: "")
        // the text fields appear in this same update; focus them on the next run-loop turn
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 120_000_000)
            focus = field
        }
    }

    private func cancelSearch() {
        focus = nil
        model.search.clear()
        message = nil
        if model.to != nil && model.bestLit != nil {
            model.sheet = .route
        } else {
            model.sheet = .home
        }
    }

    private func swapFields() {
        guard let t = model.to else { return }
        let f: ExploreEndpoint = model.from
        model.choose(t, for: .from)
        model.choose(f, for: .to)
        fromText = model.from.isMyLocation ? "" : model.from.title
        toText = model.to?.title ?? ""
        finishIfReady(next: nil)
    }

    private func submit(_ field: ExploreModel.Field) {
        if let first = suggestions.first(where: { (s: ExploreSuggestion) -> Bool in
            if case .myLocation = s.kind { return field == .from && model.search.query.isEmpty }
            return true
        }) {
            pick(first)
        }
    }

    private func pick(_ s: ExploreSuggestion) {
        let field: ExploreModel.Field = focus ?? model.activeField
        message = nil
        switch s.kind {
        case .myLocation:
            model.location.start()
            if model.location.isDenied { message = "Location off · turn it on in Settings or pick a place" }
            apply(ExploreEndpoint.myLocation, to: field)
        case .place(let p):
            apply(ExploreEndpoint(title: p.name, subtitle: p.kindLabel, coordinate: p.coordinate), to: field)
        case .address(let completion):
            Task { @MainActor in
                let result: (ExploreEndpoint?, String?) = await model.search.resolve(completion)
                if let e = result.0 {
                    apply(e, to: field)
                } else {
                    message = result.1 ?? "No match"
                }
            }
        }
    }

    private func apply(_ e: ExploreEndpoint, to field: ExploreModel.Field) {
        model.choose(e, for: field)
        switch field {
        case .from: fromText = e.isMyLocation ? "" : e.title
        case .to: toText = e.isMyLocation ? "My Location" : e.title
        }
        finishIfReady(next: field == .from ? .to : .from)
    }

    /// Computes the route once both ends are set; otherwise moves to the empty field.
    private func finishIfReady(next: ExploreModel.Field?) {
        if model.to == nil {
            model.activeField = .to
            model.search.update(query: toText)
            focus = .to
            return
        }
        focus = nil
        model.search.clear()
        model.sheet = .route
        model.computeRoutes()
        onRoute()
    }
}
