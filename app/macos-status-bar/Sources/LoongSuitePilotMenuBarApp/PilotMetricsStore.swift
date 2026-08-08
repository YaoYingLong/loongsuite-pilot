import Foundation
import SwiftUI

// 本文件是菜单栏指标的数据层：后台读取 Collector 写入的 `logs/metrics-summary.json`，
// 将宽松 JSON 结构转换为 SwiftUI 使用的强类型快照，并按今日、7 天、30 天切换聚合范围。
// 文件 I/O 在 utility 队列执行，最终状态更新切回主线程；每 60 秒自动刷新一次。

// MARK: - 聚合范围

/// 用户可选择的统计时间范围，同时集中定义界面标题和趋势图取数范围。
enum MetricsAggregationRange: String, CaseIterable, Identifiable {
    case today
    case sevenDays
    case thirtyDays

    var id: String { rawValue }

    var pickerTitle: String {
        switch self {
        case .today: return "今日"
        case .sevenDays: return "7天"
        case .thirtyDays: return "30天"
        }
    }

    var displayTitle: String {
        switch self {
        case .today: return "今日"
        case .sevenDays: return "近 7 日"
        case .thirtyDays: return "近 30 日"
        }
    }

    var heroLabel: String {
        switch self {
        case .today: return "TODAY"
        case .sevenDays: return "7 DAYS"
        case .thirtyDays: return "30 DAYS"
        }
    }

    var tokenTrendTitle: String {
        switch self {
        case .today, .sevenDays: return "TOKEN TREND · 7D"
        case .thirtyDays: return "TOKEN TREND · 30D"
        }
    }

    var sessionTrendTitle: String {
        switch self {
        case .today, .sevenDays: return "SESSION TREND · 7D"
        case .thirtyDays: return "SESSION TREND · 30D"
        }
    }

    var trendRange: MetricsAggregationRange {
        self == .thirtyDays ? .thirtyDays : .sevenDays
    }
}

// MARK: - 视图数据类型

/// 单日趋势点，日期时间戳作为 SwiftUI/Charts 的稳定标识。
struct DailyMetricPoint: Identifiable {
    let day: Date
    let value: Int
    var id: TimeInterval { day.timeIntervalSince1970 }
}

/// 单个 Agent 的事件、token、会话与占比汇总。
struct AgentStatusItem: Identifiable {
    let agentType: String
    let events: Int
    let tokens: Int
    let sessions: Int
    let share: Double
    var id: String { agentType }
    var formattedTokens: String { Formatters.compactNumber(tokens) }
}

/// 将上游比例限制在有限的 0...1 范围，避免 NaN/无穷值传入 SwiftUI frame 导致崩溃。
/// - Parameter raw: Collector 摘要中的原始比例。
private func clampedShare(_ raw: Double) -> Double {
    if raw.isNaN || raw.isInfinite { return 0 }
    return min(max(raw, 0), 1)
}

/// Provider 维度的 token 统计；初始化时会规范化占比。
struct ProviderShareItem: Identifiable {
    let provider: String
    let tokens: Int
    let share: Double
    var id: String { provider }
    var formattedTokens: String { Formatters.compactNumber(tokens) }
    var formattedShare: String { Formatters.percent(share) }

    init(provider: String, tokens: Int, share: Double) {
        self.provider = provider
        self.tokens = tokens
        self.share = clampedShare(share)
    }
}

/// 模型维度的 token 统计；初始化时会规范化占比。
struct ModelShareItem: Identifiable {
    let model: String
    let tokens: Int
    let share: Double
    var id: String { model }
    var formattedTokens: String { Formatters.compactNumber(tokens) }
    var formattedShare: String { Formatters.percent(share) }

    init(model: String, tokens: Int, share: Double) {
        self.model = model
        self.tokens = tokens
        self.share = clampedShare(share)
    }
}

/// 仓库维度的会话和事件计数。
struct RepoShareItem: Identifiable {
    let repo: String
    let sessions: Int
    let events: Int
    var id: String { repo }
}

// MARK: - 对外快照

/// 面板一次渲染所需的完整指标集合；缺失数据统一使用零值或空数组。
struct PilotMetricsSnapshot {
    var aggregationRange: MetricsAggregationRange
    var totalTokens: Int
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var totalEvents: Int
    var totalSessions: Int
    var totalRequests: Int
    var totalToolCalls: Int
    var dailyTokenUsage: [DailyMetricPoint]
    var dailySessionCounts: [DailyMetricPoint]
    var agentStats: [AgentStatusItem]
    var providerShares: [ProviderShareItem]
    var modelShares: [ModelShareItem]
    var repoShares: [RepoShareItem]
    var errorMessage: String?

