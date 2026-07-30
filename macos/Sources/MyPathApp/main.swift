import AppKit
import WebKit
import Foundation

// MARK: - Config

enum Config {
    static let port = Int(ProcessInfo.processInfo.environment["MYPATH_API_PORT"] ?? "8787") ?? 8787
    static var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    static var healthURL: URL { URL(string: "http://127.0.0.1:\(port)/health")! }
}

// MARK: - Project root resolution

enum ProjectRoot {
    /// Prefer MYPATH_ROOT, then bundled Resources, then walk up from executable / cwd.
    static func resolve() throws -> URL {
        let env = ProcessInfo.processInfo.environment
        if let raw = env["MYPATH_ROOT"], !raw.isEmpty {
            let url = URL(fileURLWithPath: raw, isDirectory: true)
            if isMyPathRoot(url) { return url }
            throw AppError.rootInvalid(raw)
        }

        if let res = Bundle.main.resourceURL {
            let candidate = res.appendingPathComponent("mypath", isDirectory: true)
            if isMyPathRoot(candidate) { return candidate }
            if isMyPathRoot(res) { return res }
        }

        // Executable-relative (swift run / .app/Contents/MacOS)
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        var dir = exe.deletingLastPathComponent()
        for _ in 0..<8 {
            if isMyPathRoot(dir) { return dir }
            // If we're inside .app/Contents/MacOS, jump to Resources/mypath
            if dir.lastPathComponent == "MacOS" {
                let resources = dir.deletingLastPathComponent().appendingPathComponent("Resources/mypath")
                if isMyPathRoot(resources) { return resources }
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }

        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        if isMyPathRoot(cwd) { return cwd }

        throw AppError.rootNotFound
    }

    static func isMyPathRoot(_ url: URL) -> Bool {
        let fm = FileManager.default
        let server = url.appendingPathComponent("server/index.js").path
        let web = url.appendingPathComponent("web/index.html").path
        return fm.fileExists(atPath: server) && fm.fileExists(atPath: web)
    }
}

// MARK: - Node resolution

enum NodeBinary {
    static func resolve() throws -> String {
        if let n = ProcessInfo.processInfo.environment["MYPATH_NODE"], !n.isEmpty {
            if FileManager.default.isExecutableFile(atPath: n) { return n }
        }
        // PATH lookup
        if let path = shellWhich("node") { return path }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.nvm/versions/node/v22.22.2/bin/node",
            "\(home)/.nvm/versions/node/v22.14.0/bin/node",
            "\(home)/.nvm/versions/node/v20.18.0/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        // nvm wildcard: newest under ~/.nvm/versions/node/*/bin/node
        let nvmRoot = "\(home)/.nvm/versions/node"
        if let vers = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot) {
            for v in vers.sorted().reversed() {
                let p = "\(nvmRoot)/\(v)/bin/node"
                if FileManager.default.isExecutableFile(atPath: p) { return p }
            }
        }
        throw AppError.nodeNotFound
    }

    private static func shellWhich(_ name: String) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        p.arguments = [name]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        // Inherit a richer PATH for GUI apps (launchd PATH is thin)
        var env = ProcessInfo.processInfo.environment
        let extra = [
            "\(FileManager.default.homeDirectoryForCurrentUser.path)/.nvm/versions/node/v22.22.2/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        let path = ([env["PATH"] ?? ""] + extra).joined(separator: ":")
        env["PATH"] = path
        p.environment = env
        try? p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty == false) ? s : nil
    }
}

// MARK: - Server process

final class ServerProcess {
    private var process: Process?
    private let root: URL
    private let node: String
    private let logHandle: FileHandle?

    init(root: URL, node: String) {
        self.root = root
        self.node = node
        let logURL = root.appendingPathComponent("data/desktop-server.log")
        try? FileManager.default.createDirectory(at: root.appendingPathComponent("data"), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        self.logHandle = try? FileHandle(forWritingTo: logURL)
    }

    var isRunning: Bool { process?.isRunning == true }

    func start() throws {
        if isRunning { return }
        if isHealthy() { return } // already up (e.g. manual)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server/index.js"]
        p.currentDirectoryURL = root
        p.standardOutput = logHandle
        p.standardError = logHandle

        var env = ProcessInfo.processInfo.environment
        env["MYPATH_API_PORT"] = String(Config.port)
        env["PORT"] = String(Config.port)
        env["MYPATH_DATA_DIR"] = root.appendingPathComponent("data").path
        // Ensure PATH for any child tools
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = [
            URL(fileURLWithPath: node).deletingLastPathComponent().path,
            "\(home)/.nvm/versions/node/v22.22.2/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            env["PATH"] ?? "",
            "/usr/bin",
            "/bin",
        ].joined(separator: ":")
        p.environment = env

        // Own process group so we can kill the tree
        p.terminationHandler = { [weak self] _ in
            self?.process = nil
        }

        try p.run()
        // setpgid so terminate kills children if any
        if p.processIdentifier > 0 {
            setpgid(p.processIdentifier, p.processIdentifier)
        }
        process = p
    }

    func waitUntilHealthy(timeout: TimeInterval = 15) throws {
        if isHealthy() { return }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let p = process, !p.isRunning {
                throw AppError.serverExited(p.terminationStatus)
            }
            if isHealthy() { return }
            Thread.sleep(forTimeInterval: 0.15)
        }
        throw AppError.serverTimeout
    }

