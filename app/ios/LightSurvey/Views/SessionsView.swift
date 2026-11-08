import SwiftUI
import UIKit

struct SessionInfo: Identifiable, Hashable {
    let url: URL
    var id: URL { url }
    var name: String { url.lastPathComponent }
    let photos: Int
    let bytes: Int64
    let date: Date
    let status: String
}

/// Lists recorded walks (kept on the phone) with each 5-minute upload chunk and whether it was sent;
/// export as zip (data only, or everything) via the share sheet / AirDrop.
struct SessionsView: View {
    @State private var sessions: [SessionInfo] = []
    @State private var chunks: [URL: [UploadManager.ChunkRow]] = [:]
    @State private var expanded: Set<URL> = []
    @State private var busy: String?
    @State private var shareURL: URL?
    @State private var toDelete: SessionInfo?
    @State private var error: String?
    @State private var refresher: Timer?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Every walk stays on this phone: Files → On My iPhone → LightSurvey → Sessions. Uploads send copies; nothing is deleted. Full photo set: AirDrop, or a Mac → Finder → iPhone → Files.")
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if !UploadManager.shared.enabled {
                    Text("Uploads are off (Settings).")
                        .font(Lx.font(12))
                        .foregroundStyle(Lx.orange)
                }
                if sessions.isEmpty {
                    LxPanel {
                        Text("No walks yet.").font(Lx.font(14)).foregroundStyle(Lx.muted)
                    }
                }
                ForEach(sessions) { s in sessionCard(s) }
                if let error {
                    Text(error).font(Lx.font(13)).foregroundStyle(Lx.red)
                }
            }
            .padding(16)
        }
        .refreshable { @MainActor in load() }
        .svNavChrome("Sessions")
        .onAppear {
            load()
            // Keep the "sent" ticks current while this screen is open.
            refresher?.invalidate()
            refresher = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in MainActor.assumeIsolated { loadChunks() } }
        }
        .onDisappear {
            refresher?.invalidate()
            refresher = nil
        }
        .sheet(item: Binding(get: { shareURL.map { SessionShareItem(url: $0) } }, set: { shareURL = $0?.url })) { item in
            SessionShareSheet(url: item.url)
        }
        .confirmationDialog("Delete \(toDelete?.name ?? "")? This can't be undone.",
                            isPresented: Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } }),
                            titleVisibility: .visible) {
            Button("Delete permanently", role: .destructive) {
                if let s = toDelete { try? FileManager.default.removeItem(at: s.url) }
                toDelete = nil
                load()
            }
        }
    }

    // MARK: Card

    private func sessionCard(_ s: SessionInfo) -> some View {
        let rows: [UploadManager.ChunkRow] = chunks[s.url] ?? []
        let sentCount: Int = rows.filter { $0.sent }.count
        let isOpen: Bool = expanded.contains(s.url)
        return LxPanel {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(s.name)
                        .font(Lx.font(15, .semibold))
                        .foregroundStyle(Lx.fgStrong)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(statusText(s.status))
                        .font(Lx.font(11, .medium))
                        .foregroundStyle(s.status == "recording" ? Lx.red : (s.status == "finished" ? Lx.muted : Lx.orange))
                }
                Text("\(s.photos) photos · \(ByteCountFormatter.string(fromByteCount: s.bytes, countStyle: .file)) on phone")
                    .font(Lx.font(12))
                    .foregroundStyle(Lx.muted)

                SvHairline()
                Button {
                    if isOpen { expanded.remove(s.url) } else { expanded.insert(s.url) }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: rows.isEmpty ? "arrow.up" : (sentCount == rows.count ? "checkmark" : "arrow.up"))
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(!rows.isEmpty && sentCount == rows.count ? Lx.light : Lx.muted)
                        Text(rows.isEmpty ? "No uploads yet" : "Uploads: \(sentCount)/\(rows.count) chunks sent")
                            .font(Lx.font(13))
                            .foregroundStyle(Lx.fg)
                        Spacer()
                        if !rows.isEmpty {
                            Image(systemName: isOpen ? "chevron.up" : "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Lx.muted)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(rows.isEmpty)

                if isOpen {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(rows) { r in chunkRow(r) }
                    }
                }

                SvHairline()
                HStack(spacing: 8) {
                    Button { export(s, full: false) } label: { Text("Share CSV").frame(maxWidth: .infinity) }
                        .buttonStyle(LxButtonStyle())
                    Button { export(s, full: true) } label: { Text("Share all").frame(maxWidth: .infinity) }
                        .buttonStyle(LxButtonStyle())
                    Button { toDelete = s } label: {
                        Image(systemName: "trash").foregroundStyle(Lx.red)
                    }
                    .buttonStyle(LxButtonStyle())
                    .accessibilityLabel(Text("Delete"))
                }
                .disabled(busy != nil)
                if busy == s.name {
                    HStack(spacing: 8) {
                        ProgressView().tint(Lx.light)
                        Text("Zipping… big walks take a few minutes").font(Lx.font(12)).foregroundStyle(Lx.muted)
                    }
                }
            }
        }
    }

    private func chunkRow(_ r: UploadManager.ChunkRow) -> some View {
        let l = r.log
        var detail: String = l.time > 0 ? Self.timeFormatter.string(from: Date(timeIntervalSince1970: l.time)) : "—"
        if l.files >= 0 {
            detail += " · \(l.photos) photos · \(l.lights) snaps · "
            detail += ByteCountFormatter.string(fromByteCount: max(l.csvBytes, 0), countStyle: .file) + " CSV"
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("#\(l.seq)")
                .font(Lx.font(12, .semibold))
                .foregroundStyle(Lx.fgStrong)
                .frame(width: 30, alignment: .leading)
            Text(detail)
                .font(Lx.font(12))
                .foregroundStyle(Lx.muted)
                .lineLimit(2)
            Spacer(minLength: 4)
            Text(r.sent ? "sent" : "\(r.pending) left")
                .font(Lx.font(12, .medium))
                .foregroundStyle(r.sent ? Lx.light : Lx.orange)
        }
        .monospacedDigit()
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    private func statusText(_ s: String) -> String {
        switch s {
        case "finished": return "SAVED"
        case "recording": return "RECORDING"
        case "interrupted_data_kept": return "STOPPED EARLY · KEPT"
        default: return s.uppercased()
        }
    }

    // MARK: Loading

    private func load() {
        let root = SessionRecorder.sessionsRoot
        let fm = FileManager.default
        guard let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey], options: [.skipsHiddenFiles]) else {
            sessions = []; return
        }
        sessions = dirs.compactMap { d -> SessionInfo? in
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: d.path, isDirectory: &isDir), isDir.boolValue else { return nil }
            let photos = (try? fm.contentsOfDirectory(atPath: d.appendingPathComponent("photos").path))?.count ?? 0
            var bytes: Int64 = 0
            if let e = fm.enumerator(at: d, includingPropertiesForKeys: [.fileSizeKey]) {
                for case let f as URL in e { bytes += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
            }
            let date = (try? d.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            var status = ""
            if let data = try? Data(contentsOf: d.appendingPathComponent("session.json")),
               let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                status = (m["status"] as? String) ?? ""
            }
            return SessionInfo(url: d, photos: photos, bytes: bytes, date: date, status: status)
        }
        .sorted { $0.date > $1.date }
        loadChunks()
    }

    private func loadChunks() {
        for s in sessions {
            let url = s.url
            UploadManager.shared.chunks(for: url) { (rows: [UploadManager.ChunkRow]) in
                chunks[url] = rows
            }
        }
    }

    private func export(_ s: SessionInfo, full: Bool) {
        busy = s.name
        error = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try Zipper.zip(session: s.url, includePhotos: full) }
            DispatchQueue.main.async {
                busy = nil
                switch result {
                case .success(let url): shareURL = url
                case .failure(let e): error = "Export failed: \(e.localizedDescription)"
                }
            }
        }
    }
}

