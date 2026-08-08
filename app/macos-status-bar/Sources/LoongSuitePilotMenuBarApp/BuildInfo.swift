// 本文件保存打包时展示给用户的菜单栏应用版本信息。
// 版本号用于界面兜底显示；Collector 实际版本优先从 `logs/runtime.json` 动态读取。
// 这些常量通常由发布流程维护，运行时不会修改。

/// 集中提供编译期版本元数据，避免视图和状态存储各自硬编码。
enum BuildInfo {
    /// 菜单栏应用自身版本，不一定与当前由 `current` 指针选中的 Collector 完全相同。
    static let version = "1.1.3"
    /// 构建时间，便于定位安装包来源；当前界面尚未直接展示该字段。
    static let buildTimestamp = "2026-06-09T00:00:00.000Z"
}
