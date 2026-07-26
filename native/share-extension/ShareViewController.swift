import AppKit
import UniformTypeIdentifiers

@objc(ReaderShareViewController)
final class ReaderShareViewController: NSViewController {
    private var started = false

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 96))
        let status = NSTextField(labelWithString: "正在把内容交给 Reader…")
        status.frame = NSRect(x: 20, y: 36, width: 280, height: 24)
        status.alignment = .center
        status.setAccessibilityLabel("正在把内容交给 Reader")
        container.addSubview(status)
        view = container
        preferredContentSize = container.frame.size
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard !started else { return }
        started = true
        loadSharedContent()
    }

    private func loadSharedContent() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        if let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
        }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
                DispatchQueue.main.async {
                    self?.finish(ReaderShareURL.normalize(item).flatMap(ReaderShareURL.deepLink))
                }
            }
            return
        }
        if let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
        }) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.plainText.identifier) { [weak self] data, _ in
                DispatchQueue.main.async {
                    self?.finish(ReaderShareURL.deepLink(forText: data))
                }
            }
            return
        }
        finish(nil)
    }

    private func finish(_ deepLink: URL?) {
        guard let deepLink,
              NSWorkspace.shared.open(deepLink) else {
            let error = NSError(
                domain: "com.reader.localfirst.share-extension",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "无法把内容交给 Reader。请确认 Reader 已安装，且选中文本不超过 4 KiB。"]
            )
            extensionContext?.cancelRequest(withError: error)
            return
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
}
