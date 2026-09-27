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
        let dotColor = lampColor // 闭包外取一次，避免在 escaping 闭包里捕获 self
        button.image = compose(icon: makeMenuIcon(), lamp: dotColor)
    }

    /// 把「终端图标 + 右下角状态灯」合成一张菜单栏图。
    ///
    /// 两个关键细节（都是踩过的坑）：
    /// 1. 合成图**不能是 template**（里面有彩色灯点），所以图标本身失去了系统
    ///    自动反相能力 → 描边必须用 `labelColor` 语义色，否则深色菜单栏下会变成
    ///    "黑图标压在深色底上" = 看不见。
    /// 2. 灯点先画一圈**白色光环**再画实心色。直接用深色描边会和黑色图标连成
    ///    一坨；白色光环在浅色菜单栏上不显眼、在深色菜单栏上正好把彩色灯点
    ///    和白色图标分开。
    private func compose(icon: NSImage, lamp: NSColor) -> NSImage {
        let size = icon.size
        return NSImage(size: size, flipped: false) { _ in
            icon.draw(in: NSRect(origin: .zero, size: size))
            let d: CGFloat = 6.5
            let halo = NSBezierPath(ovalIn: NSRect(x: size.width - 7, y: -2, width: d, height: d))
            NSColor.white.setFill()
            halo.fill()
            let core = NSBezierPath(
                ovalIn: NSRect(x: size.width - 5.9, y: -0.9, width: d - 2.2, height: d - 2.2))
            lamp.setFill()
            core.fill()
            return true
        }
    }

    /// 菜单栏图标：**用 Core Graphics 现场画**，不读 PNG 资源。
    ///
    /// 为什么不用图片资源：原先 build.sh 用 `qlmanage -t` 把 SVG 转 PNG，但
    /// qlmanage 产出的是**带不透明背景的缩略图**（实测 alpha 通道 100% 不透明、
    /// 只有白/灰两种 RGB）——菜单栏里显示成一个白方块，根本不是图标。
    /// 改为运行时矢量绘制后：没有资产管线可坏、任意 Retina 倍率都清晰、
    /// 改形状只需改这段代码。
    ///
    /// 造型：终端提示符 `>_`。选它的理由是**小尺寸辨识度**——菜单栏图标首先要
    /// 能一眼看出是终端工具；"多节点汇聚成总线"那类隐喻缩到 18pt 会碎成看不清
    /// 的线条（前一版就是如此，视觉上像 sparkle）。
    ///
    /// 布局：外框**故意偏左上**，右下角空出来给状态灯；否则灯点会压在边框上，
    /// 和描边连成一坨黑块。
    private func makeMenuIcon() -> NSImage {
        let side: CGFloat = 18
        return NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            let s = rect.width / 18.0 // 按实际尺寸缩放，@1x/@2x 都正确
            func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * s, y: y * s) }

            // 语义描边色：自动适配浅色/深色菜单栏（合成图不是 template，没有反相）
            NSColor.labelColor.setStroke()
            let lw = 1.6 * s

            // 外框：(1.2,4.2) 12.4×12.4 圆角 2.4，偏左上给灯点让位
            let box = NSBezierPath(
                roundedRect: NSRect(x: 1.2 * s, y: 4.2 * s, width: 12.4 * s, height: 12.4 * s),
                xRadius: 2.4 * s, yRadius: 2.4 * s)
            box.lineWidth = lw
            box.stroke()

            // 提示符 ">"（与下划线作为一个整体，视觉中心对齐外框中心）
            let chevron = NSBezierPath()
            chevron.move(to: p(3.9, 13.1))
            chevron.line(to: p(6.5, 10.3))
            chevron.line(to: p(3.9, 7.5))
            chevron.lineWidth = lw
            chevron.lineCapStyle = .round
            chevron.lineJoinStyle = .round
            chevron.stroke()

            // 下划线 "_"（贴在提示符基线上，和 > 留出间距）
            let under = NSBezierPath()
            under.move(to: p(8.1, 7.8))
            under.line(to: p(11.0, 7.8))
            under.lineWidth = lw
            under.lineCapStyle = .round
            under.stroke()
            return true
        }
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
