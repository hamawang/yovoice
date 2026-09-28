import AppKit
import ImageIO

// 在仓库根目录运行：swift scripts/desktop/build-macos-icon.swift。
// 保留原图像素内容；传统 macOS 图标需要把透明留白写进资源。
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
let sourceURL = root.appendingPathComponent("web/public/icon/voice-workbench-app-icon-v1.png")
let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
let iconset = temporary.appendingPathComponent("AppIcon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }

// 原图底板约占画布的 97.6%；缩到 844 后，实色底板约为 824/1024。
// 各分辨率直接从同一原图采样，避免反复缩放导致小图标模糊。
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = points * scale
        let context = CGContext(
            data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
            bytesPerRow: pixels * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let inset = CGFloat(pixels) * 90 / 1024
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(
            x: inset, y: inset, width: CGFloat(pixels) - inset * 2,
            height: CGFloat(pixels) - inset * 2))
        let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
        // 最外圈必须透明，防止下次更新素材时再次铺满画布。
        for coordinate in 0..<pixels {
            for (x, y) in [(coordinate, 0), (coordinate, pixels - 1),
                           (0, coordinate), (pixels - 1, coordinate)] {
                precondition(bitmap.colorAt(x: x, y: y)!.alphaComponent == 0)
            }
        }
        let suffix = scale == 2 ? "@2x" : ""
        let file = iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
        try bitmap.representation(using: .png, properties: [:])!.write(to: file)
    }
}

let output = temporary.appendingPathComponent("AppIcon.icns")
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", output.path]
try process.run()
process.waitUntilExit()
precondition(process.terminationStatus == 0, "图标打包失败")
try Data(contentsOf: output).write(
    to: root.appendingPathComponent("desktop/macos/Resources/AppIcon.icns"), options: .atomic)
print("已生成带透明留白的 macOS 图标。")
