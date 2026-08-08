import Foundation

// 本文件为菜单栏独立进程提供轻量文件日志。
// 日志写入 `<dataDir>/logs/app-status-bar/`，与 Collector 主日志分离；多个调用线程统一进入串行队列，
// 避免同时追加时内容交错。写入失败只输出到 stderr，不让日志故障导致 UI 退出。

/// 菜单栏应用的进程级日志工具；所有 API 都是静态方法，无需创建实例。
enum StatusBarLogger {
    /// 输出到日志行中的稳定级别文本。
    enum Level: String {
        case info = "INFO"
        case warning = "WARNING"
        case error = "ERROR"
    }

    // 串行队列让所有文件创建、定位末尾和写入操作按顺序执行。
    private static let queue = DispatchQueue(label: "com.loongsuite-pilot.status-bar.logger")

    // 闭包在类型首次使用时只执行一次，缓存 formatter 可避免每条日志重复构造昂贵对象。
    private static let timestampFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "Asia/Shanghai") ?? .current
        return f
    }()

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Shanghai") ?? .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// 异步写入普通运行信息；方法返回时磁盘写入可能尚未完成。
    static func info(_ message: String) {
        write(level: .info, message: message)
    }

    /// 异步写入可恢复问题。
    static func warning(_ message: String) {
        write(level: .warning, message: message)
    }

    /// 异步写入错误信息。
    static func error(_ message: String) {
        write(level: .error, message: message)
    }

    /// 在串行后台队列中按日期追加日志文件。
    /// - Parameters:
    ///   - level: 日志级别。
    ///   - message: 已由调用方组织好的可读文本。
    /// - 副作用：创建日志目录/文件并追加 UTF-8 数据；失败时写标准错误。
    private static func write(level: Level, message: String) {
        queue.async {
            let now = Date()
            let timestamp = timestampFormatter.string(from: now)
            let line = "[\(timestamp)] [PILOT:\(level.rawValue)] [status-bar-app] \(message)\n"

            // 与 Collector 一样优先尊重自定义数据目录，否则展开当前用户主目录中的默认路径。
            let logDir: String = {
                if let dataDir = ProcessInfo.processInfo.environment["LOONGSUITE_PILOT_DATA_DIR"], !dataDir.isEmpty {
                    return (dataDir as NSString).appendingPathComponent("logs/app-status-bar")
                }
                return NSString(string: "~/.loongsuite-pilot/logs/app-status-bar").expandingTildeInPath
            }()
            let logFile = "\(logDir)/status-bar-app-\(dateFormatter.string(from: now)).log"

            do {
                // `withIntermediateDirectories` 等价于 `mkdir -p`，目录已存在时不会报错。
                try FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
                if !FileManager.default.fileExists(atPath: logFile) {
                    FileManager.default.createFile(atPath: logFile, contents: nil)
                }
                // FileHandle 默认从文件开头写，因此显式移动到末尾实现追加。
                let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: logFile))
                defer { handle.closeFile() }
                handle.seekToEndOfFile()
                if let data = line.data(using: .utf8) {
                    handle.write(data)
                }
            } catch {
                fputs("[PILOT:ERROR] logger write failed: \(error.localizedDescription)\n", stderr)
            }
        }
    }
}
