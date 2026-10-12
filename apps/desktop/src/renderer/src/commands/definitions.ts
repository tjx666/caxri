import type { CommandId } from '@caxri/protocol';
import { getCommandDefinition } from '@caxri/protocol';

import type { CommandContext, CommandDefinition, SessionMruShortcutInvocation } from './registry';
import { defineCommand, registerCommand } from './registry';

const SESSION_MRU_MODIFIERS: ReadonlySet<unknown> = new Set(['Alt', 'Control', 'Meta', 'Shift']);

/**
 * Builds a registry entry whose title/category are read from the shared catalog, so the catalog stays the single source
 * of truth for id/title/category and the two tables cannot drift apart.
 */
function fromCatalog(
    id: CommandId,
    run: (context: CommandContext, arguments_?: unknown) => void,
    extra?: Partial<
        Pick<CommandDefinition, 'allowBehindModal' | 'allowInEditable' | 'confirm' | 'when'>
    >,
): CommandDefinition {
    const catalog = getCommandDefinition(id);
    return defineCommand({ id, title: catalog.title, category: catalog.category, run, ...extra });
}

function sessionMruInvocation(arguments_: unknown): SessionMruShortcutInvocation | undefined {
    if (!arguments_ || typeof arguments_ !== 'object' || !('shortcut' in arguments_)) return;
    const shortcut = arguments_.shortcut;
    if (!shortcut || typeof shortcut !== 'object') return;
    if (!('triggerCode' in shortcut) || typeof shortcut.triggerCode !== 'string') return;
    if (!('heldModifiers' in shortcut) || !Array.isArray(shortcut.heldModifiers)) return;
    if (!('direction' in shortcut) || (shortcut.direction !== 1 && shortcut.direction !== -1))
        return;
    const heldModifiers = shortcut.heldModifiers.filter(
        (modifier): modifier is SessionMruShortcutInvocation['heldModifiers'][number] =>
            SESSION_MRU_MODIFIERS.has(modifier),
    );
    return { direction: shortcut.direction, heldModifiers, triggerCode: shortcut.triggerCode };
}

function projectIdArgument(arguments_: unknown): string | undefined {
    if (!arguments_ || typeof arguments_ !== 'object' || !('projectId' in arguments_)) return;
    return typeof arguments_.projectId === 'string' ? arguments_.projectId : undefined;
}

/**
 * Matches VS Code's `sendText` contract: configured newlines mean Return, while the lower-level `terminal.input` path
 * remains byte-preserving for Ctrl+J and multiline input.
 * https://github.com/microsoft/vscode/blob/cd429513258458bcbe37b17fe714874197fe2adf/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts#L1396-L1412
 */
function terminalSequenceArgument(arguments_: unknown): string | undefined {
    if (!arguments_ || typeof arguments_ !== 'object' || !('text' in arguments_)) return;
    return typeof arguments_.text === 'string'
        ? arguments_.text.replaceAll(/\r?\n/g, '\r')
        : undefined;
}

/**
 * The command table. Populated once as a module side effect; `commands/execute.ts` imports this module so every id in
 * the shared catalog has a matching registry entry before the app runs.
 */
