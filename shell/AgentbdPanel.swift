// P2-3 桌面壳 —— 纯 Swift 的 WKWebView 包装（不引入 Rust/Tauri，零新工具链）。
//
// 为什么是 Swift 而不是 Tauri：本机已有完整 Xcode 工具链，系统 WebView 就够；
// 壳的价值 = 桌面图标 + 托盘红绿灯 + 双击即达，不增加任何功能——面板的全部
// 逻辑仍在 127.0.0.1:7787 的 serve 里，壳只是它的窗口。
//
// 与 launchd 按需唤醒协同：serve 空闲时进程数为 0，壳的 WebView 首次连接
// 会自动拉起后端（didFailProvisionalNavigation 里 1.5s 重试抹平冷启动）。
//
// 托盘灯：每 30s 轮询 /api/state，取所有服务里最差的一档染色
// （红 > 黄 > 绿），面板关着也能在菜单栏看到红灯。

import Cocoa
import WebKit

let panelURL = URL(string: "http://127.0.0.1:7787")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 主窗口 = 面板 WebView
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "agentbd 面板"
        window.center()
        webView = WKWebView(frame: window.contentView!.bounds)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView!.addSubview(webView)
        webView.load(URLRequest(url: panelURL))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // 托盘：彩色圆点 + 菜单
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        setLamp("green")
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "打开面板", action: #selector(showWindow), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "在浏览器中打开", action: #selector(openBrowser), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu

        // 灯色轮询（失败保持原色，下轮再试）
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.pollLamp() }
        pollLamp()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    @objc private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openBrowser() { NSWorkspace.shared.open(panelURL) }

    @objc private func quit() { NSApp.terminate(nil) }

    private func setLamp(_ lamp: String) {
        let color: NSColor =
            lamp == "red" ? .systemRed
            : lamp == "amber" ? .systemOrange
            : .systemGreen
        statusItem.button?.attributedTitle = NSAttributedString(
            string: "● agentbd",
            attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 12)])
    }

    private func pollLamp() {
        URLSession.shared.dataTask(with: panelURL.appendingPathComponent("api/state")) { [weak self] data, _, _ in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let services = j["services"] as? [[String: Any]] else { return }
            var worst = "green"
            for s in services {
                let l = s["lamp"] as? String ?? "unknown"
                if l == "red" { worst = "red" }
                else if l == "amber", worst == "green" { worst = "amber" }
            }
            DispatchQueue.main.async { self?.setLamp(worst) }
        }.resume()
    }

    // launchd 按需唤醒冷启动 ~1s：首次连接失败时自动重试，不用手动刷新
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak webView] in
            webView?.load(URLRequest(url: panelURL))
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // 托盘应用：不占 Dock，窗口照常
let delegate = AppDelegate()
app.delegate = delegate
app.run()
