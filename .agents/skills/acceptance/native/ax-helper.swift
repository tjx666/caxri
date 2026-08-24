import ApplicationServices
import Darwin
import Foundation

private let dialogMaxDepth = 12
private let dialogMaxElements = 256
private let panelMaxDepth = 12
private let panelMaxElements = 2_048
private let pollInterval: TimeInterval = 0.1

private enum ExitCode: Int32 {
    case success = 0
    case notFound = 2
    case ambiguous = 3
    case noAccessibilityPermission = 4
    case messagingTimeout = 5
    case invalidArguments = 6
    case targetGone = 7
    case traversalLimit = 8
    case actionFailed = 9
    case selectionFailed = 10
    case environmentBlocked = 11
}

private struct Output: Encodable {
    let ok: Bool
    let code: String?
    let message: String?
    let matchCount: Int
    let ownerPid: Int32?
    let role: String?
    let title: String?
    let elapsedMs: Int
    let selectedPath: String?
}

private struct Options {
    let button: String
    let command: String
    let path: String?
    let pid: pid_t
    let timeoutMs: Int
    let title: String?
}

private struct Match {
    let button: AXUIElement
    let container: AXUIElement
    let role: String
    let title: String
}

private struct ScanState {
    var limitExceeded = false
    var sawCannotComplete = false
    var visited = 0
}

private let startedAt = Date()

private func elapsedMs() -> Int {
    Int(Date().timeIntervalSince(startedAt) * 1_000)
}

private func finish(
    _ exitCode: ExitCode,
    code: String? = nil,
    message: String? = nil,
    matchCount: Int = 0,
    ownerPid: pid_t? = nil,
    role: String? = nil,
    title: String? = nil,
    selectedPath: String? = nil
) -> Never {
    let output = Output(
        ok: exitCode == .success,
        code: code,
        message: message,
        matchCount: matchCount,
        ownerPid: ownerPid,
        role: role,
        title: title,
        elapsedMs: elapsedMs(),
        selectedPath: selectedPath
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(output), let line = String(data: data, encoding: .utf8) {
        print(line)
    } else {
        print("{\"ok\":false,\"code\":\"encoding-failed\",\"matchCount\":0,\"elapsedMs\":0}")
    }
    Foundation.exit(exitCode.rawValue)
}

private func parseOptions(_ arguments: [String]) -> Options {
    guard let command = arguments.first else {
        finish(.invalidArguments, code: "invalid-args", message: "A command is required")
    }
    let allowedCommands = Set([
        "preflight",
        "dialog-inspect",
        "dialog-press",
        "open-panel-inspect",
        "open-panel-press",
        "open-panel-select",
    ])
    guard allowedCommands.contains(command) else {
        finish(.invalidArguments, code: "invalid-args", message: "Unknown command: \(command)")
    }

    var values: [String: String] = [:]
    var index = 1
    while index < arguments.count {
        let option = arguments[index]
        guard option.hasPrefix("--"), index + 1 < arguments.count else {
            finish(.invalidArguments, code: "invalid-args", message: "Invalid option: \(option)")
        }
        guard values[option] == nil else {
            finish(.invalidArguments, code: "invalid-args", message: "Duplicate option: \(option)")
        }
        values[option] = arguments[index + 1]
        index += 2
    }

    let allowedOptions = Set(["--button", "--path", "--pid", "--timeout-ms", "--title"])
    if let unknown = values.keys.first(where: { !allowedOptions.contains($0) }) {
        finish(.invalidArguments, code: "invalid-args", message: "Unknown option: \(unknown)")
    }
    guard let rawPid = values["--pid"], let pid = pid_t(rawPid), pid > 0 else {
        finish(.invalidArguments, code: "invalid-args", message: "--pid must be a positive integer")
    }
    let button = values["--button"] ?? ""
    if command != "preflight" && button.isEmpty {
        finish(.invalidArguments, code: "invalid-args", message: "--button is required")
    }
    let timeoutMs = values["--timeout-ms"].flatMap(Int.init) ?? 10_000
    guard timeoutMs > 0, timeoutMs <= 120_000 else {
        finish(
            .invalidArguments,
            code: "invalid-args",
            message: "--timeout-ms must be between 1 and 120000"
        )
    }
    let isPanelCommand = command.hasPrefix("open-panel-")
    let title = values["--title"]
    if isPanelCommand && (title == nil || title?.isEmpty == true) {
        finish(.invalidArguments, code: "invalid-args", message: "--title is required")
    }
    let path = values["--path"]
    if command == "open-panel-select" && (path == nil || path?.isEmpty == true) {
        finish(.invalidArguments, code: "invalid-args", message: "--path is required")
    }
    if command != "open-panel-select" && path != nil {
        finish(
            .invalidArguments,
            code: "invalid-args",
            message: "--path is valid only for open-panel-select"
        )
    }
    return Options(
        button: button,
        command: command,
        path: path,
        pid: pid,
        timeoutMs: timeoutMs,
        title: title
    )
}

private final class AccessibilityReader {
    var sawCannotComplete = false

    func value<T>(_ element: AXUIElement, _ attribute: CFString, as _: T.Type = T.self) -> T? {
        var rawValue: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute, &rawValue)
        if error == .cannotComplete {
            sawCannotComplete = true
        }
        guard error == .success else { return nil }
        return rawValue as? T
    }

    func role(_ element: AXUIElement) -> String {
        value(element, kAXRoleAttribute as CFString) ?? ""
    }

    func subrole(_ element: AXUIElement) -> String {
        value(element, kAXSubroleAttribute as CFString) ?? ""
    }

    func children(_ element: AXUIElement) -> [AXUIElement] {
        value(element, kAXChildrenAttribute as CFString) ?? []
    }
}

