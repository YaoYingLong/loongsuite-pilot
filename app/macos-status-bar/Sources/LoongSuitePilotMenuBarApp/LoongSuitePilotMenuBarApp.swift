import AppKit

// 本文件是菜单栏可执行程序的唯一进程入口。
// 它手工启动 AppKit 事件循环，而不是使用常规 SwiftUI `App` 场景，便于精确控制非激活浮动面板。

@main
/// Swift 的 `@main` 要求编译器从 `main()` 开始执行本类型。
enum LoongSuitePilotMenuBarApp {
    // 静态强引用保证委托的生命周期覆盖整个 `NSApplication.run()` 事件循环。
    private static let appDelegate = AppDelegate()

    /// 创建共享 AppKit 应用、注册生命周期委托并进入阻塞式事件循环。
    /// `run()` 会一直处理鼠标、菜单和系统通知，直到 `NSApp.terminate(nil)` 请求退出。
    static func main() {
        let app = NSApplication.shared
        app.delegate = appDelegate
        app.run()
    }
}
