import CryptoKit
import Foundation

struct ReaderSharedFileManifest: Codable {
    let version: Int
    let token: String
    let fileName: String
    let mimeType: String
    let byteSize: Int
    let sha256: String
    let createdAt: String
}

enum ReaderShareFile {
    static let maximumBytes = 100 * 1024 * 1024
    static let maximumNameLength = 180
    static let timeToLive: TimeInterval = 24 * 60 * 60

    struct FileType {
        let identifier: String
        let mimeType: String
        let fileExtension: String
    }

    static let supportedTypes = [
        FileType(identifier: "com.adobe.pdf", mimeType: "application/pdf", fileExtension: "pdf"),
        FileType(identifier: "public.png", mimeType: "image/png", fileExtension: "png"),
        FileType(identifier: "public.jpeg", mimeType: "image/jpeg", fileExtension: "jpg"),
        FileType(identifier: "com.compuserve.gif", mimeType: "image/gif", fileExtension: "gif"),
        FileType(identifier: "org.webmproject.webp", mimeType: "image/webp", fileExtension: "webp"),
        FileType(identifier: "public.heic", mimeType: "image/heic", fileExtension: "heic"),
        FileType(identifier: "public.mpeg-4", mimeType: "video/mp4", fileExtension: "mp4"),
        FileType(identifier: "com.apple.quicktime-movie", mimeType: "video/quicktime", fileExtension: "mov"),
        FileType(identifier: "com.apple.m4v-video", mimeType: "video/x-m4v", fileExtension: "m4v"),
        FileType(identifier: "org.webmproject.webm", mimeType: "video/webm", fileExtension: "webm"),
        FileType(identifier: "public.mp3", mimeType: "audio/mpeg", fileExtension: "mp3"),
        FileType(identifier: "public.mpeg-4-audio", mimeType: "audio/mp4", fileExtension: "m4a"),
        FileType(identifier: "public.aac-audio", mimeType: "audio/aac", fileExtension: "aac"),
        FileType(identifier: "com.microsoft.waveform-audio", mimeType: "audio/wav", fileExtension: "wav"),
        FileType(identifier: "net.daringfireball.markdown", mimeType: "text/markdown", fileExtension: "md"),
        FileType(identifier: "public.plain-text", mimeType: "text/plain", fileExtension: "txt")
    ]

    static var stagingRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ReaderShareStaging", isDirectory: true)
    }

    static func preferredTypeIdentifier(for provider: NSItemProvider) -> String? {
        let hasFileURL = provider.hasItemConformingToTypeIdentifier("public.file-url")
        return supportedTypes.first(where: { type in
            provider.hasItemConformingToTypeIdentifier(type.identifier)
                && (hasFileURL || type.mimeType != "text/plain")
        })?.identifier
    }

    static func stage(
        sourceURL: URL,
        suggestedName: String?,
        typeIdentifier: String,
        in root: URL = stagingRoot,
        now: Date = Date()
    ) throws -> ReaderSharedFileManifest {
        guard sourceURL.isFileURL,
              let fileType = supportedTypes.first(where: { $0.identifier == typeIdentifier }) else {
            throw shareError("不支持的文件类型")
        }
        let values = try sourceURL.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey,
            .fileSizeKey
        ])
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let byteSize = values.fileSize,
              byteSize > 0,
              byteSize <= maximumBytes else {
            throw shareError("文件必须是 100 MB 以内的普通文件")
        }

        try prepare(root: root)
        cleanupExpired(in: root, now: now)
        let token = UUID().uuidString.lowercased()
        let payloadURL = root.appendingPathComponent("\(token).payload", isDirectory: false)
        let manifestURL = root.appendingPathComponent("\(token).json", isDirectory: false)
        let fileName = normalizedName(
            suggestedName ?? sourceURL.lastPathComponent,
            requiredExtension: fileType.fileExtension
        )
        do {
            try FileManager.default.copyItem(at: sourceURL, to: payloadURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: payloadURL.path)
            let copiedSize = try payloadURL.resourceValues(forKeys: [.fileSizeKey]).fileSize
            guard copiedSize == byteSize else { throw shareError("文件在暂存期间发生变化") }
            let manifest = ReaderSharedFileManifest(
                version: 1,
                token: token,
                fileName: fileName,
                mimeType: fileType.mimeType,
                byteSize: byteSize,
                sha256: try sha256(of: payloadURL),
                createdAt: ISO8601DateFormatter().string(from: now)
            )
            let encoded = try JSONEncoder().encode(manifest)
            try encoded.write(to: manifestURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifestURL.path)
            return manifest
        } catch {
            try? FileManager.default.removeItem(at: payloadURL)
            try? FileManager.default.removeItem(at: manifestURL)
            throw error
        }
    }

    static func discard(token: String, in root: URL = stagingRoot) {
        guard ReaderShareURL.normalizeFileToken(token) != nil else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent("\(token).payload"))
        try? FileManager.default.removeItem(at: root.appendingPathComponent("\(token).json"))
    }

    static func cleanupExpired(in root: URL = stagingRoot, now: Date = Date()) {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        var staleTokens = Set<String>()
        for entry in entries {
            let token = entry.deletingPathExtension().lastPathComponent
            guard ReaderShareURL.normalizeFileToken(token) != nil,
                  entry.pathExtension == "json" || entry.pathExtension == "payload",
                  let modified = try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                  now.timeIntervalSince(modified) >= timeToLive else { continue }
            staleTokens.insert(token)
        }
        for token in staleTokens { discard(token: token, in: root) }
    }

    private static func prepare(root: URL) throws {
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw shareError("分享文件暂存目录无效")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    }

    private static func normalizedName(_ candidate: String, requiredExtension: String) -> String {
        let lastComponent = URL(fileURLWithPath: candidate).lastPathComponent
        let cleaned = String(lastComponent.unicodeScalars.map { scalar in
            CharacterSet.controlCharacters.contains(scalar) || "/\\:".unicodeScalars.contains(scalar)
                ? "-"
                : Character(scalar)
        })
        let collapsed = cleaned.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        var stem = URL(fileURLWithPath: collapsed.isEmpty ? "attachment" : collapsed)
            .deletingPathExtension()
            .lastPathComponent
        let suffix = ".\(requiredExtension)"
        stem = String(stem.prefix(maximumNameLength - suffix.count))
        return "\(stem.isEmpty ? "attachment" : stem)\(suffix)"
    }

    private static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hash.update(data: data)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func shareError(_ message: String) -> NSError {
        NSError(
            domain: "com.reader.localfirst.share-extension",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