private func normalized(_ value: String) -> String {
    value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func traverse(
    _ root: AXUIElement,
    reader: AccessibilityReader,
    maxDepth: Int,
    maxElements: Int,
    skipChildrenOfRoles: Set<String> = [],
    visit: (AXUIElement, Int) -> Void
) -> ScanState {
    var state = ScanState()

    func walk(_ element: AXUIElement, depth: Int) {
        guard !state.limitExceeded, depth <= maxDepth else { return }
        state.visited += 1
        if state.visited > maxElements {
            state.limitExceeded = true
            return
        }
        visit(element, depth)
        guard depth < maxDepth, !skipChildrenOfRoles.contains(reader.role(element)) else { return }
        for child in reader.children(element) {
            walk(child, depth: depth + 1)
            if state.limitExceeded { return }
        }
    }

    walk(root, depth: 0)
    state.sawCannotComplete = reader.sawCannotComplete
    return state
}

private func uniqueElements(_ elements: [AXUIElement]) -> [AXUIElement] {
    var seen = Set<CFHashCode>()
    return elements.filter { seen.insert(CFHash($0)).inserted }
}

private func findDialogMatches(
    app: AXUIElement,
    buttonTitle: String,
    reader: AccessibilityReader
) -> (matches: [Match], state: ScanState) {
    let containerSkipRoles = Set(["AXBrowser", "AXList", "AXMenu", "AXMenuBar", "AXOutline", "AXScrollArea", "AXTable", "AXWebArea"])
    var containers: [AXUIElement] = []
    let containerState = traverse(
        app,
        reader: reader,
        maxDepth: dialogMaxDepth,
        maxElements: dialogMaxElements,
        skipChildrenOfRoles: containerSkipRoles
    ) { element, _ in
        if reader.role(element) == "AXSheet" || reader.subrole(element) == "AXDialog" {
            containers.append(element)
        }
    }
    if containerState.limitExceeded {
        return ([], containerState)
    }

    var matches: [Match] = []
    for container in uniqueElements(containers) {
        let containerRole = reader.role(container)
        var preferred: [AXUIElement] = []
        if let button: AXUIElement = reader.value(container, kAXDefaultButtonAttribute as CFString) {
            preferred.append(button)
        }
        if let button: AXUIElement = reader.value(container, kAXCancelButtonAttribute as CFString) {
            preferred.append(button)
        }
        let preferredMatches = uniqueElements(preferred).filter {
            let title: String = reader.value($0, kAXTitleAttribute as CFString) ?? ""
            return reader.role($0) == "AXButton" && title == buttonTitle
        }
        if !preferredMatches.isEmpty {
            matches.append(contentsOf: preferredMatches.map {
                Match(button: $0, container: container, role: containerRole, title: buttonTitle)
            })
            continue
        }

        var descendantMatches: [AXUIElement] = []
        let descendantState = traverse(
            container,
            reader: reader,
            maxDepth: dialogMaxDepth,
            maxElements: dialogMaxElements,
            skipChildrenOfRoles: containerSkipRoles
        ) { element, _ in
            guard reader.role(element) == "AXButton" else { return }
            let title: String = reader.value(element, kAXTitleAttribute as CFString) ?? ""
            if title == buttonTitle { descendantMatches.append(element) }
        }
        if descendantState.limitExceeded {
            return ([], descendantState)
        }
        matches.append(contentsOf: uniqueElements(descendantMatches).map {
            Match(button: $0, container: container, role: containerRole, title: buttonTitle)
        })
    }
    return (matches, containerState)
}

/**
 * Remote AppKit open panels can be absent from the host's AXWindows/AXSheets attributes while still appearing as an
 * AXSheet beneath the owned window's AXChildren. Traverse only that owned child tree instead of guessing the XPC PID.
 */
private func findOpenPanelMatches(
    app: AXUIElement,
    expectedTitle: String,
    reader: AccessibilityReader
) -> (matches: [Match], state: ScanState) {
    var panels: [AXUIElement] = []
    let state = traverse(
        app,
        reader: reader,
        maxDepth: panelMaxDepth,
        maxElements: dialogMaxElements,
        skipChildrenOfRoles: ["AXBrowser", "AXList", "AXMenu", "AXMenuBar", "AXOutline", "AXTable", "AXWebArea"]
    ) { element, _ in
        guard reader.role(element) == "AXSheet" else { return }
        let identifier: String = reader.value(element, kAXIdentifierAttribute as CFString) ?? ""
        let description: String = reader.value(element, kAXDescriptionAttribute as CFString) ?? ""
        if identifier == "open-panel" && normalized(description) == normalized(expectedTitle) {
            panels.append(element)
        }
    }
    if state.limitExceeded { return ([], state) }

    let matches = uniqueElements(panels).compactMap { panel -> Match? in
        var buttons: [AXUIElement] = []
        if let defaultButton: AXUIElement = reader.value(
            panel,
            kAXDefaultButtonAttribute as CFString
        ) {
            buttons.append(defaultButton)
        }
        _ = traverse(
            panel,
            reader: reader,
            maxDepth: panelMaxDepth,
            maxElements: dialogMaxElements,
            skipChildrenOfRoles: ["AXBrowser", "AXList", "AXMenu", "AXOutline", "AXTable", "AXWebArea"]
        ) { element, _ in
            let identifier: String = reader.value(element, kAXIdentifierAttribute as CFString) ?? ""
            if reader.role(element) == "AXButton", identifier == "OKButton" {
                buttons.append(element)
            }
        }
        let defaultButtons = uniqueElements(buttons).filter {
            let identifier: String = reader.value($0, kAXIdentifierAttribute as CFString) ?? ""
            return reader.role($0) == "AXButton" && identifier == "OKButton"
        }
        guard defaultButtons.count == 1, let defaultButton = defaultButtons.first else { return nil }
        let actualTitle: String = reader.value(defaultButton, kAXTitleAttribute as CFString) ?? ""
        return Match(button: defaultButton, container: panel, role: "AXSheet", title: actualTitle)
    }
    return (matches, state)
}

private func waitForOneMatch(
    app: AXUIElement,
    options: Options,
    reader: AccessibilityReader,
    deadline: Date
) -> Match {
    while Date() < deadline {
        reader.sawCannotComplete = false
        let result = options.command.hasPrefix("open-panel-")
            ? findOpenPanelMatches(app: app, expectedTitle: options.title!, reader: reader)
            : findDialogMatches(app: app, buttonTitle: options.button, reader: reader)
        if result.state.limitExceeded {
            finish(
                .traversalLimit,
                code: "limit",
                message: "Accessibility traversal exceeded its safety bound",
                ownerPid: options.pid
            )
        }
        if result.matches.count > 1 {
            finish(
                .ambiguous,
                code: "ambiguous",
                message: "Multiple matching native dialogs were found",
                matchCount: result.matches.count,
                ownerPid: options.pid
            )
        }
        if let match = result.matches.first { return match }
        Thread.sleep(forTimeInterval: pollInterval)
    }
    if reader.sawCannotComplete {
        finish(
            .messagingTimeout,
            code: "ax-messaging-timeout",
            message: "The target process did not complete an Accessibility request",
            ownerPid: options.pid
        )
    }
    finish(
        .notFound,
        code: "not-found",
        message: "No matching native dialog appeared before the deadline",
        ownerPid: options.pid
    )
}

private func findFirst(
    _ root: AXUIElement,
    reader: AccessibilityReader,
    maxDepth: Int,
    maxElements: Int,
    predicate: (AXUIElement) -> Bool
) -> (element: AXUIElement?, state: ScanState) {
    var found: AXUIElement?
    let state = traverse(
        root,
        reader: reader,
        maxDepth: maxDepth,
        maxElements: maxElements
    ) { element, _ in
        if found == nil && predicate(element) { found = element }
    }
    return (found, state)
}

private func descendantText(_ root: AXUIElement, reader: AccessibilityReader) -> String? {
    findFirst(
        root,
        reader: reader,
        maxDepth: 4,
        maxElements: 32
    ) { reader.role($0) == "AXStaticText" }.element.flatMap {
        reader.value($0, kAXValueAttribute as CFString)
    }
}

private func fileURL(_ element: AXUIElement, reader: AccessibilityReader) -> URL? {
    reader.value(element, kAXURLAttribute as CFString)
}

private func sameFileURL(_ left: URL, _ right: URL) -> Bool {
    left.standardizedFileURL.path == right.standardizedFileURL.path
}

private func findFileElement(
    browser: AXUIElement,
    target: URL,
    reader: AccessibilityReader
) -> (elements: [AXUIElement], state: ScanState) {
    var matches: [AXUIElement] = []
    let state = traverse(
        browser,
        reader: reader,
        maxDepth: panelMaxDepth,
        maxElements: panelMaxElements
    ) { element, _ in
        if let url = fileURL(element, reader: reader), sameFileURL(url, target) {
            matches.append(element)
        }
    }
    return (uniqueElements(matches), state)
}

private func fileBrowser(
    panel: AXUIElement,
    reader: AccessibilityReader
) -> AXUIElement? {
    findFirst(
        panel,
        reader: reader,
        maxDepth: panelMaxDepth,
        maxElements: dialogMaxElements
    ) { reader.role($0) == "AXBrowser" }.element
}

/**
 * AppKit exposes browser selection differently across Finder view modes: rows may own AXSelected directly, while
 * outline-like containers own AXSelectedChildren. Try both semantic forms while walking the bounded ancestor chain.
 */
private func selectFileElement(
    _ item: AXUIElement,
    reader: AccessibilityReader
) -> AXError {
    var candidate: AXUIElement? = item
    for _ in 0..<12 {
        guard let element = candidate else { break }
        var selectedSettable = DarwinBoolean(false)
        let selectedSettableError = AXUIElementIsAttributeSettable(
            element,
            kAXSelectedAttribute as CFString,
            &selectedSettable
        )
        if selectedSettableError == .cannotComplete { reader.sawCannotComplete = true }
        if selectedSettableError == .success, selectedSettable.boolValue {
            return AXUIElementSetAttributeValue(
                element,
                kAXSelectedAttribute as CFString,
                kCFBooleanTrue
            )
        }

        guard let parent: AXUIElement = reader.value(
            element,
            kAXParentAttribute as CFString
        ) else { break }
        var settable = DarwinBoolean(false)
        let settableError = AXUIElementIsAttributeSettable(
            parent,
            kAXSelectedChildrenAttribute as CFString,
            &settable
        )
        if settableError == .cannotComplete { reader.sawCannotComplete = true }
        if settableError == .success, settable.boolValue {
            return AXUIElementSetAttributeValue(
                parent,
                kAXSelectedChildrenAttribute as CFString,
                [element] as CFArray
            )
        }
        candidate = parent
    }
    return .attributeUnsupported
}

private func targetAncestors(_ target: URL) -> [URL] {
    var ancestors: [URL] = []
    var current = target.deletingLastPathComponent().standardizedFileURL
    while current.path != "/" {
        ancestors.append(current)
        current.deleteLastPathComponent()
    }
    return ancestors
}

private func waitUntil(
    deadline: Date,
    predicate: () -> Bool
) -> Bool {
    while Date() < deadline {
        if predicate() { return true }
        Thread.sleep(forTimeInterval: pollInterval)
    }
    return false
}

private func selectOpenPanelPath(
    match: Match,
    path: String,
    options: Options,
    reader: AccessibilityReader,
    deadline: Date
) {
    let target = URL(fileURLWithPath: path).standardizedFileURL
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        finish(
            .selectionFailed,
            code: "invalid-path",
            message: "The selected fixture must be an existing file",
            ownerPid: options.pid
        )
    }

    guard fileBrowser(panel: match.container, reader: reader) != nil else {
        finish(
            .selectionFailed,
            code: "selection-failed",
            message: "The open panel did not expose one file browser",
            ownerPid: options.pid
        )
    }
    let outlineResult = findFirst(
        match.container,
        reader: reader,
        maxDepth: panelMaxDepth,
        maxElements: dialogMaxElements
    ) { reader.role($0) == "AXOutline" }
    guard let outline = outlineResult.element else {
        finish(
            .selectionFailed,
            code: "selection-failed",
            message: "The open panel did not expose one sidebar outline",
            ownerPid: options.pid
        )
    }

    let rows = reader.children(outline).filter {
        reader.role($0) == "AXRow" && reader.subrole($0) == "AXOutlineRow"
    }
    var anchor: URL?
    for candidate in targetAncestors(target) {
        let label = candidate.lastPathComponent
        let candidates = rows.filter { descendantText($0, reader: reader) == label }
        guard candidates.count <= 1 else {
            finish(
                .ambiguous,
                code: "ambiguous",
                message: "Multiple sidebar rows match path ancestor \(label)",
                matchCount: candidates.count,
                ownerPid: options.pid
            )
        }
        guard let row = candidates.first else { continue }
        let selectError = AXUIElementSetAttributeValue(
            row,
            kAXSelectedAttribute as CFString,
            kCFBooleanTrue
        )
        guard selectError == .success else {
            finish(
                .selectionFailed,
                code: "selection-failed",
                message: "Could not select sidebar path ancestor \(label)",
                ownerPid: options.pid
            )
        }
        let anchored = waitUntil(deadline: deadline) {
            guard let browser = fileBrowser(panel: match.container, reader: reader) else {
                return false
            }
            let scan = findFileElement(browser: browser, target: candidate, reader: reader)
            if !scan.elements.isEmpty { return true }
            var foundChild = false
            _ = traverse(
                browser,
                reader: reader,
                maxDepth: panelMaxDepth,
                maxElements: panelMaxElements
            ) { element, _ in
                guard let url = fileURL(element, reader: reader) else { return }
                let parent = url.deletingLastPathComponent().standardizedFileURL
                if sameFileURL(parent, candidate) { foundChild = true }
            }
            return foundChild
        }
        guard anchored else { continue }
        anchor = candidate
        break
    }
    guard let anchor else {
        finish(
            .selectionFailed,
            code: "selection-failed",
            message: "No sidebar row could prove an ancestor of the fixture path",
            ownerPid: options.pid
        )
    }

    let anchorComponents = anchor.pathComponents
    let targetComponents = target.pathComponents
    guard targetComponents.starts(with: anchorComponents) else {
        finish(
            .selectionFailed,
            code: "selection-failed",
            message: "The fixture path is outside the selected sidebar ancestor",
            ownerPid: options.pid
        )
    }
    var current = anchor
    let remainingComponents = targetComponents.dropFirst(anchorComponents.count)
    for component in remainingComponents {
        current.appendPathComponent(component)
        let found = waitUntil(deadline: deadline) {
            guard let browser = fileBrowser(panel: match.container, reader: reader) else {
                return false
            }
            return !findFileElement(browser: browser, target: current, reader: reader).elements.isEmpty
        }
        guard found else {
            finish(
                .selectionFailed,
                code: reader.sawCannotComplete ? "ax-messaging-timeout" : "selection-failed",
                message: "The open panel did not expose path component \(component)",
                ownerPid: options.pid
            )
        }
        guard let browser = fileBrowser(panel: match.container, reader: reader) else {
            finish(
                .selectionFailed,
                code: "selection-failed",
                message: "The open panel file browser disappeared",
                ownerPid: options.pid
            )
        }
        let result = findFileElement(browser: browser, target: current, reader: reader)
        if result.state.limitExceeded {
            finish(
                .traversalLimit,
                code: "limit",
                message: "File browser traversal exceeded its safety bound",
                ownerPid: options.pid
            )
        }
        guard result.elements.count == 1, let element = result.elements.first else {
            finish(
                .ambiguous,
                code: "ambiguous",
                message: "The open panel did not expose one exact path component",
                matchCount: result.elements.count,
                ownerPid: options.pid
            )
        }
        let selectError = selectFileElement(element, reader: reader)
        guard selectError == .success else {
            finish(
                .selectionFailed,
                code: "selection-failed",
                message: "Could not select path component \(component)",
                ownerPid: options.pid
            )
        }
    }

    let selected = waitUntil(deadline: deadline) {
        guard let browser = fileBrowser(panel: match.container, reader: reader) else { return false }
        let elements = findFileElement(browser: browser, target: target, reader: reader).elements
        guard elements.count == 1, let element = elements.first else { return false }
        return reader.value(element, kAXSelectedAttribute as CFString) ?? false
    }
    guard selected else {
        finish(
            .selectionFailed,
            code: "selection-failed",
            message: "The fixture was not selected before the deadline",
            ownerPid: options.pid
        )
    }
    finish(
        .success,
        matchCount: 1,
        ownerPid: options.pid,
        role: match.role,
        title: match.title,
        selectedPath: target.path
    )
}

