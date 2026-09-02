import type { CommandId, ViewContainerId } from '@caxri/protocol';

import type { SessionNavigationDirection } from '../features/session/session-navigation-history';
import type { SettingsView } from '../stores/dialogs';

/**
 * Everything a command may reach. Passing this in keeps command `run` functions free of module-level bindings to the
 * feature actions, so a test can drive the registry with fakes.
 */
export interface CommandContext {
    agentActions: {
        canOpen(): boolean;
        open(): void;
    };
    project: {
        create(): void;
        customizeIcon(projectId?: string): void;
        openInExternalEditor(): void;
        removeSelected(): void;
    };
    session: {
        archiveSelected(): void;
        canNavigateHistory(direction: SessionNavigationDirection): boolean;
        create(): void;
        deleteSelected(): void;
        detachSelected(): void;
        navigateHistory(direction: SessionNavigationDirection): void;
        resumeSelected(): void;
        selectAdjacent(delta: 1 | -1): void;
        switchMru(invocation?: SessionMruShortcutInvocation): void;
    };
    terminal: {
        create(): void;
        clearActive(): void;
        copySelection(): void;
        findActive(): void;
        openDetectedLink(): void;
        hasActive(): boolean;
        /**
         * True only when the active work item is a Terminal that currently owns a selection.
         */
        hasSelection(): boolean;
        navigateCommand(direction: 1 | -1): void;
        sendSequence(text: string): void;
        restartActive(): void;
        startNewAgentSession(): void;
        closeActive(): void;
    };
    workbench: {
        closeActiveTab(): void;
        cycleTab(delta: 1 | -1): void;
        /**
         * True only when the active pane holds more than one tab, since splitting the last tab out of a pane would
         * leave that pane empty. Matches the split commands' `when` gate.
         */
        canSplitActive(): boolean;
        splitActive(side: 'down' | 'left' | 'right' | 'up'): void;
        /**
         * True only when moving keyboard focus in `direction` would land on a different pane. Matches the focus
         * commands' `when` gate, so the palette never offers a move that would silently no-op at a single pane or the
         * edge of the Workbench.
         */
        canFocusPaneInDirection(direction: 'down' | 'left' | 'right' | 'up'): boolean;
        focusPaneInDirection(direction: 'down' | 'left' | 'right' | 'up'): void;
        /**
         * True only when the active tab is a Terminal that is not its Session's only Terminal — the same disabled
         * reason the tab's context menu shows for "Move to New Session".
         */
        canMoveActiveTerminalToNewSession(): boolean;
        moveActiveTerminalToNewSession(): void;
    };
    editor: { saveActive(): void };
    secondarySidebar: {
        activateViewContainer(id: ViewContainerId): void;
        toggle(): void;
    };
    panel: { activateViewContainer(id: ViewContainerId): void; toggle(): void };
    primarySidebar: { toggle(): void };
    dialogs: {
        openSettings(view?: SettingsView): void;
        openPalette(): void;
        openPathBrowser(): void;
    };
    windows: { openProcessExplorer(): void };
    developer: { reportBug(): void; toggleScreencastMode(): void };
    diagnostics: { export(): void };
    updates: { check(): void };
}

export interface SessionMruShortcutInvocation {
    direction: 1 | -1;
    heldModifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
    triggerCode: string;
}

export interface CommandDefinition {
    id: CommandId;
    title: string;
    category: string;
    /**
     * Executes the command against the active {@link CommandContext}.
     */
    run(context: CommandContext, arguments_?: unknown): void;
    /**
     * Optional gate; a command whose `when` reports false is treated as a no-op.
     */
    when?(context: CommandContext): boolean;
    /**
     * Keeps the command reachable from its keybinding while an editable target (input, textarea, Monaco, xterm) owns
     * focus. Defaults to false: shortcuts stand down while the user is typing.
     */
    allowInEditable?: boolean;
    /**
     * Marks a destructive command whose confirmation is already handled inside `run` (native dialog).
     */
    confirm?: boolean;
}

/**
 * Identity helper that keeps definition modules declarative while still type-checking the shape.
 */
export function defineCommand(definition: CommandDefinition): CommandDefinition {
    return definition;
}

const registry = new Map<CommandId, CommandDefinition>();

export function registerCommand(definition: CommandDefinition): void {
    registry.set(definition.id, definition);
}

export function getRegisteredCommand(id: string): CommandDefinition | undefined {
    return registry.get(id as CommandId);
}
