import AppKit
import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

private let indexName = "ReaderLibrary"
private let domainIdentifier = "com.reader.localfirst.library"
private let itemPrefix = "reader-article:"
private let maximumItems = 100
private let operationTimeout: TimeInterval = 12

private struct SpotlightItem: Decodable {
    let id: String
    let operation: String
    let title: String?
    let excerpt: String?
    let content: String?
    let author: String?
    let source: String?
    let type: String?
    let language: String?
    let publishedAt: String?
    let createdAt: String?
    let updatedAt: String?
    let tags: [String]?
}

private struct Request: Decodable {
    let command: String
    let items: [SpotlightItem]?
    let identifier: String?
    let title: String?
}

private struct Response: Encodable {
    let ok: Bool
    let available: Bool?
    let applied: Int?
    let deleted: Int?
    let identifiers: [String]?
}

private func reply(_ response: Response, code: Int32 = 0) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
    exit(code)
}

private func validID(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 200 && value.unicodeScalars.allSatisfy {
        !CharacterSet.controlCharacters.contains($0)
    }
}

private func bounded(_ value: String?, _ maximum: Int) -> String {
    String((value ?? "").prefix(maximum))
}

private func date(_ value: String?) -> Date? {
    guard let value, value.count <= 64 else { return nil }
    return ISO8601DateFormatter().date(from: value)
}

private func waitForOperation(_ operation: (@escaping (Error?) -> Void) -> Void) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var succeeded = false
    operation { error in
        succeeded = error == nil
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + operationTimeout) == .success else { return false }
    return succeeded
}

private func searchableItem(_ item: SpotlightItem) -> CSSearchableItem? {
    guard validID(item.id), item.operation == "upsert" else { return nil }
    let title = bounded(item.title, 500).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return nil }
    let attributes = CSSearchableItemAttributeSet(contentType: .text)
    attributes.title = title
    attributes.displayName = title
    attributes.contentDescription = bounded(item.excerpt, 2_000)
    attributes.textContent = bounded(item.content, 20_000)
    attributes.creator = bounded(item.author, 500)
    attributes.organizations = bounded(item.source, 500).isEmpty ? nil : [bounded(item.source, 500)]
    attributes.keywords = ([bounded(item.type, 100), bounded(item.language, 50), bounded(item.source, 500)]
        + (item.tags ?? []).prefix(50).map { bounded($0, 100) }).filter { !$0.isEmpty }
    attributes.contentCreationDate = date(item.publishedAt) ?? date(item.createdAt)
    attributes.contentModificationDate = date(item.updatedAt)
    return CSSearchableItem(
        uniqueIdentifier: itemPrefix + item.id,
        domainIdentifier: domainIdentifier,
        attributeSet: attributes
    )
}

private func process(_ request: Request) -> Never {
    guard CSSearchableIndex.isIndexingAvailable() else {
        reply(Response(ok: false, available: false, applied: nil, deleted: nil, identifiers: nil), code: 2)
    }
    let index = CSSearchableIndex(
        name: indexName,
        protectionClass: .completeUntilFirstUserAuthentication
    )
    switch request.command {
    case "availability":
        reply(Response(ok: true, available: true, applied: nil, deleted: nil, identifiers: nil))
    case "delete-all":
        let ok = waitForOperation { completion in
            index.deleteSearchableItems(withDomainIdentifiers: [domainIdentifier], completionHandler: completion)
        }
        reply(Response(ok: ok, available: true, applied: nil, deleted: ok ? 1 : nil, identifiers: nil), code: ok ? 0 : 3)
    case "apply":
        guard let items = request.items, items.count <= maximumItems else {
            reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 4)
        }
        var identifiersToDelete: [String] = []
        var itemsToIndex: [CSSearchableItem] = []
        for item in items {
            guard validID(item.id), ["upsert", "delete"].contains(item.operation) else {
                reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 5)
            }
            if item.operation == "delete" {
                identifiersToDelete.append(itemPrefix + item.id)
            } else if let searchable = searchableItem(item) {
                itemsToIndex.append(searchable)
            } else {
                reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 6)
            }
        }
        if !identifiersToDelete.isEmpty {
            let ok = waitForOperation { completion in
                index.deleteSearchableItems(withIdentifiers: identifiersToDelete, completionHandler: completion)
            }
            guard ok else {
                reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 7)
            }
        }
        if !itemsToIndex.isEmpty {
            let ok = waitForOperation { completion in
                index.indexSearchableItems(itemsToIndex, completionHandler: completion)
            }
            guard ok else {
                reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 8)
            }
        }
        reply(Response(ok: true, available: true, applied: itemsToIndex.count, deleted: identifiersToDelete.count, identifiers: nil))
    case "query":
        guard let identifier = request.identifier, validID(identifier),
              let title = request.title, !title.isEmpty, title.count <= 500 else {
            reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 9)
        }
        let escaped = title.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let query = CSSearchQuery(
            queryString: "title == \"\(escaped)\"c",
            attributes: ["uniqueIdentifier"]
        )
        query.protectionClasses = [.completeUntilFirstUserAuthentication]
        let semaphore = DispatchSemaphore(value: 0)
        var identifiers: [String] = []
        var succeeded = false
        query.foundItemsHandler = { items in
            identifiers.append(contentsOf: items.map(\.uniqueIdentifier).filter { $0 == itemPrefix + identifier })
        }
        query.completionHandler = { error in
            succeeded = error == nil
            semaphore.signal()
        }
        query.start()
        guard semaphore.wait(timeout: .now() + operationTimeout) == .success, succeeded else {
            reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 10)
        }
        reply(Response(ok: true, available: true, applied: nil, deleted: nil, identifiers: identifiers))
    default:
        reply(Response(ok: false, available: true, applied: nil, deleted: nil, identifiers: nil), code: 11)
    }
}

private final class SpotlightDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.prohibited)
    }

    func application(
        _ application: NSApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void
    ) -> Bool {
        guard userActivity.activityType == CSSearchableItemActionType,
              let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
              identifier.hasPrefix(itemPrefix) else { return false }
        let articleID = String(identifier.dropFirst(itemPrefix.count))
        guard validID(articleID) else { return false }
        var components = URLComponents()
        components.scheme = "reader-local"
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "article", value: articleID)]
        guard let url = components.url else { return false }
        NSWorkspace.shared.open(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
        return true
    }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
if !input.isEmpty {
    guard input.count <= 3 * 1024 * 1024,
          let request = try? JSONDecoder().decode(Request.self, from: input) else {
        reply(Response(ok: false, available: nil, applied: nil, deleted: nil, identifiers: nil), code: 1)
    }
    process(request)
}

private let application = NSApplication.shared
private let delegate = SpotlightDelegate()
application.delegate = delegate
application.run()