    /// 创建指定时间范围的零值快照，用于首次启动、文件缺失和切换范围时占位。
    /// - Parameter range: 快照所属的聚合范围，默认今日。
    static func makeEmpty(range: MetricsAggregationRange = .today) -> PilotMetricsSnapshot {
        PilotMetricsSnapshot(
            aggregationRange: range,
            totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
            totalEvents: 0, totalSessions: 0, totalRequests: 0, totalToolCalls: 0,
            dailyTokenUsage: [], dailySessionCounts: [],
            agentStats: [], providerShares: [], modelShares: [], repoShares: [],
            errorMessage: nil
        )
    }

    static let empty = PilotMetricsSnapshot.makeEmpty()

    var formattedTotalTokens: String { Formatters.compactNumber(totalTokens) }
    var formattedInputTokens: String { Formatters.compactNumber(inputTokens) }
    var formattedOutputTokens: String { Formatters.compactNumber(outputTokens) }

    var formattedCacheReadShare: String {
        guard inputTokens > 0 else { return "0%" }
        return Formatters.percent(Double(cacheReadTokens) / Double(inputTokens))
    }

    var menuBarTitle: String { formattedTotalTokens }
}

// MARK: - JSON 解码结构

// 以下 private 类型刻意把字段声明为可选：Collector 可独立升级，旧摘要可能缺少新字段，
// 解码层容忍缺失后再由 `buildSnapshot` 统一填入默认值。

private struct SummaryFile: Decodable {
    let version: Int?
    let ranges: RangesFile?
    let dailyTokens: [DailyPointFile]?
    let dailySessions: [DailyPointFile]?
}

private struct RangesFile: Decodable {
    let today: RangeDataFile?
    let sevenDays: RangeDataFile?
    let thirtyDays: RangeDataFile?
}

private struct RangeDataFile: Decodable {
    let totalTokens: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheCreationTokens: Int?
    let totalSessions: Int?
    let totalRequests: Int?
    let totalToolCalls: Int?
    let totalEvents: Int?
    let agentShares: [AgentShareFile]?
    let providerShares: [ProviderShareFile]?
    let modelShares: [ModelShareFile]?
    let repoShares: [RepoShareFile]?
}

private struct AgentShareFile: Decodable {
    let agentType: String?
    let sessions: Int?
    let events: Int?
    let tokens: Int?
    let share: Double?
}

private struct ProviderShareFile: Decodable {
    let provider: String?
    let totalTokens: Int?
    let share: Double?
}

private struct ModelShareFile: Decodable {
    let model: String?
    let totalTokens: Int?
    let share: Double?
}

private struct RepoShareFile: Decodable {
    let repo: String?
    let sessions: Int?
    let events: Int?
}

private struct DailyPointFile: Decodable {
    let day: String?
    let value: Int?
}

// MARK: - 状态存储

@MainActor
/// 负责指标文件轮询、后台解码、范围选择以及向 SwiftUI 发布快照。
/// `StatusBarController` 在构造时调用 `start()`，退出时调用 `stop()`。
final class PilotMetricsStore: ObservableObject {
    /// 当前展示快照和范围只允许 Store 内部修改，视图通过 Combine 自动重绘。
    @Published private(set) var snapshot = PilotMetricsSnapshot.empty
    @Published private(set) var selectedRange: MetricsAggregationRange = .today

    private var timer: Timer?
    /// 保存最近一次成功解码结果，使切换时间范围无需再次读取磁盘。
    private var cachedSummary: SummaryFile?
    private let summaryPath: String = {
        if let dataDir = ProcessInfo.processInfo.environment["LOONGSUITE_PILOT_DATA_DIR"], !dataDir.isEmpty {
            return (dataDir as NSString).appendingPathComponent("logs/metrics-summary.json")
        }
        return NSString(string: "~/.loongsuite-pilot/logs/metrics-summary.json").expandingTildeInPath
    }()

    private let refreshQueue = DispatchQueue(label: "com.loongsuite-pilot.status-bar.metrics-refresh", qos: .utility)

