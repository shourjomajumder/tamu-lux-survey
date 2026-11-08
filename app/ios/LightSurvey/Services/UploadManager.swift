import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Uploads a walk to the dashboard in chunks: every 5 minutes while recording, and once more at End.
///
/// - Photos are sent as reduced copies (1280 px, EXIF kept); originals stay on the phone.
/// - Light-source snapshots, session.json and coverage are sent as-is.
/// - CSVs are sent as the new bytes since the last upload, in ≤4 MB pieces named by
///   byte offset, so the download script can stitch them back together exactly.
/// - The queue is saved to disk: if the app is closed, the phone dies or there's no signal,
///   it carries on from where it stopped next time the app is open.
final class UploadManager {
    static let shared = UploadManager()

    struct Item: Codable {
        var local: String          // path relative to Documents
        var key: String            // remote key: w1/<session>/<path>
        var offset: Int64?         // CSV piece: start byte
        var length: Int?           // CSV piece: byte count
        var reduce: Bool           // photo → 1280 px copy
        var seq: Int               // upload chunk number (1, 2, 3 …) within the session
        var walker: Int
        var session: String? = nil // session folder name (nil in queues saved by older builds)

        // "part" is the key older builds saved in queue.json, so a queue left over from them still loads.
        enum CodingKeys: String, CodingKey { case local, key, offset, length, reduce, seq = "part", walker, session }
    }

    /// What one 5-minute chunk contained (saved per session in upload_state.json).
    struct ChunkLog: Codable {
        var seq: Int
        var time: Double           // epoch seconds when the chunk was queued
        var photos: Int
        var lights: Int
        var csvBytes: Int64
        var files: Int
    }

    /// One chunk as shown in Sessions.
    struct ChunkRow: Identifiable {
        let log: ChunkLog
        let pending: Int           // files of this chunk still waiting to be sent
        var id: Int { log.seq }
        var sent: Bool { pending == 0 }
    }

    private struct SessionState: Codable {
        var sent: Set<String> = []           // photo / snapshot file names already queued
        var csvOffsets: [String: Int64] = [:]
        var lastSeq: Int?                    // last chunk number queued for this session
        var chunks: [ChunkLog]?              // what each chunk held (nil in older files)
    }

    struct Stats {
        var pending = 0
        var uploaded = 0
        var chunksDone: [Int] = []
        var lastError = ""
    }

    var onStats: ((Stats) -> Void)?
    var enabled: Bool {
        UserDefaults.standard.object(forKey: "uploadEnabled") as? Bool ?? true
    }

