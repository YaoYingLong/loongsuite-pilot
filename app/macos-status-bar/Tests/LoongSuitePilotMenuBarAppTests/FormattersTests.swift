import XCTest
@testable import LoongSuitePilotMenuBarApp

// 本文件验证菜单栏数字格式化的边界。`@testable import` 允许测试访问未声明为 public 的内部实现，
// 测试不读写 Collector 文件，也不启动 AppKit 事件循环。

/// 覆盖百万、千、小数和百分比四舍五入规则的 XCTest 用例集合。
final class FormattersTests: XCTestCase {

    // MARK: - 紧凑数字

    func testCompactNumber_millions() {
        XCTAssertEqual(Formatters.compactNumber(48_534_323), "48.5M")
        XCTAssertEqual(Formatters.compactNumber(1_000_000), "1.0M")
        XCTAssertEqual(Formatters.compactNumber(1_500_000), "1.5M")
        XCTAssertEqual(Formatters.compactNumber(123_456_789), "123.5M")
    }

    func testCompactNumber_thousands() {
        XCTAssertEqual(Formatters.compactNumber(1_000), "1.0K")
        XCTAssertEqual(Formatters.compactNumber(1_500), "1.5K")
        XCTAssertEqual(Formatters.compactNumber(999_999), "1000.0K")
        XCTAssertEqual(Formatters.compactNumber(523_400), "523.4K")
    }

    func testCompactNumber_small() {
        XCTAssertEqual(Formatters.compactNumber(0), "0")
        XCTAssertEqual(Formatters.compactNumber(1), "1")
        XCTAssertEqual(Formatters.compactNumber(999), "999")
    }

    // MARK: - 百分比

    func testPercent_basic() {
        XCTAssertEqual(Formatters.percent(0.0), "0%")
        XCTAssertEqual(Formatters.percent(1.0), "100%")
        XCTAssertEqual(Formatters.percent(0.73), "73%")
        XCTAssertEqual(Formatters.percent(0.5), "50%")
    }

    func testPercent_rounding() {
        XCTAssertEqual(Formatters.percent(0.976), "98%")
        XCTAssertEqual(Formatters.percent(0.004), "0%")
        XCTAssertEqual(Formatters.percent(0.005), "1%")
    }
}