private let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
guard AXIsProcessTrusted() else {
    finish(
        .noAccessibilityPermission,
        code: "no-ax-permission",
        message: "Grant Accessibility access to the terminal running Caxri Acceptance"
    )
}
guard kill(options.pid, 0) == 0 || errno == EPERM else {
    finish(
        .targetGone,
        code: "target-gone",
        message: "The owned Electron process is no longer running",
        ownerPid: options.pid
    )
}

let app = AXUIElementCreateApplication(options.pid)
let messagingTimeout = min(2.0, max(0.25, Double(options.timeoutMs) / 1_000.0))
let timeoutError = AXUIElementSetMessagingTimeout(app, Float(messagingTimeout))
guard timeoutError == .success else {
    finish(
        .messagingTimeout,
        code: "ax-messaging-timeout",
        message: "Could not configure the Accessibility messaging timeout",
        ownerPid: options.pid
    )
}

private let reader = AccessibilityReader()
let deadline = Date().addingTimeInterval(Double(options.timeoutMs) / 1_000.0)

if options.command == "preflight" {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let isLocked = session?["CGSSessionScreenIsLocked"] as? Bool ?? false
    guard !isLocked else {
        finish(
            .environmentBlocked,
            code: "screen-locked",
            message: "Unlock the macOS desktop before triggering a native Acceptance dialog",
            ownerPid: options.pid
        )
    }
    let role = reader.role(app)
    let title: String = reader.value(app, kAXTitleAttribute as CFString) ?? ""
    guard role == "AXApplication", !reader.children(app).isEmpty else {
        finish(
            .environmentBlocked,
            code: "ax-not-ready",
            message: "The owned Electron Accessibility tree is not ready",
            ownerPid: options.pid
        )
    }
    finish(
        .success,
        matchCount: 1,
        ownerPid: options.pid,
        role: role,
        title: title
    )
}

private let match = waitForOneMatch(app: app, options: options, reader: reader, deadline: deadline)

if options.command == "open-panel-select" {
    selectOpenPanelPath(
        match: match,
        path: options.path!,
        options: options,
        reader: reader,
        deadline: deadline
    )
}

if options.command == "dialog-press" || options.command == "open-panel-press" {
    let actionError = AXUIElementPerformAction(match.button, kAXPressAction as CFString)
    if actionError == .cannotComplete {
        finish(
            .actionFailed,
            code: "action-uncertain",
            message: "The single AXPress may have completed; verify product state and do not retry",
            matchCount: 1,
            ownerPid: options.pid,
            role: match.role,
            title: match.title
        )
    }
    guard actionError == .success else {
        finish(
            .actionFailed,
            code: "action-failed",
            message: "The single AXPress failed with AXError \(actionError.rawValue)",
            matchCount: 1,
            ownerPid: options.pid,
            role: match.role,
            title: match.title
        )
    }
}

finish(
    .success,
    matchCount: 1,
    ownerPid: options.pid,
    role: match.role,
    title: match.title
)
