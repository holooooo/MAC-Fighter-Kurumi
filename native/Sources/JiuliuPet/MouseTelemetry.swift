import Foundation
import CoreGraphics

private final class MouseTelemetrySessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// The tap stores only an accumulated length, never positions or a sequence of events.
private final class MotionAccumulator {
    private let lock = NSLock()
    private var distance = 0.0
    private var valid = true
    func add(_ value: Double) {
        lock.lock(); defer { lock.unlock() }
        guard value.isFinite, value >= 0, (distance + value).isFinite else { valid = false; return }
        distance += value
    }
    func invalidate() { lock.lock(); valid = false; lock.unlock() }
    func drain() -> (Double, Bool) {
        lock.lock(); defer { lock.unlock() }
        let result = (distance, valid)
        distance = 0; valid = true
        return result
    }
}

/// Reports movement length/s, mouse-down count/s and key-down count/s.
/// Never requests permission; no keyboard tap, text, keycodes, coordinates or device identity.
@MainActor
final class MouseTelemetry {
    private let endpoint = URL(string: "http://127.0.0.1:8766/api/peripherals")!
    private let countTypes: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]
    private let ids = ["MOUSE_DISTANCE", "MOUSE_CLICKS", "KEYBOARD"]
    private let sessionDelegate = MouseTelemetrySessionDelegate()
    private let motion = MotionAccumulator()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var timer: Timer?
    private var eventTap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var distanceBaseline: TimeInterval?
    private var previousCounts: [UInt32]?
    private var previousUptime: TimeInterval?
    private var running = false
    private var generation = 0
    private var diagnostics: [String: Any] = ["running": false, "transport": "idle"]

    func snapshot() -> [String: Any] { diagnostics }

    func start() {
        guard !running else { return }
        running = true; generation += 1
        diagnostics["running"] = true
        diagnostics["privacy"] = "aggregate distance and event counts only; keyDown includes repeats"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 1
        configuration.timeoutIntervalForResource = 1
        configuration.waitsForConnectivity = false
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration, delegate: sessionDelegate, delegateQueue: nil)
        collect()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.collect() }
        }
        timer.tolerance = 0.1; self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func stop() {
        guard running else { return }
        running = false; generation += 1
        timer?.invalidate(); timer = nil
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        removeTap()
        previousCounts = nil; previousUptime = nil
        diagnostics["running"] = false; diagnostics["transport"] = "stopped"
    }

    private func removeTap() {
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: false); CFMachPortInvalidate(eventTap) }
        if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
        eventTap = nil; tapSource = nil; distanceBaseline = nil
        _ = motion.drain()
    }

    private func ensureTap() -> Bool {
        if let eventTap, CGEvent.tapIsEnabled(tap: eventTap) { return true }
        removeTap()
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, pointer in
                guard let pointer else { return Unmanaged.passUnretained(event) }
                let accumulator = Unmanaged<MotionAccumulator>.fromOpaque(pointer).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    accumulator.invalidate()
                } else if [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(type) {
                    let dx = event.getDoubleValueField(.mouseEventDeltaX)
                    let dy = event.getDoubleValueField(.mouseEventDeltaY)
                    accumulator.add(hypot(dx, dy))
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(motion).toOpaque()),
              let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else { return false }
        eventTap = tap; tapSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return CGEvent.tapIsEnabled(tap: tap)
    }

    private func source(_ id: String) -> String {
        id == "MOUSE_DISTANCE" ? "CGEvent listenOnly mouse movement delta lengths" : "CGEventSource combinedSessionState counters"
    }
    private func collect() {
        guard running else { return }
        let uptime = ProcessInfo.processInfo.systemUptime
        let timestamp = Date().timeIntervalSince1970 * 1000
        var samples: [[String: Any]] = []
        var missing: [[String: String]] = []
        func unavailable(_ id: String, _ reason: String) {
            diagnostics[id] = ["available": false, "reason": reason, "source": source(id)]
            missing.append(["id": id, "reason": reason])
        }
        func sample(_ id: String, _ value: Double, _ unit: String) {
            guard value.isFinite, value >= 0 else { unavailable(id, "read-error"); return }
            samples.append(["id": id, "value": value, "time": timestamp])
            diagnostics[id] = ["available": true, "value": value, "unit": unit, "time": timestamp, "source": source(id)]
        }
        if !CGPreflightListenEventAccess() {
            removeTap(); previousCounts = nil; previousUptime = nil
            ids.forEach { unavailable($0, "permission-required") }
        } else {
            let counts = countTypes.map { CGEventSource.counterForEventType(.combinedSessionState, eventType: $0) }
            let tapOK = ensureTap()
            let movement = motion.drain()
            if let before = previousCounts, let then = previousUptime {
                let dt = uptime - then
                if dt > 0 && dt <= 5 && zip(counts, before).allSatisfy({ $0 >= $1 }) {
                    let clicks = (0..<3).reduce(UInt64(0)) { $0 + UInt64(counts[$1] - before[$1]) }
                    sample("MOUSE_CLICKS", Double(clicks) / dt, "clicks/s")
                    sample("KEYBOARD", Double(counts[3] - before[3]) / dt, "keys/s")
                } else {
                    unavailable("MOUSE_CLICKS", "read-error"); unavailable("KEYBOARD", "read-error")
                }
            } else {
                for id in ["MOUSE_CLICKS", "KEYBOARD"] { diagnostics[id] = ["available": false, "reason": "warming-up", "source": source(id)] }
            }
            if !tapOK { unavailable("MOUSE_DISTANCE", "read-error") }
            else if let then = distanceBaseline {
                let dt = uptime - then
                if dt > 0 && dt <= 5 && movement.1 { sample("MOUSE_DISTANCE", movement.0 / dt, "pt/s") }
                else { unavailable("MOUSE_DISTANCE", "read-error") }
            } else { diagnostics["MOUSE_DISTANCE"] = ["available": false, "reason": "warming-up", "source": source("MOUSE_DISTANCE")] }
            distanceBaseline = tapOK ? uptime : nil
            previousCounts = counts; previousUptime = uptime
        }
        guard task == nil, !samples.isEmpty || !missing.isEmpty else { return }
        post(samples: samples, unavailable: missing)
    }

    private func post(samples: [[String: Any]], unavailable: [[String: String]]) {
        guard let session, running, task == nil,
              let body = try? JSONSerialization.data(withJSONObject: ["samples": samples, "unavailable": unavailable]) else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"; request.timeoutInterval = 1
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let epoch = generation
        diagnostics["transport"] = "sending"
        let requestTask = session.dataTask(with: request) { [weak self] _, response, error in
            Task { @MainActor [weak self] in
                guard let self, self.running, self.generation == epoch else { return }
                self.task = nil
                let ok = error == nil && (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) == true
                self.diagnostics["transport"] = ok ? "delivered" : "unavailable"
            }
        }
        task = requestTask; requestTask.resume()
    }
}
