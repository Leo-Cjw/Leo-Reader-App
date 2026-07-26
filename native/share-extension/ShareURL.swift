import Foundation

enum ReaderShareURL {
    static let maximumURLLength = 2_048
    static let maximumTextBytes = 4_096
    static let maximumDeepLinkLength = 8_192

    static func normalize(_ value: Any?) -> URL? {
        let candidate: String
        switch value {
        case let url as URL:
            candidate = url.absoluteString
        case let url as NSURL:
            candidate = url.absoluteString ?? ""
        case let string as String:
            candidate = string
        case let data as Data:
            candidate = String(data: data, encoding: .utf8) ?? ""
        default:
            return nil
        }

        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.count <= maximumURLLength,
              trimmed.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              let url = components.url else {
            return nil
        }
        return url
    }

    static func deepLink(for url: URL) -> URL? {
        guard let safeURL = normalize(url) else { return nil }
        var components = URLComponents()
        components.scheme = "reader-local"
        components.host = "add"
        components.queryItems = [URLQueryItem(name: "url", value: safeURL.absoluteString)]
        guard let deepLink = components.url,
              deepLink.absoluteString.count <= maximumDeepLinkLength else {
            return nil
        }
        return deepLink
    }

    static func normalizeText(_ value: Any?) -> String? {
        let candidate: String
        switch value {
        case let text as NSAttributedString:
            candidate = text.string
        case let text as String:
            candidate = text
        case let text as NSString:
            candidate = text as String
        case let data as Data:
            guard let text = String(data: data, encoding: .utf8) else { return nil }
            candidate = text
        default:
            return nil
        }

        guard !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let bytes = candidate.data(using: .utf8),
              bytes.count <= maximumTextBytes,
              candidate.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
                      || $0 == "\n" || $0 == "\r" || $0 == "\t"
              }) else {
            return nil
        }
        return candidate
    }

    static func deepLink(forText value: Any?) -> URL? {
        guard let text = normalizeText(value),
              let bytes = text.data(using: .utf8) else { return nil }
        let encoded = bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        var components = URLComponents()
        components.scheme = "reader-local"
        components.host = "add"
        components.queryItems = [URLQueryItem(name: "text", value: encoded)]
        guard let deepLink = components.url,
              deepLink.absoluteString.count <= maximumDeepLinkLength else {
            return nil
        }
        return deepLink
    }
}
