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
    private var lampColor: NSColor = .systemGreen

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

        // 托盘：template 图标 + 灯色点（比文字 "● agentbd" 省菜单栏宽度）
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
        lampColor =
            lamp == "red" ? .systemRed
            : lamp == "amber" ? .systemOrange
            : .systemGreen
        guard let button = statusItem.button else { return }
        // 灯点画成小圆点叠在图标右下角；菜单栏图标的颜色是灯位的唯一载体
        let dotColor = lampColor // 闭包外取一次，避免在 escaping 闭包里捕获 self
        let dot = NSImage(size: NSSize(width: 6, height: 6), flipped: false) { rect in
            let path = NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5))
            dotColor.setFill()
            path.fill()
            NSColor.black.setStroke() // 深色描边：任何菜单栏底色下都看得清
            path.lineWidth = 1
            path.stroke()
            return true
        }
        if let base = loadTemplateIcon() {
            let composed = NSImage(size: base.size, flipped: false) { _ in
                base.draw(in: NSRect(origin: .zero, size: base.size))
                dot.draw(in: NSRect(x: base.size.width - 8, y: -2, width: 6, height: 6))
                return true
            }
            button.image = composed
        } else {
            button.image = dot
            button.image?.isTemplate = false
        }
    }

    /// 菜单栏 template 图标（单色，系统按深浅色菜单栏自动反相）
    private func loadTemplateIcon() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "menubar", withExtension: "png"),
              let img = NSImage(contentsOf: url) else { return nil }
        img.size = NSSize(width: 18, height: 18) // 固定逻辑尺寸（@2x 交给系统选）
        return img
    }

    private func pollLamp() {
        URLSession.shared.dataTask(with: panelURL.appendingPathComponent("api/state")) { [weak self] data, _, _ in
            guard let data else { return }
            let lamp = worstLamp(fromStateJSON: data) // 逻辑在 LampProbe.swift（可单测）
            DispatchQueue.main.async { self?.setLamp(lamp) }
        }.resume()
    }

    // launchd 按需唤醒冷启动 ~1s：首次连接失败时自动重试，不用手动刷新
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak webView] in
            webView?.load(URLRequest(url: panelURL))
        }
    }
}

@main
struct PanelMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // 托盘应用：不占 Dock，窗口照常
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