    func stop() {
        guard let p = process, p.isRunning else { return }
        let pid = p.processIdentifier
        // SIGTERM process group
        kill(-pid, SIGTERM)
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if p.isRunning {
            kill(-pid, SIGKILL)
            p.terminate()
        }
        process = nil
    }

    private func isHealthy() -> Bool {
        var req = URLRequest(url: Config.healthURL, timeoutInterval: 0.4)
        req.httpMethod = "GET"
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            defer { sem.signal() }
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let data, let s = String(data: data, encoding: .utf8) else { return }
            ok = s.contains("mypath") || s.contains("\"ok\"")
        }.resume()
        _ = sem.wait(timeout: .now() + 0.5)
        return ok
    }
}

// MARK: - Errors

enum AppError: LocalizedError {
    case rootNotFound
    case rootInvalid(String)
    case nodeNotFound
    case serverTimeout
    case serverExited(Int32)

    var errorDescription: String? {
        switch self {
        case .rootNotFound:
            return "Could not find MyPath project root (server/index.js + web/index.html).\nSet MYPATH_ROOT to the project directory."
        case .rootInvalid(let p):
            return "MYPATH_ROOT is not a MyPath project: \(p)"
        case .nodeNotFound:
            return "Could not find Node.js. Install Node or set MYPATH_NODE to the node binary."
        case .serverTimeout:
            return "MyPath server did not become healthy on port \(Config.port)."
        case .serverExited(let code):
            return "MyPath server exited early (code \(code)). See data/desktop-server.log"
        }
    }
}

// MARK: - WebView

final class WebViewController: NSViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 960), configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        #if DEBUG
        if #available(macOS 13.3, *) {
            wv.isInspectable = true
        }
        #endif
        self.webView = wv
        self.view = wv
    }

    func loadHome() {
        webView.load(URLRequest(url: Config.baseURL))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // Keep app traffic local; open external http(s) in system browser
        if navigationAction.navigationType == .linkActivated {
            let host = url.host ?? ""
            if (url.scheme == "http" || url.scheme == "https"),
               host != "127.0.0.1", host != "localhost" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

// MARK: - App Delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var server: ServerProcess?
    private var startedServer = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenus()

        do {
            let root = try ProjectRoot.resolve()
            let node = try NodeBinary.resolve()
            let srv = ServerProcess(root: root, node: node)
            self.server = srv

            // If health already OK, don't own the process (don't kill on quit)
            if !srv.isRunning && !healthQuick() {
                try srv.start()
                startedServer = true
                try srv.waitUntilHealthy()
            } else if !healthQuick() {
                try srv.start()
                startedServer = true
                try srv.waitUntilHealthy()
            }
        } catch {
            showFatal(error)
            return
        }

        let vc = WebViewController()
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 960),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "MyPath"
        window.contentViewController = vc
        window.minSize = NSSize(width: 1000, height: 700)
        window.center()
        window.setFrameAutosaveName("MyPathMain")
        window.backgroundColor = NSColor(calibratedRed: 0.043, green: 0.043, blue: 0.047, alpha: 1)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        vc.loadHome()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        if startedServer {
            server?.stop()
        }
    }

    private func healthQuick() -> Bool {
        var req = URLRequest(url: Config.healthURL, timeoutInterval: 0.3)
        req.httpMethod = "GET"
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            defer { sem.signal() }
            ok = (resp as? HTTPURLResponse)?.statusCode == 200
        }.resume()
        _ = sem.wait(timeout: .now() + 0.4)
        return ok
    }

    private func showFatal(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "MyPath failed to start"
        alert.informativeText = error.localizedDescription
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    private func buildMenus() {
        let main = NSMenu()
        let appMenuItem = NSMenuItem()
        main.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About MyPath", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit MyPath", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadWeb), keyEquivalent: "r")
        viewItem.submenu = view

        NSApp.mainMenu = main
    }

    @objc private func reloadWeb() {
        (window.contentViewController as? WebViewController)?.loadHome()
    }
}

// MARK: - Entry

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
