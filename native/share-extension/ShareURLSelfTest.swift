import Foundation

@main
struct ReaderShareURLSelfTest {
    static func main() {
        expect(
            ReaderShareURL.normalize(" https://example.com/文章?q=reader#notes ")?.absoluteString
                == "https://example.com/%E6%96%87%E7%AB%A0?q=reader#notes",
            "应规范化 HTTPS 链接"
        )
        expect(
            ReaderShareURL.normalize(URL(string: "http://example.com/path")!)?.absoluteString
                == "http://example.com/path",
            "应接受 URL 对象"
        )
        expect(
            ReaderShareURL.normalize(Data("https://example.com/from-data".utf8))?.absoluteString
                == "https://example.com/from-data",
            "应接受 UTF-8 URL 数据"
        )

        for candidate in [
            "",
            "javascript:alert(1)",
            "file:///tmp/private",
            "https://user:secret@example.com",
            "https://",
            "https://example.com/\nother",
            "https://example.com/" + String(repeating: "a", count: 2_049)
        ] {
            expect(ReaderShareURL.normalize(candidate) == nil, "应拒绝不安全链接：\(candidate.prefix(80))")
        }

        let source = URL(string: "https://example.com/article?page=2#notes")!
        let deepLink = require(ReaderShareURL.deepLink(for: source), "应创建 Reader 深链")
        let components = require(URLComponents(url: deepLink, resolvingAgainstBaseURL: false), "深链应可解析")
        expect(components.scheme == "reader-local", "深链 scheme 错误")
        expect(components.host == "add", "深链 host 错误")
        expect(components.path.isEmpty, "深链不能带路径")
        expect(components.fragment == nil, "深链不能带 fragment")
        expect(
            components.queryItems == [URLQueryItem(name: "url", value: source.absoluteString)],
            "深链必须只携带一个 URL 参数"
        )

        let sharedText = "Reader 选中文本\n只在用户确认后保存。"
        expect(ReaderShareURL.normalizeText(sharedText) == sharedText, "应保留安全文本")
        expect(ReaderShareURL.normalizeText(NSAttributedString(string: sharedText)) == sharedText, "应接受富文本字符串")
        expect(ReaderShareURL.normalizeText(Data(sharedText.utf8)) == sharedText, "应接受 UTF-8 文本数据")
        for candidate in [
            "",
            " \n\t ",
            "Reader\u{0000}secret",
            String(repeating: "中", count: 1_366) + "x"
        ] {
            expect(ReaderShareURL.normalizeText(candidate) == nil, "应拒绝空白、控制字符或超限文本")
        }
        expect(ReaderShareURL.normalizeText(String(repeating: "a", count: 4_096)) != nil, "应接受 4 KiB UTF-8 文本")

        let textDeepLink = require(ReaderShareURL.deepLink(forText: sharedText), "应创建文本深链")
        let textComponents = require(URLComponents(url: textDeepLink, resolvingAgainstBaseURL: false), "文本深链应可解析")
        let encodedText = require(textComponents.queryItems?.first(where: { $0.name == "text" })?.value, "文本深链必须携带 text")
        var base64 = encodedText.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        expect(Data(base64Encoded: base64).flatMap { String(data: $0, encoding: .utf8) } == sharedText, "文本深链必须无损")
        expect(textComponents.queryItems?.count == 1, "文本深链不能携带额外参数")
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