    private let q = DispatchQueue(label: "uploads")
    private var items: [Item] = []
    private var chunksQueued: [Int: Set<Int>] = [:]   // walker → chunk numbers queued (latest session)
    private var uploaded = 0
    private var busy = false
    private var backoff: Double = 2
    private var lastError = ""
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 120
        return URLSession(configuration: c)
    }()

    private static let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    private static let folder = docs.appendingPathComponent("Uploads", isDirectory: true)
    private static let queueURL = folder.appendingPathComponent("queue.json")
    private static let csvNames = ["lux", "gps", "heading", "motion", "photos", "events", "frames", "altimeter", "brackets"]
    private static let pieceSize = 4_000_000

    private struct Saved: Codable {
        var items: [Item]; var uploaded: Int; var chunksQueued: [Int: Set<Int>]
        enum CodingKeys: String, CodingKey { case items, uploaded, chunksQueued = "partsQueued" }
    }

    private init() {
        if let d = try? Data(contentsOf: Self.queueURL), let s = try? JSONDecoder().decode(Saved.self, from: d) {
            items = s.items; uploaded = s.uploaded; chunksQueued = s.chunksQueued
        }
    }

    /// Call once at launch: finishes anything left from last time.
    func resume() { q.async { self.publish(); self.pump() } }

    // MARK: - Queueing

    /// Queue everything captured in this session folder since the last call as the next chunk.
    /// Called every 5 minutes while recording and once more at End.
    func uploadNew(sessionDir: URL, walker: Int) {
        guard enabled else { return }
        q.async {
            let fm = FileManager.default
            let name = sessionDir.lastPathComponent
            let stateURL = sessionDir.appendingPathComponent("upload_state.json")
            var st = (try? Data(contentsOf: stateURL)).flatMap { try? JSONDecoder().decode(SessionState.self, from: $0) } ?? SessionState()
            let prefix = "w\(walker)/\(name)/"
            func rel(_ u: URL) -> String { String(u.path.dropFirst(Self.docs.path.count + 1)) }
            let seq = (st.lastSeq ?? 0) + 1
            st.lastSeq = seq
            var new: [Item] = []

            // Light-source snapshots first (small, needed for Gemini), then photos.
            for (dir, reduce) in [("lights", false), ("photos", true)] {
                let d = sessionDir.appendingPathComponent(dir)
                let files = ((try? fm.contentsOfDirectory(atPath: d.path)) ?? []).filter { $0.hasSuffix(".jpg") }.sorted()
                for f in files where !st.sent.contains(dir + "/" + f) {
                    st.sent.insert(dir + "/" + f)
                    new.append(Item(local: rel(d.appendingPathComponent(f)), key: prefix + dir + "/" + f,
                                    offset: nil, length: nil, reduce: reduce, seq: seq, walker: walker))
                }
            }
            // CSVs: only the bytes added since the last upload.
            for c in Self.csvNames {
                let u = sessionDir.appendingPathComponent(c + ".csv")
                guard let size = (try? fm.attributesOfItem(atPath: u.path)[.size] as? NSNumber)?.int64Value else { continue }
                var off = st.csvOffsets[c] ?? 0
                while off < size {
                    let len = Int(min(Int64(Self.pieceSize), size - off))
                    new.append(Item(local: rel(u), key: prefix + "csv/\(c).csv@" + String(format: "%012lld", off),
                                    offset: off, length: len, reduce: false, seq: seq, walker: walker))
                    off += Int64(len)
                }
                st.csvOffsets[c] = off
            }
            // Small whole files, re-sent with every chunk.
            new.append(Item(local: rel(sessionDir.appendingPathComponent("session.json")), key: prefix + "session.json",
                            offset: nil, length: nil, reduce: false, seq: seq, walker: walker))
            let cov = CoverageStore.url(for: walker)
            if fm.fileExists(atPath: cov.path) {
                new.append(Item(local: rel(cov), key: "w\(walker)/coverage.json", offset: nil, length: nil, reduce: false, seq: seq, walker: walker))
            }

            for i in new.indices { new[i].session = name }
            let photoCount = new.filter { $0.key.hasPrefix(prefix + "photos/") }.count
            let lightCount = new.filter { $0.key.hasPrefix(prefix + "lights/") }.count
            let csvBytes: Int64 = new.reduce(Int64(0)) { (acc: Int64, it: Item) -> Int64 in acc + Int64(it.length ?? 0) }
            var logs: [ChunkLog] = st.chunks ?? []
            logs.append(ChunkLog(seq: seq, time: Date().timeIntervalSince1970, photos: photoCount, lights: lightCount,
                                 csvBytes: csvBytes, files: new.count))
            st.chunks = logs
            if let d = try? JSONEncoder().encode(st) { try? d.write(to: stateURL, options: .atomic) }
            self.items.append(contentsOf: new)
            if seq == 1 { self.chunksQueued[walker] = [] }   // new session: start the list afresh
            self.chunksQueued[walker, default: []].insert(seq)
            self.save()
            self.publish()
            self.pump()
        }
    }

    /// Chunks queued for one session folder, oldest first, with how many of their files are still waiting.
    /// The files themselves are never deleted from the phone. Calls back on the main thread.
    func chunks(for sessionDir: URL, done: @escaping ([ChunkRow]) -> Void) {
        q.async {
            let name = sessionDir.lastPathComponent
            let stateURL = sessionDir.appendingPathComponent("upload_state.json")
            let st = (try? Data(contentsOf: stateURL)).flatMap { try? JSONDecoder().decode(SessionState.self, from: $0) } ?? SessionState()
            var waiting: [Int: Int] = [:]
            for it in self.items where it.session == name || (it.session == nil && it.key.contains("/" + name + "/")) {
                waiting[it.seq, default: 0] += 1
            }
            var rows: [ChunkRow] = (st.chunks ?? []).map { ChunkRow(log: $0, pending: waiting[$0.seq] ?? 0) }
            // Chunks queued by an older build have no log entry: list them by number only.
            let logged = Set(rows.map { $0.log.seq })
            for seq in 1...max(st.lastSeq ?? 0, 1) where (st.lastSeq ?? 0) > 0 && !logged.contains(seq) {
                rows.append(ChunkRow(log: ChunkLog(seq: seq, time: 0, photos: -1, lights: -1, csvBytes: -1, files: -1),
                                     pending: waiting[seq] ?? 0))
            }
            rows.sort { $0.log.seq < $1.log.seq }
            DispatchQueue.main.async { done(rows) }
        }
    }

    // MARK: - Sending

    private func endpoint(_ key: String) -> URL? {
        var b = (UserDefaults.standard.string(forKey: "liveURL") ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !b.isEmpty else { return nil }
        if !b.hasPrefix("http") { b = "https://" + b }
        while b.hasSuffix("/") { b.removeLast() }
        var comps = URLComponents(string: b + "/api/upload")
        comps?.queryItems = [URLQueryItem(name: "key", value: key)]
        return comps?.url
    }

    private func pump() {
        guard !busy, enabled, let item = items.first else { return }
        guard let url = endpoint(item.key) else { lastError = "No dashboard address set"; publish(); return }
        guard let data = load(item) else {
            items.removeFirst(); save(); publish(); pump(); return   // file gone: skip it
        }
        busy = true
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(LiveUploader.key, forHTTPHeaderField: "x-live-key")
        session.uploadTask(with: req, from: data) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            self.q.async {
                self.busy = false
                if err == nil && (200..<300).contains(code) {
                    if !self.items.isEmpty { self.items.removeFirst() }
                    self.uploaded += 1
                    self.backoff = 2
                    self.lastError = ""
                    if self.items.count % 20 == 0 { self.save() }
                    self.publish()
                    self.pump()
                } else {
                    self.lastError = err.map { $0.localizedDescription } ?? "Server error \(code)"
                    self.publish()
                    self.backoff = min(self.backoff * 2, 60)
                    self.q.asyncAfter(deadline: .now() + self.backoff) { self.pump() }
                }
            }
        }.resume()
    }

    private func load(_ it: Item) -> Data? {
        let url = Self.docs.appendingPathComponent(it.local)
        if let off = it.offset, let len = it.length {
            guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
            defer { try? h.close() }
            try? h.seek(toOffset: UInt64(off))
            return try? h.read(upToCount: len)
        }
        if it.reduce { return Self.reduced(url) ?? (try? Data(contentsOf: url)) }
        return try? Data(contentsOf: url)
    }

    /// 1280 px JPEG copy, keeping EXIF/GPS metadata.
    private static func reduced(_ url: URL) -> Data? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceThumbnailMaxPixelSize: 1280,
                                     kCGImageSourceCreateThumbnailWithTransform: false]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        var props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]) ?? [:]
        props[kCGImageDestinationLossyCompressionQuality] = 0.6
        props[kCGImagePropertyPixelWidth] = nil
        props[kCGImagePropertyPixelHeight] = nil
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    // MARK: - Bookkeeping

    private func save() {
        try? FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(Saved(items: items, uploaded: uploaded, chunksQueued: chunksQueued)) {
            try? d.write(to: Self.queueURL, options: .atomic)
        }
    }

    private func publish() {
        var s = Stats()
        s.pending = items.count
        s.uploaded = uploaded
        s.lastError = lastError
        let walker = UserDefaults.standard.object(forKey: "walker") as? Int ?? 1
        let pendingChunks = Set(items.filter { $0.walker == walker }.map { $0.seq })
        s.chunksDone = (chunksQueued[walker] ?? []).subtracting(pendingChunks).sorted()
        DispatchQueue.main.async { self.onStats?(s) }
    }
}
