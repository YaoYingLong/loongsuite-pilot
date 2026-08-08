// swift-tools-version: 5.7

// 本文件是 macOS 菜单栏应用的 Swift Package Manager 清单。
// `scripts/build-status-bar-app.mjs` 会在 macOS 打包阶段执行 `swift build` 读取这里的配置，
// 生成一个最低支持 macOS 13 的可执行程序；测试 target 则通过 `swift test` 验证纯数据逻辑。
// 清单只描述构建目标和依赖，不参与 Collector 的 Node.js 运行时数据采集。

import PackageDescription

// `Package` 是 SwiftPM 的顶层声明：一个可执行 target 对应菜单栏程序，另一个 target 放单元测试。
let package = Package(
    name: "LoongSuitePilotMenuBarApp",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "LoongSuitePilotMenuBarApp",
            targets: ["LoongSuitePilotMenuBarApp"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "LoongSuitePilotMenuBarApp"
        ),
        .testTarget(
            name: "LoongSuitePilotMenuBarAppTests",
            dependencies: ["LoongSuitePilotMenuBarApp"]
        ),
    ]
)
