import Foundation

enum ReaderShareURL {
    static let maximumURLLength = 2_048
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
}
