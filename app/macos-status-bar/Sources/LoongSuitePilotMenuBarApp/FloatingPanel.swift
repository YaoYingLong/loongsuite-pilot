import SwiftUI
import AppKit

// 本文件封装点击状态栏图标后显示的 AppKit 浮动面板。
// `StatusBarController` 负责创建和开关它，SwiftUI 的 `PanelContentView` 通过 `NSHostingView` 嵌入其中。
// 面板实例在应用生命周期内复用，关闭时只隐藏，不销毁。

/// 可跨桌面显示、可获得键盘焦点但不成为主窗口的透明浮动面板。
final class FloatingPanel: NSPanel {
    /// 承载 SwiftUI 内容并提供 macOS 原生毛玻璃材质的根视图。
    private let visualEffectView: NSVisualEffectView

    /// 创建固定行为的面板并配置窗口层级、材质和最小尺寸。
    /// - Parameter contentRect: 初始位置与大小；随后 `position(relativeTo:)` 会按状态栏按钮重新定位。
    init(contentRect: NSRect) {
        visualEffectView = NSVisualEffectView(frame: contentRect)
        super.init(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView, .utilityWindow],
            backing: .buffered,
            defer: false
        )

        // 隐藏传统标题栏外观，同时保留可关闭/调整大小所需的窗口能力。
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        isFloatingPanel = true
        animationBehavior = .utilityWindow
        minSize = NSSize(width: 420, height: 520)

        // 面板自身提供 SwiftUI 关闭按钮，因此隐藏 AppKit 的三个交通灯按钮。
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        // 使用系统 sidebar 材质，让面板随系统外观变化而不是绘制固定背景。
        visualEffectView.material = .sidebar
        visualEffectView.state = .active
        visualEffectView.blendingMode = .behindWindow
        visualEffectView.wantsLayer = true
        visualEffectView.layer?.cornerRadius = 18
        visualEffectView.layer?.masksToBounds = true
        contentView = visualEffectView
    }

    /// 允许面板获得键盘焦点，从而正常响应按钮和滚动操作。
    override var canBecomeKey: Bool { true }
    /// 不让临时面板成为应用主窗口，保持菜单栏工具的轻量交互语义。
    override var canBecomeMain: Bool { false }

    /// 用新的 SwiftUI 根视图替换面板内容，并通过四边约束使其跟随窗口缩放。
    /// - Parameter rootView: 要显示的 SwiftUI 视图，通常为 `PanelContentView`。
    func setRootView<Content: View>(_ rootView: Content) {
        let hostingView = NSHostingView(rootView: rootView)
        hostingView.translatesAutoresizingMaskIntoConstraints = false

        // 移除旧 hosting view，避免重复调用时叠加视图与约束。
        visualEffectView.subviews.forEach { $0.removeFromSuperview() }
        visualEffectView.addSubview(hostingView)

        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: visualEffectView.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: visualEffectView.trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: visualEffectView.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: visualEffectView.bottomAnchor),
        ])
    }

    /// 将面板水平居中放在状态栏按钮下方；空间不足时改到上方并限制在可见屏幕内。
    /// - Parameter statusButton: 当前菜单栏状态项的按钮，用它换算屏幕坐标。
    func position(relativeTo statusButton: NSStatusBarButton) {
        guard
            let buttonWindow = statusButton.window,
            let screen = buttonWindow.screen ?? NSScreen.main
        else {
            return
        }

        // 控件坐标先转换到窗口，再转换到屏幕，才能与 `visibleFrame` 使用同一坐标系。
        let buttonFrameOnScreen = buttonWindow.convertToScreen(statusButton.convert(statusButton.bounds, to: nil))
        let screenFrame = screen.visibleFrame
        let margin: CGFloat = 10
        let spacing: CGFloat = 8

        // `max/min` 双重限制避免面板越过屏幕左右边缘。
        var originX = buttonFrameOnScreen.midX - (frame.width / 2)
        originX = max(screenFrame.minX + margin, min(originX, screenFrame.maxX - frame.width - margin))

        // 默认显示在按钮下方；若下方不足，则尝试上方，最后再限制顶部边界。
        var originY = buttonFrameOnScreen.minY - frame.height - spacing
        if originY < screenFrame.minY + margin {
            originY = buttonFrameOnScreen.maxY + spacing
        }
        if originY + frame.height > screenFrame.maxY - margin {
            originY = screenFrame.maxY - frame.height - margin
        }

        setFrameOrigin(NSPoint(x: originX, y: originY))
    }
}
