// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MyPath",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "MyPathApp",
            path: "Sources/MyPathApp"
        )
    ]
)
