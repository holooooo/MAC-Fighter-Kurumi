// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "JiuliuPet",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "JiuliuPet", targets: ["JiuliuPet"])],
    targets: [.executableTarget(name: "JiuliuPet", path: "Sources/JiuliuPet")],
    swiftLanguageModes: [.v5]
)
