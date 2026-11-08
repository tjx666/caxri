// Reports whether macOS lays a native alert out centered or left-aligned, without showing it.
//
// macOS 26 centers an `NSAlert` only while neither its message nor its detail wraps; one wrapped or
// explicit second line flips the whole sheet to a left-aligned layout (DESIGN.md, Confirmations).
// Electron's `dialog.showMessageBox` draws through `NSAlert`, so this checks prompt copy against the
// real AppKit layout. It never orders the window front, so it takes no focus and needs no
// Accessibility permission, unlike driving a shown dialog.
//
// Usage: swift .agents/skills/acceptance/native/alert-layout.swift <message> <detail> [button ...]
// Prints `centered` or `left-aligned` and exits 1 for `left-aligned`. Check the longest realistic
// values (for example `12 Terminals and 12 Chats`) in every shipped locale.
import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else {
    FileHandle.standardError.write(
        "usage: swift alert-layout.swift <message> <detail> [button ...]\n".data(using: .utf8)!)
    exit(2)
}

_ = NSApplication.shared
let alert = NSAlert()
alert.alertStyle = .warning
alert.messageText = arguments[0]
alert.informativeText = arguments[1]
for title in arguments.dropFirst(2) { alert.addButton(withTitle: title) }
alert.layout()

func iconFrame(in view: NSView) -> NSRect? {
    if let image = view as? NSImageView, image.frame.width > 30 {
        return image.convert(image.bounds, to: nil)
    }
    for child in view.subviews {
        if let frame = iconFrame(in: child) { return frame }
    }
    return nil
}

guard let contentView = alert.window.contentView, let icon = iconFrame(in: contentView) else {
    FileHandle.standardError.write("alert icon not found; AppKit layout changed\n".data(using: .utf8)!)
    exit(2)
}
let centered = abs(icon.midX - alert.window.frame.width / 2) < 5
print(centered ? "centered" : "left-aligned")
exit(centered ? 0 : 1)
