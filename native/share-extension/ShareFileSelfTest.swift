import Foundation

@main
struct ReaderShareFileSelfTest {
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory
            .appendingPathComponent("reader-share-file-\(UUID().uuidString)", isDirectory: true)
        defer { try? manager.removeItem(at: root) }
        try manager.createDirectory(at: root, withIntermediateDirectories: true)

        let source = root.appendingPathComponent("source-note.md")
        let bytes = Data("# Reader 分享文件\n\n确认后才进入资料库。".utf8)
        try bytes.write(to: source)
        let staging = root.appendingPathComponent("staging", isDirectory: true)
        let createdAt = Date(timeIntervalSince1970: 1_700_000_000)
        let manifest = try ReaderShareFile.stage(
            sourceURL: source,
            suggestedName: "../Reader:摘录.md",
            typeIdentifier: "net.daringfireball.markdown",
            in: staging,
            now: createdAt
        )

        expect(ReaderShareURL.normalizeFileToken(manifest.token) == manifest.token, "token 必须是规范 UUID v4")
        expect(manifest.fileName == "Reader-摘录.md", "文件名必须安全且保留受控扩展名")
        expect(manifest.mimeType == "text/markdown", "MIME 必须来自受控映射")
        expect(manifest.byteSize == bytes.count, "文件大小必须精确")
        expect(manifest.sha256.count == 64, "必须记录 SHA-256")
        let payload = staging.appendingPathComponent("\(manifest.token).payload")
        let descriptor = staging.appendingPathComponent("\(manifest.token).json")
        expect((try? Data(contentsOf: payload)) == bytes, "暂存内容必须无损")
        let decoded = try JSONDecoder().decode(ReaderSharedFileManifest.self, from: Data(contentsOf: descriptor))
        expect(decoded.token == manifest.token && decoded.sha256 == manifest.sha256, "描述文件必须绑定 token 与摘要")
        expect(posixMode(staging) == 0o700, "暂存目录权限必须是 0700")
        expect(posixMode(payload) == 0o600 && posixMode(descriptor) == 0o600, "暂存文件权限必须是 0600")

        let deepLink = require(ReaderShareURL.deepLink(forFileToken: manifest.token), "必须创建文件深链")
        let components = require(URLComponents(url: deepLink, resolvingAgainstBaseURL: false), "文件深链必须可解析")
        expect(
            components.queryItems == [URLQueryItem(name: "file", value: manifest.token)],
            "文件深链只能携带随机 token"
        )
        expect(!deepLink.absoluteString.contains(source.path), "文件深链不能包含真实路径")
        expect(ReaderShareURL.normalizeFileToken(manifest.token.uppercased()) == nil, "必须拒绝非规范 token")

        let unsupported = root.appendingPathComponent("payload.app")
        try Data("unsafe".utf8).write(to: unsupported)
        expectThrows("必须拒绝不支持的文件类型") {
            _ = try ReaderShareFile.stage(
                sourceURL: unsupported,
                suggestedName: "payload.app",
                typeIdentifier: "com.apple.application-bundle",
                in: staging
            )
        }

        let targetRoot = root.appendingPathComponent("target-root", isDirectory: true)
        let linkedRoot = root.appendingPathComponent("linked-root", isDirectory: true)
        try manager.createDirectory(at: targetRoot, withIntermediateDirectories: true)
        try manager.createSymbolicLink(at: linkedRoot, withDestinationURL: targetRoot)
        expectThrows("必须拒绝符号链接暂存目录") {
            _ = try ReaderShareFile.stage(
                sourceURL: source,
                suggestedName: "Reader.md",
                typeIdentifier: "net.daringfireball.markdown",
                in: linkedRoot
            )
        }

        let oldDate = createdAt.addingTimeInterval(-(ReaderShareFile.timeToLive + 1))
        try manager.setAttributes([.modificationDate: oldDate], ofItemAtPath: payload.path)
        try manager.setAttributes([.modificationDate: oldDate], ofItemAtPath: descriptor.path)
        ReaderShareFile.cleanupExpired(in: staging, now: createdAt)
        expect(!manager.fileExists(atPath: payload.path) && !manager.fileExists(atPath: descriptor.path), "过期暂存必须成对删除")
    }

    private static func posixMode(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions]) as? NSNumber)?.intValue ?? -1
    }

    private static func expectThrows(_ message: String, _ operation: () throws -> Void) {
        do {
            try operation()
            expect(false, message)
        } catch {
            // Expected.
        }
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            FileHandle.standardError.write(Data("\(message)\n".utf8))
            exit(1)
        }
    }

    private static func require<T>(_ value: T?, _ message: String) -> T {
        expect(value != nil, message)
        return value!
    }
}