private struct SessionShareItem: Identifiable { let url: URL; var id: URL { url } }

struct SessionShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

/// Uses the system's built-in folder→zip (NSFileCoordinator .forUploading); no third-party libraries.
enum Zipper {
    static func zip(session: URL, includePhotos: Bool) throws -> URL {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory
        var source = session
        var staged: URL?
        if !includePhotos {
            let s = tmp.appendingPathComponent(session.lastPathComponent + "_data", isDirectory: true)
            try? fm.removeItem(at: s)
            try fm.createDirectory(at: s, withIntermediateDirectories: true)
            for f in try fm.contentsOfDirectory(at: session, includingPropertiesForKeys: nil) where f.pathExtension == "csv" || f.pathExtension == "json" {
                try fm.copyItem(at: f, to: s.appendingPathComponent(f.lastPathComponent))
            }
            source = s
            staged = s
        }
        defer { if let staged { try? fm.removeItem(at: staged) } }

        let dest = tmp.appendingPathComponent(source.lastPathComponent + ".zip")
        try? fm.removeItem(at: dest)
        var coordError: NSError?
        var copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [.forUploading], error: &coordError) { zipped in
            do { try fm.copyItem(at: zipped, to: dest) } catch { copyError = error }
        }
        if let coordError { throw coordError }
        if let copyError { throw copyError }
        return dest
    }
}
