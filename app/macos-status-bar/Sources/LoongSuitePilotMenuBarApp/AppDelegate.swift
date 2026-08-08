import AppKit

// 本文件连接 `NSApplication` 生命周期与状态栏控制器。
// `LoongSuitePilotMenuBarApp.main()` 创建应用并把事件委托交给本类；启动完成后创建全部 UI/定时器，
// 应用退出前则集中取消订阅、定时器和全局鼠标监听，防止后台资源继续存活。

/// macOS 应用生命周期委托。
///
/// `NSObject` 让实例可参与 Objective-C 运行时，`NSApplicationDelegate` 提供启动和退出回调。
/// 该对象在整个进程内只有一个，由入口类型的静态属性强引用。
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// 持有控制器直到应用退出；若不强引用，初始化后控制器会立即释放。
    private var statusBarController: StatusBarController?

    /// AppKit 完成初始化后调用。这里切换为不显示 Dock 图标的 accessory 应用并建立菜单栏 UI。
    /// - Parameter notification: AppKit 发送的启动通知；当前逻辑不读取其内容。
    func applicationDidFinishLaunching(_ notification: Notification) {
        StatusBarLogger.info("application did finish launching")
        // `.accessory` 适合仅存在于菜单栏的程序：应用仍可显示窗口，但不会占用 Dock 位置。
        NSApp.setActivationPolicy(.accessory)
        // 初始化控制器会同步创建状态项和面板，并启动两个定时刷新任务。
        statusBarController = StatusBarController()
        StatusBarLogger.info("status bar controller initialized")
    }

    /// AppKit 即将结束事件循环时调用，让控制器主动释放计时器和事件监听器。
    /// - Parameter notification: 退出通知；当前逻辑不读取其内容。
    func applicationWillTerminate(_ notification: Notification) {
        StatusBarLogger.info("application will terminate")
        statusBarController?.teardown()
    }
}