    // DateFormatter 缓存为静态值，统一按 `yyyy-MM-dd` 解析 Collector 的每日数据点。
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// 立即刷新一次并建立 60 秒重复定时器；重复调用会先取消旧定时器。
    /// Timer 依附主线程 RunLoop，回调通过 MainActor Task 访问本 Store。
    func start() {
        StatusBarLogger.info("metrics store started")
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    /// 取消轮询并释放 Timer；不会删除已缓存快照或任何磁盘文件。
    func stop() {
        StatusBarLogger.info("metrics store stopped")
        timer?.invalidate()
        timer = nil
    }

    /// 在 utility 队列读取/解码文件，再切回主线程发布，避免大摘要阻塞菜单交互。
    /// 文件错误不会抛给调用方，`buildSnapshot` 会生成带提示的空快照。
    func refresh() {
        let path = self.summaryPath
        refreshQueue.async { [weak self] in
            let file = Self.loadFile(path: path)
            // `@Published` 和缓存均属于 MainActor，必须回到主队列修改。
            DispatchQueue.main.async {
                guard let self else { return }
                self.cachedSummary = file
                self.snapshot = Self.buildSnapshot(from: file, range: self.selectedRange)
            }
        }
    }

    /// 切换聚合范围并用缓存立即重建快照，不发起额外文件 I/O。
    /// - Parameter range: 用户在分段选择器中点击的新范围。
    func selectRange(_ range: MetricsAggregationRange) {
        guard selectedRange != range else { return }
        selectedRange = range
        if let file = cachedSummary {
            snapshot = Self.buildSnapshot(from: file, range: range)
        } else {
            snapshot = PilotMetricsSnapshot.makeEmpty(range: range)
        }
    }

    /// 从指定路径同步读取并解码摘要。标记 `nonisolated` 使后台队列无需切换 MainActor。
    /// - Returns: 成功时返回宽松 JSON 模型，任何文件/解码错误均返回 `nil`。
    private nonisolated static func loadFile(path: String) -> SummaryFile? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(SummaryFile.self, from: data)
    }

    /// 将指定范围的可选 JSON 字段归一化为视图可直接消费的完整快照。
    /// - Returns: 缺失字段以零值补齐；整个文件缺失时带有用户可见错误信息。
    private static func buildSnapshot(from file: SummaryFile?, range: MetricsAggregationRange) -> PilotMetricsSnapshot {
        guard let file else {
            var empty = PilotMetricsSnapshot.makeEmpty(range: range)
            empty.errorMessage = "未发现 metrics-summary.json，请先启动 loongsuite-pilot 守护进程。"
            return empty
        }

        let rangeData: RangeDataFile?
        switch range {
        case .today: rangeData = file.ranges?.today
        case .sevenDays: rangeData = file.ranges?.sevenDays
        case .thirtyDays: rangeData = file.ranges?.thirtyDays
        }

        let rd = rangeData

        // “今日”仍展示 7 日趋势；只有 30 日范围扩展为 30 个点。
        let trendDayCount = range.trendRange == .thirtyDays ? 30 : 7
        let dailyTokens = parseDailyPoints(file.dailyTokens, lastN: trendDayCount)
        let dailySessions = parseDailyPoints(file.dailySessions, lastN: trendDayCount)

        let agentStats = (rd?.agentShares ?? []).map { item in
            AgentStatusItem(
                agentType: item.agentType ?? "unknown",
                events: item.events ?? 0,
                tokens: item.tokens ?? 0,
                sessions: item.sessions ?? 0,
                share: item.share ?? 0
            )
        }

        let providerShares = (rd?.providerShares ?? []).map { item in
            ProviderShareItem(
                provider: item.provider ?? "unknown",
                tokens: item.totalTokens ?? 0,
                share: item.share ?? 0
            )
        }

        let modelShares = (rd?.modelShares ?? []).map { item in
            ModelShareItem(
                model: item.model ?? "unknown",
                tokens: item.totalTokens ?? 0,
                share: item.share ?? 0
            )
        }

        let repoShares = (rd?.repoShares ?? []).map { item in
            RepoShareItem(
                repo: item.repo ?? "unknown",
                sessions: item.sessions ?? 0,
                events: item.events ?? 0
            )
        }

        return PilotMetricsSnapshot(
            aggregationRange: range,
            totalTokens: rd?.totalTokens ?? 0,
            inputTokens: rd?.inputTokens ?? 0,
            outputTokens: rd?.outputTokens ?? 0,
            cacheReadTokens: rd?.cacheReadTokens ?? 0,
            totalEvents: rd?.totalEvents ?? 0,
            totalSessions: rd?.totalSessions ?? 0,
            totalRequests: rd?.totalRequests ?? 0,
            totalToolCalls: rd?.totalToolCalls ?? 0,
            dailyTokenUsage: dailyTokens,
            dailySessionCounts: dailySessions,
            agentStats: agentStats,
            providerShares: providerShares,
            modelShares: modelShares,
            repoShares: repoShares,
            errorMessage: nil
        )
    }

    /// 解析每日日期并丢弃无效项，必要时只保留尾部最近 N 天。
    /// - Parameters:
    ///   - points: JSON 中可选的每日点数组。
    ///   - lastN: 最大返回数量；为 `nil` 时保留全部有效点。
    private static func parseDailyPoints(_ points: [DailyPointFile]?, lastN: Int?) -> [DailyMetricPoint] {
        guard let points else { return [] }
        let parsed = points.compactMap { item -> DailyMetricPoint? in
            guard let dayStr = item.day,
                  let date = dayFormatter.date(from: dayStr) else { return nil }
            return DailyMetricPoint(day: date, value: item.value ?? 0)
        }
        if let lastN, parsed.count > lastN {
            return Array(parsed.suffix(lastN))
        }
        return parsed
    }
}
