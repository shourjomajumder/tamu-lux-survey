import Foundation

/// Sends a small status heartbeat (location, lux, coverage, alerts, battery…) to the team
/// dashboard every ~5 s. Purely optional: if there is no signal or no URL set, it silently
/// skips — the full data is always saved on the phone regardless.
final class LiveUploader {
    /// Shared secret so random people can't post to the dashboard. Must match LIVE_KEY on the site.
    static let key = "tamu-lux-2026"
    private var inFlight = false
    /// Human-readable result of the last attempt, shown on screen when Offline.
    private(set) var lastResult = "Not tried yet"
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 10
        c.timeoutIntervalForResource = 12
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    var baseURL: String { UserDefaults.standard.string(forKey: "liveURL") ?? "" }

    /// "tamu-lux-survey.netlify.app" → "https://tamu-lux-survey.netlify.app"
    private func base() -> String? {
        var b = baseURL.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !b.isEmpty else { return nil }
        if !b.hasPrefix("http") { b = "https://" + b }
        while b.hasSuffix("/") { b.removeLast() }
        if b.hasSuffix("/api/ingest") { b.removeLast("/api/ingest".count) }
        return b
    }

    /// "https://tamu-lux-survey.netlify.app" (nil when no dashboard address is set).
    var baseURLString: String? { base() }

    private func endpoint() -> URL? { base().flatMap { URL(string: $0 + "/api/ingest") } }

    private static func describe(_ err: Error?, code: Int) -> String {
        if let e = err as? URLError {
            switch e.code {
            case .notConnectedToInternet: return "No internet on this phone"
            case .timedOut: return "Timed out (weak signal?)"
            case .cannotFindHost, .dnsLookupFailed: return "Address not found — check the dashboard address in Settings"
            case .secureConnectionFailed, .serverCertificateUntrusted: return "Secure connection failed (campus Wi-Fi login page?)"
            default: return "Network error: \(e.localizedDescription)"
            }
        }
        if let e = err { return "Error: \(e.localizedDescription)" }
        switch code {
        case 200..<300: return "OK"
        case 401: return "Server rejected the key (401)"
        case 404: return "Wrong address — server says 404"
        default: return "Server error \(code)"
        }
    }

    /// Settings → Test connection: reads the dashboard's status endpoint.
    func test(done: @escaping (String) -> Void) {
        guard let b = base(), let url = URL(string: b + "/api/status") else { done("No dashboard address set"); return }
        session.dataTask(with: url) { data, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            var msg = LiveUploader.describe(err, code: code)
            if msg == "OK" {
                msg = (data.map { String(decoding: $0, as: UTF8.self) } ?? "").contains("walkers")
                    ? "Connected to \(url.host ?? b) ✓" : "Reached a site, but it isn't the dashboard — check the address"
            }
            DispatchQueue.main.async { done(msg) }
        }.resume()
    }

    func send(_ payload: [String: Any], done: @escaping (Bool) -> Void) {
        guard !inFlight else { return }
        guard let url = endpoint() else { lastResult = "No dashboard address set (Settings)"; done(false); return }
        guard JSONSerialization.isValidJSONObject(payload),
              let body = try? JSONSerialization.data(withJSONObject: payload) else { lastResult = "App bug: bad payload"; done(false); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Self.key, forHTTPHeaderField: "x-live-key")
        req.httpBody = body
        inFlight = true
        session.dataTask(with: req) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let ok = err == nil && (200..<300).contains(code)
            let msg = LiveUploader.describe(err, code: code)
            DispatchQueue.main.async {
                self.inFlight = false
                self.lastResult = msg
                done(ok)
            }
        }.resume()
    }
}
