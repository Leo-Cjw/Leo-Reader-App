import AppKit
import UniformTypeIdentifiers

@objc(ReaderShareViewController)
final class ReaderShareViewController: NSViewController {
    private var started = false

    override func loadView() {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 96))
        let status = NSTextField(labelWithString: "正在把链接交给 Reader…")
        status.frame = NSRect(x: 20, y: 36, width: 280, height: 24)
        status.alignment = .center
        status.setAccessibilityLabel("正在把链接交给 Reader")
        container.addSubview(status)
        view = container
        preferredContentSize = container.frame.size
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard !started else { return }
        started = true
        loadSharedURL()
    }

    private func loadSharedURL() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        guard let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
        }) else {
            finish(nil)
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
            DispatchQueue.main.async {
                self?.finish(ReaderShareURL.normalize(item))
            }
        }
    }

    private func finish(_ url: URL?) {
        guard let url,
              let deepLink = ReaderShareURL.deepLink(for: url),
              NSWorkspace.shared.open(deepLink) else {
            let error = NSError(
                domain: "com.reader.localfirst.share-extension",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "无法把链接交给 Reader。请确认 Reader 已安装后重试。"]
            )
            extensionContext?.cancelRequest(withError: error)
            return
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
}
