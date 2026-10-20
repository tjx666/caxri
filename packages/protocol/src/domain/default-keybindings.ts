import type { DefaultKeybindingChange } from '../configuration/config-files.js';
import { filesCoreKeybindings } from '../registry/core-contributions.js';
import type { Keybinding } from './domain.js';

/**
 * Tab accepts the active Terminal completion and the VS Code-compatible `sendSequence` command normalizes LF to Return
 * before submission. This keeps copied VS Code keybindings compatible without adding the more general `runCommands`
 * command solely for one sequence.
 */
const terminalCompleteAndSubmitKeybinding = {
    key: 'cmd+shift+enter',
    command: 'workbench.action.terminal.sendSequence',
    when: 'terminalFocus',
    args: { text: '\t\n' },
} satisfies Keybinding;

/**
 * Default keyboard shortcuts, seeded into `keybindings.jsonc` on first run.
 */
export const defaultKeybindings: Keybinding[] = [
    /**
     * The current path browser owns the familiar macOS quick-open chord. A future workspace-wide fuzzy opener must make
     * an explicit product decision instead of reserving `Cmd+P` while no such command exists.
     */
    { key: 'cmd+p', command: 'pathBrowser.open' },
    { key: 'cmd+shift+p', command: 'commandPalette.open' },
    { key: 'cmd+shift+a', command: 'agentActions.open' },
    /**
     * `Cmd+O` matches VS Code's "Open Folder…" / "Add Folder to Workspace…" convention. Caxri always adds a Project
     * rather than replacing the window.
     */
    { key: 'cmd+o', command: 'project.create' },
    /**
     * `Cmd+N` is the new-conversation chord in Claude Code Desktop and the new-document chord in nearly every macOS
     * app, and Caxri had left it unbound: no native menu role or Files binding claims it.
     */
    { key: 'cmd+n', command: 'session.create' },
    { key: 'cmd+t', command: 'terminal.new' },
    terminalCompleteAndSubmitKeybinding,
    /**
     * `Cmd+K` is reserved as the unconditional chord prefix, so Terminal Clear takes `Cmd+Shift+K` instead of VS Code's
     * `Cmd+K`. A chord prefix that only applies outside a Terminal would leave `Cmd+K Cmd+S` dead on Caxri's most
     * common focus target, and resolving the ambiguity the way VS Code does needs a full when-expression evaluator this
     * catalog deliberately does not have.
     *
     * `terminalFocus` is what keeps that move from shadowing Monaco's own `Cmd+Shift+K` (Delete Line): the command opts
     * into `allowInEditable`, so without the gate it would fire from the editor whenever the Session merely had a
     * Terminal. VS Code gates its Clear Terminal the same way. Clear Terminal stays reachable from the command palette,
     * the Terminal menu, and the Terminal context menu when focus is elsewhere.
     */
    { key: 'cmd+shift+k', command: 'terminal.clear', when: 'terminalFocus' },
    { key: 'cmd+c', command: 'terminal.copy' },
    { key: 'cmd+f', command: 'terminal.find' },
    {
        key: 'cmd+shift+o',
        command: 'terminal.openDetectedLink',
        when: 'terminalFocus',
    },
    { key: 'ctrl+tab', command: 'workbench.nextTab' },
    { key: 'ctrl+shift+tab', command: 'workbench.previousTab' },
    /**
     * `Cmd+Backquote` follows the macOS current-app window switching convention for Caxri's closest equivalent context:
     * Sessions inside its single window. `Ctrl+Tab` remains dedicated to Workbench tabs.
     */
    { key: 'cmd+`', command: 'session.switchMru' },
    /**
     * VS Code's `Ctrl+-` / `Ctrl+Shift+-` history chords are unavailable because these commands must fire while a
     * Terminal owns focus, where they would shadow the shell's own `Ctrl+_`.
     */
    { key: 'ctrl+alt+arrowleft', command: 'session.navigateBack' },
    { key: 'ctrl+alt+arrowright', command: 'session.navigateForward' },
    /**
     * `F2` is the rename chord in VS Code, Finder-adjacent file managers, and Windows Explorer alike, and it is the one
     * key the Session row's own `Enter` cannot be: `Enter` only exists while that row holds keyboard focus, so the
     * context menu had nothing real to advertise and the command palette could not offer Rename at all.
     */
    { key: 'f2', command: 'session.rename' },
    { key: 'cmd+shift+arrowup', command: 'terminal.previousCommand' },
    { key: 'cmd+shift+arrowdown', command: 'terminal.nextCommand' },
    { key: 'cmd+shift+r', command: 'terminal.restart' },
    /**
     * `Cmd+Shift+J` is the chord Orca spends on the same switch between an Agent's terminal and chat views. `Cmd+J`
     * already toggles the Panel, and the shifted letter keeps the two "view" toggles next to each other.
     */
    { key: 'cmd+shift+j', command: 'terminal.switchAgentSurface' },
    /**
     * The Chat composer's menus follow Cursor's Agent input: `Cmd+/` opens its model picker and `Cmd+.` its mode menu.
     * Claude Code and Codex cycle modes with `Shift+Tab`, which here moves focus out of the composer, so Plan gets the
     * free `Cmd+Option+P` instead. All three fire only while the active tab is a Chat that offers the menu, so an
     * editor's `Cmd+/` comment toggle and `Cmd+.` quick fix still reach the editor.
     */
    { key: 'cmd+/', command: 'agentChat.changeModel' },
    { key: 'cmd+.', command: 'agentChat.changePermissionMode' },
    { key: 'cmd+alt+p', command: 'agentChat.togglePlanMode' },
    /**
     * `Cmd+\` provides the requested iTerm2-style split-terminal behavior: preserve the active Terminal and open a
     * fresh Shell in a new pane to its right. The generic Split Right command remains available in the command palette
     * for moving an existing tab.
     */
    { key: 'cmd+\\', command: 'terminal.newInSplit' },
    /**
     * `Cmd+Option+Arrow` moves keyboard focus between panes, iTerm2 style. `Cmd+K` is the reserved chord prefix and
     * `Cmd+<number>` is taken by the Secondary Side Bar/Panel view-container shortcuts, so neither of VS Code's own
     * pane-navigation families is free here. `allowInEditable` lets the chord reach through a focused xterm: split view
     * is otherwise mouse-only while a Terminal owns focus.
     */
    { key: 'cmd+alt+arrowleft', command: 'workbench.focusPaneLeft' },
    { key: 'cmd+alt+arrowright', command: 'workbench.focusPaneRight' },
    { key: 'cmd+alt+arrowup', command: 'workbench.focusPaneUp' },
    { key: 'cmd+alt+arrowdown', command: 'workbench.focusPaneDown' },
    { key: 'cmd+w', command: 'workbench.closeActiveTab' },
    { key: 'cmd+s', command: 'editor.save' },
    /**
     * `Cmd+Alt+K` mirrors the "copy selection reference" chord used with VS Code agent extensions. It must fire while
     * Monaco owns focus, so the command opts into `allowInEditable`.
     */
    { key: 'cmd+alt+k', command: 'editor.sendReferenceToTerminal' },
    /**
     * `Cmd+Shift+M` was previously a Monaco-only shortcut registered directly by the Git diff review action, invisible
     * to Settings and the Command Palette. It must fire while Monaco owns focus, so the command opts into
     * `allowInEditable`.
     */
    { key: 'cmd+shift+m', command: 'editor.addReviewComment' },
    { key: 'cmd+shift+v', command: 'editor.openPreview' },
    /**
     * Matches VS Code's `Cmd+K V`, including its requirement to release Command before the second chord: the second
     * chord is bare `V`, so holding Command through it produces `Cmd+V` and resolves nothing.
     */
    { key: 'cmd+k v', command: 'editor.openPreviewToSide' },
    ...filesCoreKeybindings,
    { key: 'cmd+2', command: 'secondarySidebar.showGit' },
    { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
    /**
     * `cmd+shift+n` ("next Session needing attention") belongs to no view container. The obvious choice, the shifted
     * form of `session.switchMru`'s Command+Backquote, is unusable: on a US macOS layout Shift turns Backquote's
     * printable value into a tilde, so the chord never matches the stored one, and `resolveKeydownBinding`'s unshifted
     * fallback then hands that exact stroke to `session.switchMru` for reverse cycling.
     */
    { key: 'cmd+shift+n', command: 'session.focusNextAttention' },
    /**
     * `Cmd+Shift+S` reads as "Search Sessions" and is free here: Caxri's editor has no Save As, the chord VS Code
     * spends it on.
     */
    { key: 'cmd+shift+s', command: 'session.search' },
    { key: 'cmd+shift+1', command: 'panel.showLogs' },
    { key: 'cmd+shift+2', command: 'panel.showInfo' },
    { key: 'cmd+[', command: 'primarySidebar.toggle' },
    /**
     * `Cmd+0` matches VS Code's Focus into Primary Side Bar. Toggling the side bar visible has never moved focus into
     * it, so before this chord the Session tree was reachable only by Tabbing out of whatever owned focus, and a
     * focused Terminal swallows Tab.
     */
    { key: 'cmd+0', command: 'primarySidebar.focus' },
    /**
     * `Cmd+Alt+U` matches the chord the Codex desktop app spends on the same idea: swapping its left side bar between
     * the project tree and the queue of work waiting on you. The `cmd+<number>` run is spoken for by the Secondary Side
     * Bar's containers, and Activity is no longer one of them.
     */
    { key: 'cmd+alt+u', command: 'primarySidebar.toggleActivity' },
    { key: 'cmd+]', command: 'secondarySidebar.toggle' },
    /**
     * `Cmd+J` matches VS Code's Toggle Panel chord, which this region is modeled on.
     */
    { key: 'cmd+j', command: 'panel.toggle' },
    /**
     * `Cmd+=` / `Cmd+-` match VS Code and every browser. Reset Zoom stays unbound: VS Code's `Cmd+0` is Focus into
     * Primary Side Bar here too, and its `Cmd+Numpad0` cannot be expressed because bindings match `KeyboardEvent.key`,
     * which reports both zeros as `0`.
     */
    { key: 'cmd+=', command: 'view.zoomIn' },
    { key: 'cmd+-', command: 'view.zoomOut' },
    { key: 'cmd+,', command: 'settings.open' },
    { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
    /**
     * `Cmd+K Cmd+R` is VS Code's "Keyboard Shortcuts Reference" chord, next to its `Cmd+K Cmd+S` editor above. Claude
     * Code Desktop's `Cmd+/` is taken here by the Chat model picker, and `Cmd+Shift+/` is the macOS Help menu's own
     * search field, which the system claims before the app sees it.
     */
    { key: 'cmd+k cmd+r', command: 'help.showKeyboardShortcuts' },
    /**
     * `Cmd+Shift+B` is free in Caxri: VS Code spends it on the build-task chord, which has no Caxri equivalent. "B"
     * reads as the bug mnemonic, matching the Help menu's Report Bug to Agent item.
     */
    { key: 'cmd+shift+b', command: 'developer.reportBug' },
];

/**
 * Reviewed changes to defaults that existing keybinding files can adopt without overwriting custom choices.
 */
export const defaultKeybindingChanges = [
    {
        type: 'replace',
        previous: { key: 'cmd+1', command: 'inspector.showFiles' },
        current: { key: 'cmd+1', command: 'secondarySidebar.showFiles' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+2', command: 'inspector.showGit' },
        current: { key: 'cmd+2', command: 'secondarySidebar.showGit' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+3', command: 'inspector.showStatus' },
        current: { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+shift+u', command: 'bottomPanel.showLogs' },
        current: { key: 'cmd+shift+1', command: 'panel.showLogs' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+shift+y', command: 'bottomPanel.showInfo' },
        current: { key: 'cmd+shift+2', command: 'panel.showInfo' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+shift+f', command: 'inspector.searchFiles' },
        current: { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+[', command: 'sidebar.toggle' },
        current: { key: 'cmd+[', command: 'primarySidebar.toggle' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+]', command: 'inspector.toggle' },
        current: { key: 'cmd+]', command: 'secondarySidebar.toggle' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+j', command: 'bottomPanel.toggle' },
        current: { key: 'cmd+j', command: 'panel.toggle' },
    },
    {
        type: 'replace',
        previous: { key: 'alt+p', command: 'pathBrowser.open' },
        current: { key: 'cmd+p', command: 'pathBrowser.open' },
    },
    {
        type: 'replace',
        previous: { key: 'cmd+\\', command: 'workbench.splitRight' },
        current: { key: 'cmd+\\', command: 'terminal.newInSplit' },
    },
    {
        type: 'replace',
        previous: { key: 'ctrl+alt+tab', command: 'session.switchMru' },
        current: { key: 'cmd+`', command: 'session.switchMru' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
    },
    {
        type: 'add',
        binding: terminalCompleteAndSubmitKeybinding,
    },
    {
        type: 'add',
        binding: { key: 'cmd+alt+k', command: 'editor.sendReferenceToTerminal' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+shift+m', command: 'editor.addReviewComment' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+shift+b', command: 'developer.reportBug' },
    },
    {
        type: 'add',
        binding: { key: 'f2', command: 'session.rename' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+0', command: 'primarySidebar.focus' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+shift+n', command: 'session.focusNextAttention' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+alt+u', command: 'primarySidebar.toggleActivity' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+shift+j', command: 'terminal.switchAgentSurface' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+/', command: 'agentChat.changeModel' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+.', command: 'agentChat.changePermissionMode' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+alt+p', command: 'agentChat.togglePlanMode' },
    },
    /**
     * Terminal Clear has to vacate `Cmd+K` before the two chord bindings below can be added:
     * `reconcileDefaultKeybindings` treats a single-chord binding and a sequence opening on the same chord as one
     * occupied chord, so an existing `cmd+k` would otherwise reject them and leave the user without the new bindings.
     */
    {
        type: 'replace',
        previous: { key: 'cmd+k', command: 'terminal.clear' },
        current: { key: 'cmd+shift+k', command: 'terminal.clear', when: 'terminalFocus' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+k v', command: 'editor.openPreviewToSide' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+=', command: 'view.zoomIn' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+-', command: 'view.zoomOut' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+shift+s', command: 'session.search' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+n', command: 'session.create' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+k cmd+r', command: 'help.showKeyboardShortcuts' },
    },
] satisfies readonly DefaultKeybindingChange[];
