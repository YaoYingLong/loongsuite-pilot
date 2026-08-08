import AppKit
import SwiftUI
import Combine

// 本文件是菜单栏应用的 UI 编排中心：创建状态栏图标和浮动面板，订阅运行状态与指标状态，
// 并把鼠标点击转换为打开、关闭或显示右键菜单。它不直接读取 Collector 文件，文件 I/O
// 分别由 `PilotRuntimeStore` 和 `PilotMetricsStore` 完成。

@MainActor
/// 管理 AppKit 状态项、SwiftUI 面板和两个 ObservableObject 的完整生命周期。
///
/// `@MainActor` 保证窗口、菜单以及 Combine 回调只在主线程修改。构造函数启动定时刷新，
/// `teardown()` 必须在应用退出时调用，以注销定时器和全局事件监听器。
final class StatusBarController {
    /// 读取 `runtime.json`，判断 Collector 是否可达以及菜单栏功能是否启用。
    private let runtimeStore = PilotRuntimeStore()
    /// 读取 `metrics-summary.json`，为菜单标题和面板提供统计快照。
    private let metricsStore = PilotMetricsStore()
    /// macOS 菜单栏中长期存在的状态项。
    private let statusItem: NSStatusItem
    /// 点击状态项后复用的浮动面板。
    private let panel: FloatingPanel
    /// 全局鼠标监听器句柄；面板打开时注册、关闭时释放。
    private var eventMonitor: Any?
    /// 强引用 Combine 订阅；集合释放时订阅自动取消。
    private var cancellables = Set<AnyCancellable>()

    /// 创建全部 UI 资源、建立状态绑定并启动运行状态和指标轮询。
    /// 初始化必须发生在主线程；该过程不创建子进程或网络连接。
    init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        panel = FloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 760))

        StatusBarLogger.info("initializing status bar controller")
        configureStatusItem()
        configurePanel()
        bindState()
        runtimeStore.start()
        metricsStore.start()
    }

    /// 停止两个 Store 并移除全局事件监听器。应用退出前由 `AppDelegate` 调用。
    /// 本方法可安全处理尚未注册监听器的情况。
    func teardown() {
        StatusBarLogger.info("tearing down status bar controller")
        runtimeStore.stop()
        metricsStore.stop()
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
        }
    }

    /// 配置图标、初始 token 标题和左右键事件，将点击交给 Objective-C selector。
    private func configureStatusItem() {
        guard let button = statusItem.button else {
            StatusBarLogger.error("failed to access status item button")
            return
        }

        let image = NSImage(systemSymbolName: "chart.bar.xaxis", accessibilityDescription: "LoongSuite Pilot")
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading
        button.title = metricsStore.snapshot.menuBarTitle
        button.target = self
        button.action = #selector(handleStatusItemClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        StatusBarLogger.info("status item configured")
    }

    /// 把 SwiftUI 根视图嵌入 AppKit 面板，并用弱引用闭包避免视图和控制器循环持有。
    private func configurePanel() {
        panel.setRootView(
            PanelContentView(
                runtimeStore: runtimeStore,
                metricsStore: metricsStore,
                closePanel: { [weak self] in
                    self?.closePanel()
                }
            )
        )
    }

    /// 订阅两个 Store 的 `@Published` 快照：指标变化更新标题，运行配置变化控制状态项可见性。
    /// `.store(in:)` 把订阅生命周期绑定到本控制器。
    private func bindState() {
        metricsStore.$snapshot
            .sink { [weak self] snapshot in
                self?.statusItem.button?.title = snapshot.menuBarTitle
            }
            .store(in: &cancellables)

        runtimeStore.$snapshot
            .sink { [weak self] snapshot in
                guard let self else { return }
                self.statusItem.isVisible = snapshot.isStatusBarAppEnabled
                if !snapshot.isStatusBarAppEnabled {
                    self.closePanel()
                }
            }
            .store(in: &cancellables)
    }

    @objc
    /// AppKit 点击回调：右键打开命令菜单，其余点击切换统计面板。
    /// - Parameter sender: AppKit 传入的事件发送者；当前实现只读取 `NSApp.currentEvent`。
    private func handleStatusItemClick(_ sender: Any?) {
        guard let event = NSApp.currentEvent else {
            togglePanel()
            return
        }

        switch event.type {
        case .rightMouseUp:
            showContextMenu()
        default:
            togglePanel()
        }
    }

    /// 根据当前可见性打开或隐藏同一个面板实例。
    private func togglePanel() {
        if panel.isVisible {
            closePanel()
        } else {
            openPanel()
        }
    }

    /// 打开面板前即时刷新两个快照、重算屏幕位置，并注册点击外部关闭监听器。
    private func openPanel() {
        // 功能被运行时配置关闭或状态栏按钮不可用时，不创建任何额外 UI 状态。
        guard runtimeStore.snapshot.isStatusBarAppEnabled, let button = statusItem.button else {
            return
        }

        // 文件读取异步执行；当前缓存仍可立即显示，读取完成后 Combine 会触发重绘。
        runtimeStore.refresh(forceReload: false)
        metricsStore.refresh()
        panel.position(relativeTo: button)
        panel.orderFrontRegardless()
        panel.makeKey()
        startEventMonitor()
        NSApp.activate(ignoringOtherApps: true)
        StatusBarLogger.info("panel opened")
    }

    /// 只隐藏面板并停止外部点击监听；面板和 Store 保留，便于下次快速打开。
    func closePanel() {
        panel.orderOut(nil)
        stopEventMonitor()
    }

    /// 临时把右键菜单挂到状态项，模拟点击显示后立即解绑，恢复左键打开面板的行为。
    private func showContextMenu() {
        let menu = NSMenu()
        let openItem = NSMenuItem(title: "打开面板", action: #selector(openPanelFromMenu), keyEquivalent: "")
        openItem.target = self
        menu.addItem(openItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc
    /// 右键菜单“打开面板”的 selector 转发方法。
    private func openPanelFromMenu() {
        openPanel()
    }

    @objc
    /// 记录退出来源并请求 AppKit 正常结束；随后会触发 AppDelegate 清理回调。
    private func quit() {
        StatusBarLogger.info("quit requested from menu")
        NSApp.terminate(nil)
    }

    /// 面板打开时监听全局鼠标按下，在用户点击应用外部时回到主线程关闭面板。
    private func startEventMonitor() {
        // 守卫保证同一时刻最多存在一个全局监听器。
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            // 全局 monitor 的回调线程不保证是主线程，使用 MainActor Task 安全操作窗口。
            Task { @MainActor in
                self?.closePanel()
            }
        }
    }

    /// 注销全局鼠标监听器并清空句柄，允许下次打开面板时重新注册。
    private func stopEventMonitor() {
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
            self.eventMonitor = nil
        }
    }
}
