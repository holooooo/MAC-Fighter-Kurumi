import AppKit
import WebKit
import Foundation

// Test-only loopback routing; production remains fixed to port 8766.
private let servicePort: Int = {
    guard CommandLine.arguments.contains("--smoke-test"),
          let raw = ProcessInfo.processInfo.environment["KURUMI_SMOKE_PORT"],
          let port = Int(raw), (1024...65535).contains(port) else { return 8766 }
    return port
}()
private let baseURL = URL(string: "http://127.0.0.1:\(servicePort)")!

@MainActor
final class DragHandle: NSView {
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    // Transparent grab area remains available above the character; no ornamental bar.

}

@MainActor
final class PetBodyDragOverlay: NSView {
    weak var webView: WKWebView?
    var bodyRect = NSRect.zero
    var excludedRects: [NSRect] = []
    var onLayout: (() -> Void)?
    var clampFrame: ((NSRect) -> NSRect)?
    var openPanel: (() -> Void)?
    private(set) var drags = 0
    private(set) var taps = 0
    private(set) var dragging = false
    private var press: PetPressSession?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard !isHidden, bodyRect.contains(local), !excludedRects.contains(where: { $0.contains(local) }) else { return nil }
        return self
    }
    override func resetCursorRects() {
        let rect = bodyRect.intersection(bounds)
        if !rect.isNull { addCursorRect(rect, cursor: dragging ? .closedHand : .openHand) }
    }
    override func layout() { super.layout(); onLayout?() }
    private func dispatch(_ event: String, detail: [String: String]? = nil) {
        let options: [String: Any] = detail.map { ["detail": $0] } ?? [:]
        guard let data = try? JSONSerialization.data(withJSONObject: options), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)',\(json)))", completionHandler: nil)
    }
    override func mouseDown(with event: NSEvent) {
        cancelInteraction()
        guard let window else { return }
        press = PetPressSession(initialMouse: window.convertPoint(toScreen: event.locationInWindow), initialFrame: window.frame, pressedAt: event.timestamp)
        window.makeFirstResponder(self)
    }
    private func updateDrag(with event: NSEvent) {
        guard let window, var session = press else { return }
        // Convert each genuine event to global points before moving the window.
        let update = session.update(mouse: window.convertPoint(toScreen: event.locationInWindow))
        press = session
        dragging = session.dragging
        if update.started {
            drags += 1
            dispatch("jiuliu-pet-drag", detail: ["phase": "start"])
            window.invalidateCursorRects(for: self)
        }
        if let proposed = update.frame {
            let clamped = clampFrame?(proposed) ?? proposed
            if window.frame.size != clamped.size { window.setFrame(clamped, display: window.isVisible) }
            else { window.setFrameOrigin(clamped.origin) }
        }
    }
    override func mouseDragged(with event: NSEvent) { updateDrag(with: event) }
    override func mouseUp(with event: NSEvent) {
        guard press != nil else { return }
        updateDrag(with: event)
        let isTap = press?.isTap(releasedAt: event.timestamp) == true
        cancelInteraction()
        if isTap { taps += 1; dispatch("jiuliu-pet-tap") }
    }
    func cancelInteraction() {
        let wasDragging = dragging
        dragging = false; press = nil
        if wasDragging { dispatch("jiuliu-pet-drag", detail: ["phase": "end"]) }
        window?.invalidateCursorRects(for: self)
    }
    override func cancelOperation(_ sender: Any?) { cancelInteraction() }
    override func viewWillMove(toWindow newWindow: NSWindow?) { if newWindow == nil { cancelInteraction() }; super.viewWillMove(toWindow: newWindow) }
    override func rightMouseDown(with event: NSEvent) {
        cancelInteraction()
        let menu = NSMenu(title: "韭留美互动")
        for (title, name) in [("挥手", "wave"), ("伸懒腰", "stretch"), ("打瞌睡", "sleep"), ("被套还嘴硬", "loss"), ("这次管住手", "buy"), ("归零也嘴硬", "liquidation"), ("表情包", "meme"), ("打开面板", "panel")] {
            let item = NSMenuItem(title: title, action: #selector(contextAction(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = name; menu.addItem(item)
        }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
    @objc private func contextAction(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if name == "panel" { openPanel?() }
        else if ["buy", "loss", "liquidation"].contains(name) { dispatch("jiuliu-pet-action", detail: ["name": "demo", "animation": name]) }
        else if ["wave", "stretch", "sleep", "meme"].contains(name) { dispatch("jiuliu-pet-action", detail: ["name": name]) }
    }
    func snapshot() -> [String: Any] {
        let origin = window?.frame.origin ?? .zero
        return ["bodyRect": ["x": bodyRect.minX, "y": bodyRect.minY, "width": bodyRect.width, "height": bodyRect.height],
         "bounds": ["width": bounds.width, "height": bounds.height], "windowOrigin": ["x": origin.x, "y": origin.y],
         "excludedControls": excludedRects.count, "nativeDrags": drags, "nativeTaps": taps, "dragging": dragging,
         "acceptsFirstMouse": true, "configured": bodyRect.width > 0 && bodyRect.height > 0]
    }
}

@MainActor
final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class Application: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var mainWindow: NSWindow?
    private var petWindow: PetPanel?
    private var memeSharePicker: NSSharingServicePicker?
    private var bodyDragOverlay: PetBodyDragOverlay?
    private var measuringBody = false
    private var statusItem: NSStatusItem?
    private var ownedService: Process?
    private var serviceLog: FileHandle?
    private var startup: Task<Void, Never>?
    private var terminating = false
    private let mouseTelemetry = MouseTelemetry()
    private let smokeMode = CommandLine.arguments.contains("--smoke-test")
    private var smokeResults: [String: [String: Any]] = [:]
    private var smokeExit: Int32 = 0
    private var smokeFinished = false
    private var petWantsVisible = true
    private var lastPetFrame: NSRect?
    private let petFramePreference = "desktopPet.frame.v1"
    private let petVisiblePreference = "desktopPet.visible.v1"

    func applicationDidFinishLaunching(_ notification: Notification) {
        if smokeMode {
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                guard let self, !self.smokeFinished else { return }
                self.finishSmoke(error: "Timed out waiting for both WebViews")
            }
        }
        if !smokeMode {
            petWantsVisible = UserDefaults.standard.object(forKey: petVisiblePreference) as? Bool ?? true
        }
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        installMenus()
        startup = Task { [weak self] in
            guard let self else { return }
            do { try await self.ensureService(); try Task.checkCancellation(); self.mouseTelemetry.start(); self.makeWindows() }
            catch is CancellationError { }
            catch { self.showError("无法启动韭留美", error.localizedDescription) }
        }
    }

    private enum ServiceProbe: Equatable { case compatible, incompatible, unavailable }

    private func probe() async -> ServiceProbe {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/state"))
        request.timeoutInterval = 0.8
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard response.url?.host == "127.0.0.1", response.url?.port == servicePort,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let game = json["game"] as? [String: Any], game["mode"] as? String == "live",
                  json["telemetry"] is [String: Any],
                  let server = json["server"] as? [String: Any], server["protocolVersion"] as? Int == 2 else { return .incompatible }
            return .compatible
        } catch { return .unavailable }
    }

    private func ensureService() async throws {
        switch await probe() {
        case .compatible: return // Compatible existing service remains external and is never terminated.
        case .incompatible: throw failure("端口 8766 已有旧版或不兼容的服务。先确认占用者并正常退出它，再重新打开韭留美；不会自动结束其他进程。")
        case .unavailable: break
        }
        try Task.checkCancellation()
        guard let resources = Bundle.main.resourceURL else { throw failure("找不到应用资源目录。请重新运行打包脚本。") }
        let server = resources.appendingPathComponent("web/server.cjs")
        let configured = ProcessInfo.processInfo.environment["KURUMI_NODE_PATH"]
        let node = configured.map { URL(fileURLWithPath: $0) } ?? resources.appendingPathComponent("runtime/node")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: server.path) else {
            throw failure("缺少 Node 运行时或采集服务。请使用完整 .app，或设置绝对路径 KURUMI_NODE_PATH。")
        }
        let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/JiuliuPet", isDirectory: true)
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("service.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logURL)
        serviceLog = handle
        let process = Process()
        process.executableURL = node
        process.arguments = [server.path]
        process.currentDirectoryURL = server.deletingLastPathComponent()
        process.standardOutput = handle; process.standardError = handle
        // No shell, user-supplied JavaScript, or inherited NODE_OPTIONS.
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        process.environment = environment
        try process.run()
        ownedService = process
        // A competing launcher can win the bind race. Its healthy service may be reused,
        // but this app only retains ownership of the exact child it launched.
        for _ in 0..<40 {
            try Task.checkCancellation()
            let status = await probe()
            if status == .compatible {
                if !process.isRunning { ownedService = nil }
                return
            }
            if status == .incompatible {
                if process.isRunning { process.interrupt() }
                ownedService = nil
                throw failure("端口 8766 被旧版或不兼容的服务占用；请确认进程并正常退出后重开应用。")
            }
            if !process.isRunning {
                ownedService = nil
                throw failure("本地服务启动失败（退出码 \(process.terminationStatus)）。端口 8766 可能被其他程序占用。日志：\(logURL.path)")
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        if process.isRunning { process.interrupt() }
        throw failure("服务未能及时就绪。请检查端口 8766 和日志：\(logURL.path)")
    }

    private func failure(_ text: String) -> NSError { NSError(domain: "JiuliuPet", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }

    private func installMenus() {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "打开面板", action: #selector(showMain), keyEquivalent: "1").target = self
        appMenu.addItem(withTitle: "显示／隐藏桌宠", action: #selector(togglePet), keyEquivalent: "2").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出韭留美", action: #selector(quit), keyEquivalent: "q").target = self
        applicationItem.submenu = appMenu; menu.addItem(applicationItem)
        let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "编辑")
        for (title, selector, key) in [("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        edit.submenu = editMenu; menu.addItem(edit)
        NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.title = "韭留美"
        statusItem?.button?.toolTip = "韭留美桌宠"
        statusItem?.menu = appMenu.copy() as? NSMenu
    }

    private func webView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self; view.uiDelegate = self
        view.underPageBackgroundColor = .clear
        view.setValue(false, forKey: "drawsBackground")
        view.translatesAutoresizingMaskIntoConstraints = false
        return view
    }

    private func makeWindows() {
        guard !terminating else { return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "韭留美 · 实时小盘口"
        window.minSize = NSSize(width: 720, height: 540)
        window.isReleasedWhenClosed = false
        let mainWeb = webView()
        let mainContainer = NSView(frame: NSRect(x: 0, y: 0, width: 1180, height: 820))
        mainContainer.addSubview(mainWeb)
        NSLayoutConstraint.activate([
            mainWeb.leadingAnchor.constraint(equalTo: mainContainer.leadingAnchor),
            mainWeb.trailingAnchor.constraint(equalTo: mainContainer.trailingAnchor),
            mainWeb.topAnchor.constraint(equalTo: mainContainer.topAnchor),
            mainWeb.bottomAnchor.constraint(equalTo: mainContainer.bottomAnchor)
        ])
        window.contentView = mainContainer
        mainWeb.load(URLRequest(url: baseURL.appendingPathComponent("pet.html")))
        window.center(); mainWindow = window

        var desiredFrame = NSRect(x: 80, y: 100, width: 330, height: 440)
        if !smokeMode, let saved = UserDefaults.standard.string(forKey: petFramePreference) {
            let parsed = NSRectFromString(saved)
            if parsed.origin.x.isFinite && parsed.origin.y.isFinite && parsed.width > 0 && parsed.height > 0 {
                desiredFrame.origin = parsed.origin
            }
        }
        let panel = PetPanel(contentRect: clampedPetFrame(desiredFrame), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.delegate = self
        panel.title = "韭留美桌宠"
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        let container = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
        let petWeb = webView()
        petWeb.configuration.userContentController.add(self, name: "petDragLayout")
        petWeb.configuration.userContentController.add(self, name: "petMemeShare")
        let bodyOverlay = PetBodyDragOverlay()
        bodyOverlay.translatesAutoresizingMaskIntoConstraints = false
        bodyOverlay.webView = petWeb
        bodyOverlay.identifier = NSUserInterfaceItemIdentifier("jiuliu-pet-body-drag")
        bodyOverlay.toolTip = "拖动角色身体移动桌宠，轻点互动"
        bodyOverlay.setAccessibilityElement(true)
        bodyOverlay.setAccessibilityRole(.group)
        bodyOverlay.setAccessibilityLabel("韭留美身体，可拖动或右键互动")
        bodyOverlay.setAccessibilityHelp("按住身体拖动移动；轻点互动；右键可挥手、伸懒腰、打瞌睡、查看表情包或打开面板。")
        bodyOverlay.clampFrame = { [weak self] frame in self?.clampedPetFrame(frame) ?? frame }
        bodyOverlay.openPanel = { [weak self] in self?.showMain() }
        bodyOverlay.onLayout = { [weak self, weak petWeb] in
            if let petWeb { self?.updateBodyGeometry(petWeb) }
        }
        bodyDragOverlay = bodyOverlay
        let handle = DragHandle()
        handle.translatesAutoresizingMaskIntoConstraints = false
        handle.toolTip = "拖动这里移动桌宠"
        handle.setAccessibilityLabel("拖动桌宠")
        container.addSubview(petWeb); container.addSubview(bodyOverlay); container.addSubview(handle)
        NSLayoutConstraint.activate([
            bodyOverlay.leadingAnchor.constraint(equalTo: petWeb.leadingAnchor), bodyOverlay.trailingAnchor.constraint(equalTo: petWeb.trailingAnchor),
            bodyOverlay.topAnchor.constraint(equalTo: petWeb.topAnchor), bodyOverlay.bottomAnchor.constraint(equalTo: petWeb.bottomAnchor),
            petWeb.leadingAnchor.constraint(equalTo: container.leadingAnchor), petWeb.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            petWeb.bottomAnchor.constraint(equalTo: container.bottomAnchor), petWeb.topAnchor.constraint(equalTo: container.topAnchor, constant: 24),
            handle.leadingAnchor.constraint(equalTo: container.leadingAnchor), handle.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            handle.topAnchor.constraint(equalTo: container.topAnchor), handle.heightAnchor.constraint(equalToConstant: 24)
        ])
        panel.contentView = container
        petWeb.load(URLRequest(url: URL(string: "pet.html?desktop=1", relativeTo: baseURL)!.absoluteURL))
        petWindow = panel
        lastPetFrame = panel.frame
        if petWantsVisible { panel.orderFrontRegardless() }
        showMain()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: { $0.scheme == "jiuliupet" && $0.host == "panel" }) { showMain() }
    }
    @objc private func showMain() { mainWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    private func updateBodyGeometry(_ web: WKWebView) {
        guard !measuringBody, web === bodyDragOverlay?.webView else { return }
        measuringBody = true
        let script = """
        (() => {
          if (!window.__jiuliuNativeDragLayout) {
            let scheduled = false;
            const report = () => {
              scheduled = false;
              const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
              const art = document.getElementById('pet-art');
              if (!art) return;
              const excluded = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="dialog"],#meme-popover'))
                .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
                .slice(0,100).map(rect);
              // Outer art is centered by translateX(-50%); measure the layout box,
              // independent of reaction animation transforms.
              const anchor = art.offsetParent?.getBoundingClientRect();
              const body = anchor ? {x:anchor.x+art.offsetLeft-art.offsetWidth/2,y:anchor.y+art.offsetTop,width:art.offsetWidth,height:art.offsetHeight} : rect(art);
              window.webkit.messageHandlers.petDragLayout.postMessage({body,excluded});
            };
            const schedule = () => { if(!scheduled){scheduled=true;requestAnimationFrame(report);} };
            new ResizeObserver(schedule).observe(document.documentElement);
            new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','style','class','open']});
            window.addEventListener('resize',schedule);
            window.__jiuliuNativeDragLayout = report;
          }
          window.__jiuliuNativeDragLayout();
        })()
        """
        web.evaluateJavaScript(script) { [weak self] _, _ in self?.measuringBody = false }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "petMemeShare" {
            let origin = message.frameInfo.securityOrigin
            guard !terminating, !smokeMode, message.frameInfo.isMainFrame,
                  origin.protocol == "http", origin.host == "127.0.0.1", origin.port == 8766,
                  let url = message.frameInfo.request.url,
                  url.scheme == "http", url.host == "127.0.0.1", url.port == servicePort, url.path == "/pet.html",
                  message.webView === bodyDragOverlay?.webView,
                  let data = message.body as? [String: Any], data.count == 1,
                  let file = data["file"] as? String,
                  ["meme-generated-profit.png", "meme-generated-buy.png", "meme-generated-loss.png"].contains(file),
                  let panel = petWindow, panel.isVisible, let view = panel.contentView,
                  let resources = Bundle.main.resourceURL else { return }
            let assets = resources.appendingPathComponent("web/assets", isDirectory: true).resolvingSymlinksInPath()
            let imageURL = assets.appendingPathComponent(file).resolvingSymlinksInPath()
            guard imageURL.deletingLastPathComponent() == assets,
                  let image = NSImage(contentsOf: imageURL), image.isValid else {
                showError("表情暂时无法分享", "应用内表情资源缺失或不可读取，请重新打包应用。")
                return
            }
            let picker = NSSharingServicePicker(items: [image])
            memeSharePicker = picker
            // Only present choices. The user explicitly selects a destination and completes sending.
            picker.show(relativeTo: NSRect(x: view.bounds.midX - 1, y: 35, width: 2, height: 2), of: view, preferredEdge: .minY)
            return
        }
        guard message.name == "petDragLayout", message.frameInfo.isMainFrame,
              message.webView === bodyDragOverlay?.webView,
              let data = message.body as? [String: Any], let overlay = bodyDragOverlay else { return }
        func rect(_ raw: Any?) -> NSRect? {
            guard let item = raw as? [String: Double], let x = item["x"], let y = item["y"],
                  let w = item["width"], let h = item["height"],
                  [x,y,w,h].allSatisfy({ $0.isFinite && abs($0) < 100000 }), w >= 0, h >= 0 else { return nil }
            let clipped = NSRect(x: x, y: y, width: w, height: h).intersection(overlay.bounds)
            return clipped.isNull ? .zero : clipped
        }
        overlay.bodyRect = rect(data["body"]) ?? .zero
        overlay.excludedRects = (data["excluded"] as? [Any] ?? []).prefix(100).compactMap(rect)
        overlay.window?.invalidateCursorRects(for: overlay)
    }

    private func clampedPetFrame(_ frame: NSRect) -> NSRect {
        PetWindowGeometry.clamp(frame, to: NSScreen.screens.map(\.visibleFrame))
    }
    @objc private func screensChanged() {
        guard let panel = petWindow else { return }
        bodyDragOverlay?.cancelInteraction()
        let next = clampedPetFrame(panel.frame)
        if next != panel.frame { panel.setFrame(next, display: panel.isVisible) }
        lastPetFrame = panel.frame
    }
    func applicationDidHide(_ notification: Notification) { bodyDragOverlay?.cancelInteraction() }
    func windowDidResignKey(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window === petWindow { bodyDragOverlay?.cancelInteraction() }
    }
    func windowDidMove(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === petWindow else { return }
        // The top strip uses AppKit's drag loop; constrain that path as well.
        let visible = clampedPetFrame(window.frame)
        if visible != window.frame { window.setFrame(visible, display: window.isVisible) }
        // Only update memory during dragging; UserDefaults is written once on normal quit.
        lastPetFrame = window.frame
    }
    private func savePetPreferences() {
        guard !smokeMode, let frame = lastPetFrame ?? petWindow?.frame else { return }
        UserDefaults.standard.set(NSStringFromRect(clampedPetFrame(frame)), forKey: petFramePreference)
        UserDefaults.standard.set(petWantsVisible, forKey: petVisiblePreference)
    }
    private func notifyPetVisibility(_ web: WKWebView) {
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('jiuliu-visibility',{detail:{visible:\(petWantsVisible ? "true" : "false")}}))", completionHandler: nil)
    }
    @objc private func togglePet() {
        guard let panel = petWindow else { return }
        petWantsVisible.toggle()
        if petWantsVisible { screensChanged(); panel.orderFrontRegardless() } else { bodyDragOverlay?.cancelInteraction(); panel.orderOut(nil) }
        if let web = panel.contentView?.subviews.compactMap({ $0 as? WKWebView }).first { notifyPetVisibility(web) }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showMain(); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminating else { return .terminateNow }
        bodyDragOverlay?.cancelInteraction()
        savePetPreferences()
        terminating = true; startup?.cancel(); mouseTelemetry.stop()
        guard let process = ownedService, process.isRunning else { return .terminateNow }
        // Graceful Node SIGINT saves the bounded snapshot; no port-based process killing.
        process.interrupt()
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<30 {
                if !process.isRunning { break }
                Thread.sleep(forTimeInterval: 0.1)
            }
            if process.isRunning { process.terminate() }
            DispatchQueue.main.async {
                try? self.serviceLog?.close()
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http", url.host == "127.0.0.1", url.port == servicePort {
            let desktop = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "desktop" && $0.value == "1" }) == true
            if url.path == "/pet.html", !desktop, (action.targetFrame == nil || webView.window === petWindow) {
                showMain(); decisionHandler(.cancel)
            } else if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
            return
        }
        if action.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled && !terminating { showError("页面暂时无法打开", error.localizedDescription + "\n请确认本地采集服务仍在运行。") }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.window === petWindow { notifyPetVisibility(webView); updateBodyGeometry(webView) }
        guard smokeMode, !smokeFinished else { return }
        Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            let script = """
            (() => {
              const desktop = document.documentElement.classList.contains('desktop-mode');
              const object = document.getElementById('pet-art');
              const characterLoaded = object?.tagName === 'IMG' && object.complete && object.naturalWidth > 0 && /assets\\/kurumi-(gifs\\/|apng\\/|generated-idle)/.test(object.getAttribute('src') || '');
              return {ready:document.readyState, desktop, chartLibrary:typeof window.Chart !== 'undefined' && typeof window.PetCharts !== 'undefined',
                legacyChartLibrary:typeof window.LightweightCharts !== 'undefined',
                performanceCanvas:!!document.querySelector('#performance-chart canvas'),
                timeframeOptions:[...document.querySelectorAll('#chart-timeframe option')].map(e=>e.value),
                chartTypes:typeof window.Chart === 'undefined' ? [] : Object.values(window.Chart.instances).map(c=>c.config.type),
                performanceText:document.getElementById('performance-note')?.textContent || '',
                connection:document.getElementById('connection-text')?.textContent || '',
                online:desktop ? document.body.dataset.localConnection === 'online' : document.getElementById('connection-dot')?.classList.contains('online') || false,
                markets:document.querySelectorAll('#market-strip .market-tile').length,
                characterLoaded, canvasCount:document.querySelectorAll('canvas').length,
                background:getComputedStyle(document.body).backgroundColor,
                width:document.body.clientWidth, height:document.body.clientHeight,
                viewportWidth:window.innerWidth, viewportHeight:window.innerHeight,
                url:location.href};
            })()
            """
            for _ in 0..<30 {
                guard !self.smokeFinished else { return }
                do {
                    if var result = try await webView.evaluateJavaScript(script) as? [String: Any] {
                        let desktop = result["desktop"] as? Bool == true
                        let boundsOK = (result["width"] as? Double ?? 0) > 100 && (result["height"] as? Double ?? 0) > 100 && webView.bounds.width > 100 && webView.bounds.height > 100
                        let types = result["chartTypes"] as? [String] ?? []
                        let candlesOK = result["timeframeOptions"] as? [String] == ["minute", "hour", "day"] && !types.isEmpty && types.allSatisfy { $0 == "candlestick" }
                        let contentOK = result["online"] as? Bool == true && (desktop ? (result["chartLibrary"] as? Bool == false && result["characterLoaded"] as? Bool == true && result["background"] as? String == "rgba(0, 0, 0, 0)") : ((result["markets"] as? Int ?? 0) >= 3 && result["chartLibrary"] as? Bool == true && result["legacyChartLibrary"] as? Bool == false && result["performanceCanvas"] as? Bool == true && (result["canvasCount"] as? Int ?? 0) > 0 && candlesOK))
                        result["nativeWidth"] = webView.bounds.width; result["nativeHeight"] = webView.bounds.height
                        result["passed"] = boundsOK && contentOK && result["ready"] as? String == "complete"
                        let key = webView.url?.query?.contains("desktop=1") == true ? "pet" : "main"
                        self.smokeResults[key] = result
                        if result["passed"] as? Bool == true {
                            if self.smokeResults.count == 2 && self.smokeResults.values.allSatisfy({ $0["passed"] as? Bool == true }) { self.finishSmoke() }
                            return
                        }
                    }
                } catch { self.finishSmoke(error: error.localizedDescription); return }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            self.finishSmoke(error: "DOM readiness checks did not pass")
        }
    }
    private func finishSmoke(error: String? = nil) {
        guard !smokeFinished else { return }
        smokeFinished = true
        let passed = error == nil && smokeResults.count == 2 && smokeResults.values.allSatisfy { $0["passed"] as? Bool == true }
        smokeExit = passed ? 0 : 1
        let report: [String: Any] = ["passed": passed, "error": error ?? NSNull(), "pages": smokeResults, "peripherals": mouseTelemetry.snapshot(), "bodyDrag": bodyDragOverlay?.snapshot() ?? [:], "ownsService": ownedService?.isRunning == true]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
        terminating = true
        let child = ownedService
        let status = smokeExit
        let log = serviceLog
        DispatchQueue.global(qos: .userInitiated).async {
            if let child, child.isRunning {
                child.interrupt()
                for _ in 0..<30 {
                    if !child.isRunning { break }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                if child.isRunning { child.terminate() }
                for _ in 0..<10 {
                    if !child.isRunning { break }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                if child.isRunning { fputs("Smoke service did not stop within deadline\\n", stderr); exit(1) }
            }
            try? log?.close()
            exit(status)
        }
    }
    func applicationWillTerminate(_ notification: Notification) { if smokeMode && smokeExit != 0 { exit(smokeExit) } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if !terminating { webView.reload() } }
    private func showError(_ title: String, _ text: String) {
        if smokeMode { finishSmoke(error: title + ": " + text); return }
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = text
        alert.alertStyle = .warning; alert.addButton(withTitle: "知道了")
        NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = Application()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { application.run() }
}