export const commandDefinitions: CommandDefinition[] = [
    fromCatalog('agentActions.open', (context) => context.agentActions.open(), {
        allowInEditable: true,
        when: (context) => context.agentActions.canOpen(),
    }),
    /**
     * The Chat composer's menus and plan toggle fire from its focused input, the surface they serve. Elsewhere,
     * including an editor where `Cmd+/` and `Cmd+.` mean something else, `when` is false and the key falls through
     * untouched.
     */
    fromCatalog('agentChat.changeModel', (context) => context.agentChat.run('changeModel'), {
        allowInEditable: true,
        when: (context) => context.agentChat.canRun('changeModel'),
    }),
    fromCatalog(
        'agentChat.changePermissionMode',
        (context) => context.agentChat.run('changePermissionMode'),
        {
            allowInEditable: true,
            when: (context) => context.agentChat.canRun('changePermissionMode'),
        },
    ),
    fromCatalog('agentChat.togglePlanMode', (context) => context.agentChat.run('togglePlanMode'), {
        allowInEditable: true,
        when: (context) => context.agentChat.canRun('togglePlanMode'),
    }),
    /**
     * `Cmd+O` must work from anywhere, including a focused Terminal or editor: it opens a native folder dialog and
     * types nothing into the editable surface.
     */
    fromCatalog('project.create', (context) => context.project.create(), {
        allowInEditable: true,
    }),
    fromCatalog(
        'project.delete',
        (context, arguments_) => context.project.remove(projectIdArgument(arguments_)),
        /**
         * The native confirm dialog (naming the Project, "files on disk are not touched") already runs in Main before
         * `project.delete` resolves; this flag only documents that contract.
         */
        { confirm: true },
    ),
    fromCatalog('project.hide', (context) => context.project.hideSelected()),
    fromCatalog('project.openInEditor', (context) => context.project.openInExternalEditor(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('project.customizeIcon', (context, arguments_) =>
        context.project.customizeIcon(projectIdArgument(arguments_)),
    ),
    fromCatalog('session.create', (context) => context.session.create()),
    fromCatalog(
        'session.delete',
        (context) => context.session.deleteSelected(),
        /**
         * Same native-confirm contract as `project.delete`, enforced in Main.
         */
        { confirm: true },
    ),
    fromCatalog('session.rename', (context) => context.session.renameSelected()),
    fromCatalog('session.renameWithAi', (context) => context.session.renameSelectedWithAi()),
    fromCatalog('session.archive', (context) => context.session.archiveSelected()),
    fromCatalog('session.compactWarm', (context) => context.session.compactWarm()),
    fromCatalog('session.detach', (context) => context.session.detachSelected()),
    fromCatalog('session.resume', (context) => context.session.resumeSelected()),
    fromCatalog('session.openPullRequest', (context) => context.session.openPullRequestSelected()),
    fromCatalog('session.selectNext', (context) => context.session.selectAdjacent(1)),
    fromCatalog('session.selectPrevious', (context) => context.session.selectAdjacent(-1)),
    fromCatalog(
        'session.switchMru',
        (context, arguments_) => context.session.switchMru(sessionMruInvocation(arguments_)),
        { allowInEditable: true },
    ),
    /**
     * Both directions reach through a focused Terminal (history navigation is worthless if it stands down exactly where
     * the cursor usually is) and stay unavailable while their stack is empty, so the chord falls through to the
     * Terminal instead of being swallowed by a command that would do nothing.
     */
    fromCatalog('session.navigateBack', (context) => context.session.navigateHistory('back'), {
        allowInEditable: true,
        when: (context) => context.session.canNavigateHistory('back'),
    }),
    fromCatalog(
        'session.navigateForward',
        (context) => context.session.navigateHistory('forward'),
        {
            allowInEditable: true,
            when: (context) => context.session.canNavigateHistory('forward'),
        },
    ),
    fromCatalog('session.searchContent', (context) => context.dialogs.openSessionContentSearch(), {
        allowInEditable: true,
    }),
    fromCatalog('session.openArchived', (context) => context.session.openArchived(), {
        allowInEditable: true,
    }),
    /**
     * Reaches through a focused Terminal: the Session you are leaving is almost always an Agent Terminal, which is
     * exactly the state this chord exists to escape.
     */
    fromCatalog('session.focusNextAttention', (context) => context.session.focusNextAttention(), {
        allowInEditable: true,
    }),
    fromCatalog('terminal.new', (context) => context.terminal.create(), { allowInEditable: true }),
    fromCatalog('terminal.newInSplit', (context) => context.terminal.createInSplit(), {
        allowInEditable: true,
    }),
    fromCatalog('terminal.clear', (context) => context.terminal.clearActive(), {
        allowInEditable: true,
        /**
         * With no Terminal to clear the keybinding falls through untouched instead of being swallowed.
         */
        when: (context) => context.terminal.hasActive(),
    }),
    /**
     * `Cmd+C` is gated on a live Terminal selection rather than merely on an active Terminal: with no selection the
     * chord must fall through untouched so Monaco, inputs, and the browser's own copy handling keep working.
     */
    fromCatalog('terminal.copy', (context) => context.terminal.copySelection(), {
        allowInEditable: true,
        when: (context) => context.terminal.hasSelection(),
    }),
    fromCatalog('terminal.find', (context) => context.terminal.findActive(), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog('terminal.openDetectedLink', (context) => context.terminal.openDetectedLink(), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog('terminal.previousCommand', (context) => context.terminal.navigateCommand(-1), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog('terminal.nextCommand', (context) => context.terminal.navigateCommand(1), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog(
        'workbench.action.terminal.sendSequence',
        (context, arguments_) => {
            const text = terminalSequenceArgument(arguments_);
            if (text !== undefined) context.terminal.sendSequence(text);
        },
        {
            allowInEditable: true,
            when: (context) => context.terminal.hasActive(),
        },
    ),
    fromCatalog('terminal.restart', (context) => context.terminal.restartActive()),
    fromCatalog('terminal.startNewAgentSession', (context) =>
        context.terminal.startNewAgentSession(),
    ),
    /**
     * Fires from a focused Terminal grid or Chat composer, the two surfaces it switches between.
     */
    fromCatalog(
        'terminal.switchAgentSurface',
        (context) => context.terminal.switchActiveSurface(),
        {
            allowInEditable: true,
            when: (context) => context.terminal.canSwitchActiveSurface(),
        },
    ),
    fromCatalog('terminal.showAgentStatus', (context) => context.terminal.showActiveAgentStatus(), {
        when: (context) => context.terminal.isActiveAgent(),
    }),
    fromCatalog('terminal.close', (context) => context.terminal.closeActive(), {
        allowInEditable: true,
    }),
    fromCatalog('workbench.closeActiveTab', (context) => context.workbench.closeActiveTab(), {
        allowInEditable: true,
    }),
    fromCatalog('workbench.nextTab', (context) => context.workbench.cycleTab(1), {
        allowInEditable: true,
    }),
    fromCatalog('workbench.previousTab', (context) => context.workbench.cycleTab(-1), {
        allowInEditable: true,
    }),
    fromCatalog('editor.save', (context) => context.editor.saveActive(), { allowInEditable: true }),
    /**
     * Fires from inside Monaco, so it must reach through an editable target like `editor.save`.
     */
    fromCatalog(
        'editor.sendReferenceToTerminal',
        (context) => context.editor.sendReferenceToTerminal(),
        {
            allowInEditable: true,
            when: (context) => context.editor.canSendReferenceToTerminal(),
        },
    ),
    fromCatalog('editor.addReviewComment', (context) => context.editor.addReviewComment(), {
        allowInEditable: true,
        when: (context) => context.editor.canAddReviewComment(),
    }),
    /**
     * `allowInEditable` so the chord fires while Monaco owns focus: opening the preview of the file you are editing is
     * the entire point, and the source editor is where the caret almost always is.
     */
    fromCatalog('editor.openPreview', (context) => context.editor.openPreview(), {
        allowInEditable: true,
        when: (context) => context.editor.canOpenPreview(),
    }),
    fromCatalog('editor.openPreviewToSide', (context) => context.editor.openPreviewToSide(), {
        allowInEditable: true,
        when: (context) => context.editor.canOpenPreview(),
    }),
    // A split is a pane operation, so the direction only chooses the split axis and which side the new pane takes.
    ...(
        [
            ['workbench.splitLeft', 'left'],
            ['workbench.splitRight', 'right'],
            ['workbench.splitUp', 'up'],
            ['workbench.splitDown', 'down'],
        ] as const
    ).map(([id, side]) =>
        fromCatalog(id, (context) => context.workbench.splitActive(side), {
            when: (context) => context.workbench.canSplitActive(),
        }),
    ),
    /**
     * `allowInEditable` lets pane-focus movement reach through a focused xterm, matching iTerm2: split view is
     * otherwise mouse-only while a Terminal owns focus.
     */
    ...(
        [
            ['workbench.focusPaneLeft', 'left'],
            ['workbench.focusPaneRight', 'right'],
            ['workbench.focusPaneUp', 'up'],
            ['workbench.focusPaneDown', 'down'],
        ] as const
    ).map(([id, direction]) =>
        fromCatalog(id, (context) => context.workbench.focusPaneInDirection(direction), {
            allowInEditable: true,
            when: (context) => context.workbench.canFocusPaneInDirection(direction),
        }),
    ),
    fromCatalog(
        'workbench.moveActiveTerminalToNewSession',
        (context) => context.workbench.moveActiveTerminalToNewSession(),
        { when: (context) => context.workbench.canMoveActiveTerminalToNewSession() },
    ),
    fromCatalog('secondarySidebar.toggle', (context) => context.secondarySidebar.toggle(), {
        allowInEditable: true,
    }),
    fromCatalog('panel.showLogs', (context) => context.panel.activateViewContainer('caxri.logs'), {
        allowInEditable: true,
    }),
    fromCatalog('panel.showInfo', (context) => context.panel.activateViewContainer('caxri.info'), {
        allowInEditable: true,
    }),
    fromCatalog('panel.toggle', (context) => context.panel.toggle(), {
        allowInEditable: true,
    }),
    fromCatalog('primarySidebar.toggle', (context) => context.primarySidebar.toggle(), {
        allowInEditable: true,
    }),
    fromCatalog(
        'primarySidebar.toggleActivity',
        (context) => context.primarySidebar.toggleActivityMode(),
        { allowInEditable: true },
    ),
    /**
     * Reaches through a focused Terminal on purpose: xterm swallows Tab, so a Terminal is exactly the state this
     * command exists to escape.
     */
    fromCatalog('primarySidebar.focus', (context) => context.primarySidebar.focus(), {
        allowInEditable: true,
    }),
    ...(
        [
            ['view.zoomIn', 'in'],
            ['view.zoomOut', 'out'],
            ['view.resetZoom', 'reset'],
        ] as const
    ).map(([id, step]) =>
        fromCatalog(id, (context) => context.windows.zoom(step), {
            allowBehindModal: true,
            allowInEditable: true,
        }),
    ),
    fromCatalog('usage.open', (context) => context.dialogs.openUsage(), {
        allowInEditable: true,
    }),
    fromCatalog('settings.open', (context) => context.dialogs.openSettings(), {
        allowInEditable: true,
    }),
    fromCatalog(
        'settings.openNotifications',
        (context) => context.dialogs.openSettings('notifications'),
        {
            allowInEditable: true,
        },
    ),
    fromCatalog('settings.openSource', (context) => context.dialogs.openSettings('source'), {
        allowInEditable: true,
    }),
    fromCatalog(
        'settings.openKeybindings',
        (context) => context.dialogs.openSettings('keybindings'),
        {
            allowInEditable: true,
        },
    ),
    fromCatalog(
        'settings.manageTrustedDomains',
        (context) => context.dialogs.openSettings('trusted-domains'),
        { allowInEditable: true },
    ),
    fromCatalog('updates.check', (context) => context.updates.check()),
    fromCatalog('shellCommand.install', (context) => context.shellCommand.install(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('shellCommand.uninstall', (context) => context.shellCommand.uninstall(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('pathBrowser.open', (context) => context.dialogs.openPathBrowser(), {
        allowInEditable: true,
    }),
    fromCatalog('commandPalette.open', (context) => context.dialogs.openPalette(), {
        allowInEditable: true,
    }),
    /*
     * Declared in the shared catalog as a Files view-container command, but handled here: `executeCommand` prefers a
     * Renderer registration and only falls through to the view catalog when none exists. That fallthrough is exactly
     * what has to be avoided: `didExecuteViewCatalogCommand` reveals a command's owning view container before
     * dispatching it, so leaving this to the catalog would pop the Files sidebar open every time the overlay opened.
     * Registering it here keeps the catalog entry, the `cmd+shift+f` default, and the recorded keybinding migration
     * history untouched while the command itself now opens a surface that belongs to no view container.
     */
    fromCatalog('secondarySidebar.searchFiles', (context) => context.dialogs.openProjectSearch(), {
        allowInEditable: true,
    }),
    fromCatalog('processExplorer.open', (context) => context.windows.openProcessExplorer(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('agentCommander.open', (context) => context.windows.openAgentCommander(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('agentCommander.stop', (context) => context.windows.stopAgentCommander(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('agentCommander.handOver', (context) => context.dialogs.openCommanderHandover(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog(
        'agentCommander.takeBack',
        (context) => context.session.takeBackSelectedFromCommander(),
        { when: (context) => context.remote.isLocalOnlyAvailable() },
    ),
    fromCatalog(
        'developer.toggleScreencastMode',
        (context) => context.developer.toggleScreencastMode(),
        {
            allowInEditable: true,
        },
    ),
    fromCatalog('developer.reportBug', (context) => context.developer.reportBug(), {
        allowInEditable: true,
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('diagnostics.export', (context) => context.diagnostics.export(), {
        when: (context) => context.remote.isLocalOnlyAvailable(),
    }),
    fromCatalog('remote.connect', (context) => context.remote.connect(), {
        allowInEditable: true,
    }),
    fromCatalog('remote.reconnect', (context) => context.remote.reconnect(), {
        when: (context) => context.remote.isRemote(),
    }),
    fromCatalog('remote.stopServer', (context) => context.remote.stopServer(), {
        when: (context) => context.remote.isRemote(),
    }),
    fromCatalog('editor.openImportLink', (context) => context.editor.openImportLink(), {
        allowInEditable: true,
        when: (context) => context.editor.canOpenImportLink(),
    }),
    fromCatalog('workbench.selectRoot', (context) => context.workbench.selectRoot(), {
        when: (context) => context.workbench.canSelectRoot(),
    }),
    fromCatalog('git.switchBranch', (context) => context.git.switchBranch(), {
        when: (context) => context.git.canSwitchBranch(),
    }),
    fromCatalog('git.goToNextReviewComment', (context) => context.git.goToNextReviewComment(), {
        when: (context) => context.git.canGoToReviewComment(),
    }),
    fromCatalog(
        'git.goToPreviousReviewComment',
        (context) => context.git.goToPreviousReviewComment(),
        { when: (context) => context.git.canGoToReviewComment() },
    ),
    fromCatalog('git.showPendingReviewComments', (context) =>
        context.git.showPendingReviewComments(),
    ),
];

for (const definition of commandDefinitions) registerCommand(definition);
