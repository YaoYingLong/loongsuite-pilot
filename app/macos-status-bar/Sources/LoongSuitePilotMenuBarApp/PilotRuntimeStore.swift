import Foundation
import AppKit
import Combine

// 本文件读取 Collector 周期性写入的 `logs/runtime.json`，为状态栏提供服务状态、版本和 PID 存活性。
// Store 每 30 秒轮询一次；短暂读取失败会容忍，连续五分钟不可达则结束菜单栏应用，避免留下孤立进程。
// 所有公开状态受 MainActor 保护，文件读取错误采用默认快照，不向 UI 抛出异常。

/// 一次不可变的运行状态视图模型；`Equatable` 便于 SwiftUI/测试比较状态变化。
struct PilotRuntimeSnapshot: Equatable {
    let statusText: String
    let isActive: Bool
    let isStatusBarAppEnabled: Bool
    let appVersionText: String
    let daemonVersionText: String
    let updatedAt: String?
}

/// 对应 `runtime.json` 的宽松解码结构。字段全部可选，以兼容旧 Collector 或写入中的文件。
/// 未使用的缺失字段不会让整个状态读取抛错。
private struct RuntimeFile: Decodable {
    let status: String?
    let packageVersion: String?
    let pid: Int?
    let updatedAt: String?
}

@MainActor
/// 发布 Collector 运行快照的可观察状态存储。
/// `StatusBarController` 创建并持有它；`start()` 建立定时器，`stop()` 负责释放。
final class PilotRuntimeStore: ObservableObject {
    /// `private(set)` 允许视图订阅读取，但禁止视图绕过 Store 修改状态。
    @Published private(set) var snapshot: PilotRuntimeSnapshot
    @Published private(set) var isReachable = false

    private var timer: Timer?
    /// 连续探测失败次数，用于区分瞬时文件竞争与真正的守护进程退出。
    private var consecutiveFailures = 0
    private let maxConsecutiveFailuresForStatus = 3
    private let maxConsecutiveFailuresForExit = 10  // 10 次 × 30 秒 = 5 分钟

    // 环境变量允许自定义数据目录；未设置时使用 Collector 的默认目录。
    private let runtimePath: String = {
        if let dataDir = ProcessInfo.processInfo.environment["LOONGSUITE_PILOT_DATA_DIR"], !dataDir.isEmpty {
            return (dataDir as NSString).appendingPathComponent("logs/runtime.json")
        }
        return NSString(string: "~/.loongsuite-pilot/logs/runtime.json").expandingTildeInPath
    }()

    /// 先发布“等待连接”快照，实际磁盘状态由随后 `start()` 的首次刷新替换。
    init() {
        self.snapshot = PilotRuntimeSnapshot(
            statusText: "等待连接",
            isActive: false,
            isStatusBarAppEnabled: true,
            appVersionText: "v\(BuildInfo.version)",
            daemonVersionText: "v--",
            updatedAt: nil
        )
    }

    /// 立即刷新一次，并在当前 RunLoop 上创建每 30 秒重复执行的 Timer。
    /// 重复调用会先使旧定时器失效，因此不会叠加轮询任务。
    func start() {
        StatusBarLogger.info("runtime store started")
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    /// 使轮询定时器失效并释放引用；由控制器退出清理调用。
    func stop() {
        StatusBarLogger.info("runtime store stopped")
        timer?.invalidate()
        timer = nil
    }

    /// 读取快照并用 `kill(pid, 0)` 探测进程是否仍存在，然后更新失败计数和公开状态。
    /// - Parameter forceReload: 兼容调用签名的预留参数；当前实现每次都会重新读取文件。
    /// - 副作用：可能更新两个 `@Published` 属性；长期失败时异步请求应用退出。
    func refresh(forceReload: Bool = false) {
        var next = loadSnapshot()
        // JSON 中的 active 只是最后一次写入状态，还需用 PID 探测排除陈旧文件。
        let alive = next.isActive && probeDaemonAlive(next)
        isReachable = alive

        if alive {
            consecutiveFailures = 0
        } else {
            consecutiveFailures += 1

            // 连续三次失败后才把 UI 标为停止，避免 Collector 原子替换文件时的瞬时读取失败造成闪烁。
            if consecutiveFailures >= maxConsecutiveFailuresForStatus {
                next = PilotRuntimeSnapshot(
                    statusText: "守护进程未运行",
                    isActive: false,
                    isStatusBarAppEnabled: next.isStatusBarAppEnabled,
                    appVersionText: next.appVersionText,
                    daemonVersionText: next.daemonVersionText,
                    updatedAt: next.updatedAt
                )
            }

            if consecutiveFailures >= maxConsecutiveFailuresForExit {
                StatusBarLogger.warning("daemon unreachable for 5 minutes, exiting status bar app")
                // 延迟一秒让异步日志有机会落盘，再由 AppKit 走正常清理流程。
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    NSApp.terminate(nil)
                }
            }
        }

        snapshot = next
    }

    /// 从磁盘读取并解码 `runtime.json`；文件不存在、正在替换或 JSON 无效时返回非活动默认值。
    /// - Returns: 可直接发布给 UI 的快照，不向调用者抛出文件或解码异常。
    private func loadSnapshot() -> PilotRuntimeSnapshot {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: runtimePath)),
              let file = try? JSONDecoder().decode(RuntimeFile.self, from: data) else {
            return PilotRuntimeSnapshot(
                statusText: "未发现运行中的服务",
                isActive: false,
                isStatusBarAppEnabled: true,
                appVersionText: "v\(BuildInfo.version)",
                daemonVersionText: "v--",
                updatedAt: nil
            )
        }

        let active = file.status == "active"
        let version = file.packageVersion?.trimmingCharacters(in: .whitespacesAndNewlines)
        let daemonVersion = (version?.isEmpty == false) ? "v\(version!)" : "v--"
        let displayVersion = (version?.isEmpty == false) ? "v\(version!)" : "v\(BuildInfo.version)"

        return PilotRuntimeSnapshot(
            statusText: active ? "服务运行中" : "服务状态未知",
            isActive: active,
            isStatusBarAppEnabled: true,
            appVersionText: displayVersion,
            daemonVersionText: daemonVersion,
            updatedAt: file.updatedAt
        )
    }

    /// 使用 POSIX `kill(pid, 0)` 只检查进程存在性，不发送终止信号。
    /// - Parameter snapshot: 已解码状态；只有其中 `isActive` 为真才继续读取 PID。
    /// - Returns: PID 为正数且内核确认进程存在/可访问时为 `true`。
    private func probeDaemonAlive(_ snapshot: PilotRuntimeSnapshot) -> Bool {
        guard snapshot.isActive else { return false }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: runtimePath)),
              let file = try? JSONDecoder().decode(RuntimeFile.self, from: data),
              let pid = file.pid, pid > 0 else {
            return false
        }

        return kill(Int32(pid), 0) == 0
    }
}
