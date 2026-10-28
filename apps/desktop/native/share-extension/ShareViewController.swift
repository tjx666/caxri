import Cocoa
import OSLog
import UniformTypeIdentifiers

/// The macOS share extension that puts Caxri in the system Share menu, including WeChat's "forward to another app".
///
/// It has no interface. It copies what was shared into its own folder of the Share Inbox, writes a
/// `request.caxrishare` manifest beside the copies, and asks the containing Caxri.app to open that manifest; Desktop
/// Main validates the manifest and lets the user pick the Session that receives it (`apps/desktop/src/main/external-activation/share-inbox.ts`).
///
/// The extension is sandboxed. Its only writable location outside its container is the Share Inbox, granted by the
/// `temporary-exception` entitlement in `ShareExtension.entitlements`. A custom URL scheme is deliberately not used for
/// the hand-off: a sandboxed caller cannot open one reliably, while opening a document type the containing app declares
/// is allowed.
@objc(ShareViewController)
final class ShareViewController: NSViewController {
    private let logger = Logger(subsystem: "com.caxri.app.share", category: "share")

    override func loadView() {
        view = NSView(frame: .zero)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard let context = extensionContext else { return }
        let providers = context.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] }
        Task { @MainActor in
            do {
                let request = try await ShareRequestWriter(logger: logger).write(providers)
                try await openInCaxri(request)
                context.completeRequest(returningItems: nil)
            } catch {
                logger.error("share failed: \(String(describing: error), privacy: .public)")
                context.cancelRequest(withError: error)
            }
        }
    }

    /// Opens the manifest with the app that contains this extension, so a second Caxri installation never receives it.
    private func openInCaxri(_ manifest: URL) async throws {
        // Contents/PlugIns/Caxri Share.appex -> Caxri.app
        let appURL = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        _ = try await NSWorkspace.shared.open([manifest], withApplicationAt: appURL, configuration: configuration)
    }
}

enum ShareError: Error {
    case homeUnavailable
    case nothingShared
}

/// Copies shared items into a fresh request folder and writes its manifest.
struct ShareRequestWriter {
    let logger: Logger

    /// Main rejects a manifest over these limits (`manifestSchema` in `share-inbox.ts`), so the writer stays inside them
    /// instead of losing the whole share.
    static let maxFiles = 20
    static let maxTextLength = 100_000

    /// The real home folder. `NSHomeDirectory()` names the sandbox container inside an extension.
    private static func homeDirectory() throws -> URL {
        guard let entry = getpwuid(getuid()), let path = entry.pointee.pw_dir else {
            throw ShareError.homeUnavailable
        }
        return URL(fileURLWithPath: String(cString: path), isDirectory: true)
    }

    /// Must match `SHARE_INBOX_RELATIVE_PATH` in `apps/desktop/src/main/external-activation/share-inbox.ts` and the entitlement.
    static func inboxDirectory() throws -> URL {
        try homeDirectory().appendingPathComponent(
            "Library/Application Support/Caxri/Share Inbox",
            isDirectory: true
        )
    }

    func write(_ providers: [NSItemProvider]) async throws -> URL {
        let folder = try Self.inboxDirectory().appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var files: [String] = []
        var texts: [String] = []
        for provider in providers {
            do {
                if let type = fileType(of: provider) {
                    guard files.count < Self.maxFiles else {
                        logger.error("skipped a shared file beyond the \(Self.maxFiles, privacy: .public) file limit")
                        continue
                    }
                    files.append(try await copyFile(from: provider, type: type, into: folder, taken: Set(files)))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = try await loadURL(from: provider) { texts.append(url.absoluteString) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = try await loadText(from: provider) { texts.append(text) }
                }
            } catch {
                logger.error("skipped one shared item: \(String(describing: error), privacy: .public)")
            }
        }
        if files.isEmpty && texts.isEmpty {
            try? FileManager.default.removeItem(at: folder)
            throw ShareError.nothingShared
        }
        var manifest: [String: Any] = ["version": 1, "files": files]
        if !texts.isEmpty {
            // Counted in UTF-16 units, as JavaScript measures the string Main validates.
            let units = texts.joined(separator: "\n\n").utf16.prefix(Self.maxTextLength)
            manifest["text"] = String(decoding: Array(units), as: UTF16.self)
        }
        let manifestURL = folder.appendingPathComponent("request.caxrishare")
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try data.write(to: manifestURL, options: .atomic)
        return manifestURL
    }

    /// The type to load a file copy as: the first concrete data or folder type, so a ZIP arrives as the ZIP rather than
    /// as its URL.
    private func fileType(of provider: NSItemProvider) -> UTType? {
        provider.registeredTypeIdentifiers
            .compactMap(UTType.init)
            .first { type in
                (type.conforms(to: .data) || type.conforms(to: .directory)) && !type.conforms(to: .url)
            }
    }

    private func copyFile(
        from provider: NSItemProvider,
        type: UTType,
        into folder: URL,
        taken: Set<String>
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type) { url, _, error in
                // The provided URL is valid only inside this callback, so the copy happens here.
                guard let url else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                    return
                }
                let name = uniqueName(fileName(suggested: provider.suggestedName, loaded: url), taken: taken)
                do {
                    try FileManager.default.copyItem(at: url, to: folder.appendingPathComponent(name))
                    continuation.resume(returning: name)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func loadURL(from provider: NSItemProvider) async throws -> URL? {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: url) }
            }
        }
    }

    private func loadText(from provider: NSItemProvider) async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { text, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: text) }
            }
        }
    }
}

/// The sender's name for the item, keeping the loaded file's extension when the suggested name lacks one; the loaded
/// copy itself is often named after its type ("Zip archive.zip").
func fileName(suggested: String?, loaded: URL) -> String {
    let fallback = loaded.lastPathComponent
    guard let suggested, !suggested.isEmpty else { return sanitized(fallback) }
    let loadedExtension = loaded.pathExtension
    if loadedExtension.isEmpty || (suggested as NSString).pathExtension.lowercased() == loadedExtension.lowercased() {
        return sanitized(suggested)
    }
    return sanitized("\(suggested).\(loadedExtension)")
}

/// A single path component: no separators, never `.` or `..`, and never the manifest's own name.
func sanitized(_ name: String) -> String {
    let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
    if cleaned.isEmpty || cleaned == "." || cleaned == ".." || cleaned == "request.caxrishare" {
        return "shared-\(cleaned)"
    }
    return cleaned
}

func uniqueName(_ name: String, taken: Set<String>) -> String {
    guard taken.contains(name) else { return name }
    let base = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var index = 2
    while true {
        let candidate = ext.isEmpty ? "\(base) \(index)" : "\(base) \(index).\(ext)"
        if !taken.contains(candidate) { return candidate }
        index += 1
    }
}
