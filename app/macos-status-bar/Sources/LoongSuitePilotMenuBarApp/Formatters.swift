import Foundation

// 本文件提供菜单栏视图共用的纯格式化函数，不读写文件，也不持有状态。
// `PilotMetricsSnapshot` 和各占比条目调用它，把 Collector 产生的原始数字转换为紧凑展示文本。

/// 无实例状态的格式化工具命名空间。
enum Formatters {
    /// 将整数缩写为适合窄菜单栏的文本，例如 `1_500 -> "1.5K"`。
    /// - Parameter value: 要展示的计数，通常是 token 数；小于一千时使用当前区域的千分位规则。
    /// - Returns: 百万级使用 `M`、千级使用 `K`，其余返回十进制字符串。
    static func compactNumber(_ value: Int) -> String {
        // 先判断百万级，避免大数先匹配到下面的千级分支。
        if value >= 1_000_000 {
            let millions = Double(value) / 1_000_000.0
            return String(format: "%.1fM", millions)
        }
        if value >= 1_000 {
            let thousands = Double(value) / 1_000.0
            return String(format: "%.1fK", thousands)
        }
        // NumberFormatter 会按系统区域添加千分位；极少数格式化失败场景回退到字符串插值。
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    /// 将 0 到 1 附近的比例转换为四舍五入后的百分数字符串。
    /// - Parameter value: 小数比例；调用方负责在必要时先限制到合法范围。
    /// - Returns: 例如 `0.126 -> "13%"`。
    static func percent(_ value: Double) -> String {
        "\(Int(round(value * 100)))%"
    }
}
