import AppKit

// A small local launcher. The source folder remains the editable application.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var status: NSTextField!
    var busy = false
    var settings: [String: String] = [:]
    let defaults = UserDefaults.standard

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let url = Bundle.main.url(forResource: "workspace", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] { settings = parsed }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 430, height: 175), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "AI Workforce"
        window.center()
        let title = NSTextField(labelWithString: "Opening your workforce")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.frame = NSRect(x: 28, y: 113, width: 374, height: 30)
        status = NSTextField(wrappingLabelWithString: "Checking your local workspace…")
        status.frame = NSRect(x: 28, y: 48, width: 374, height: 54)
        status.textColor = .secondaryLabelColor
        let progress = NSProgressIndicator(frame: NSRect(x: 28, y: 27, width: 374, height: 6))
        progress.style = .bar; progress.isIndeterminate = true; progress.startAnimation(nil)
        window.contentView?.addSubview(title); window.contentView?.addSubview(status); window.contentView?.addSubview(progress)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func selectSource() -> String? {
        let panel = NSOpenPanel()
        panel.title = "Choose your AI Workforce source folder"
        panel.message = "Select the AI Employee folder that contains your frontend and backend."
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.prompt = "Use this folder"
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        defaults.set(url.path, forKey: "sourceFolder")
        return url.path
    }

    func start() {
        guard !busy else { return }
        var repo = defaults.string(forKey: "sourceFolder") ?? settings["repoRoot"] ?? ""
        if !FileManager.default.fileExists(atPath: repo + "/src/cli/index.ts") {
            guard let chosen = selectSource() else { NSApp.terminate(nil); return }
            repo = chosen
        }
        let candidates = [settings["nodePath"] ?? "", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = candidates.first(where: { !$0.isEmpty && FileManager.default.isExecutableFile(atPath: $0) }) else {
            let alert = NSAlert(); alert.messageText = "Node.js is needed to start this workspace"
            alert.informativeText = "Install Node.js using its Mac installer, then open AI Workforce again."
            alert.addButton(withTitle: "Get Node.js"); alert.addButton(withTitle: "Close")
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!) }
            NSApp.terminate(nil); return
        }
        guard let helper = Bundle.main.url(forResource: "desktop-launch", withExtension: "mjs") else {
            showError(["message": "The app launcher is incomplete. Restore AI Workforce.app from this project's installer."]); return
        }
        busy = true
        status.stringValue = "Preparing your workspace and opening it when ready. First startup can take a few minutes."
        let source = repo
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(); let output = Pipe()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [helper.path, "--repo", source]
            process.currentDirectoryURL = URL(fileURLWithPath: source)
            process.standardOutput = output; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
            var result: [String: Any] = ["message": "The local workspace could not be started. Try again."]
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] { result = parsed }
            } catch { result = ["message": "AI Workforce could not open its local launcher. Check that the source folder and Node.js are still available."] }
            let observed = result
            DispatchQueue.main.async {
                self.busy = false
                if observed["ok"] as? Bool == true, let text = observed["url"] as? String,
                   let url = URL(string: text), url.scheme == "http", url.host == "127.0.0.1" {
                    if NSWorkspace.shared.open(url) { NSApp.terminate(nil) }
                    else { self.showError(["message": "Your workforce is running, but your default browser could not open it. Check your Mac's default browser and try again."]) }
                } else { self.showError(observed) }
            }
        }
    }

    func showError(_ result: [String: Any]) {
        let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "AI Workforce needs attention"
        alert.informativeText = result["message"] as? String ?? "The local workspace could not be started."
        alert.addButton(withTitle: "Try again")
        let log = (result["logPath"] as? String).flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
        alert.addButton(withTitle: log == nil ? "Choose source folder" : "Open startup log")
        alert.addButton(withTitle: "Close")
        let choice = alert.runModal()
        if choice == .alertFirstButtonReturn { start() }
        else if choice == .alertSecondButtonReturn {
            if let log = log { NSWorkspace.shared.open(URL(fileURLWithPath: log)); NSApp.terminate(nil) }
            else if selectSource() != nil { start() } else { NSApp.terminate(nil) }
        } else { NSApp.terminate(nil) }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
