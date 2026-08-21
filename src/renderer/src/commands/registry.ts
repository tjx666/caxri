import type { BottomPanelView, CommandId, InspectorMode } from '@shared/types';

import type { SettingsView } from '../stores/dialogs';

/**
 * Everything a command may reach. Passing this in keeps command `run` functions free of module-level bindings to the
 * feature actions, so a test can drive the registry with fakes.
 */
export interface CommandContext {
    project: {
        create(): void;
        customizeIcon(projectId?: string): void;
        openInExternalEditor(): void;
        removeSelected(): void;
    };
    session: {
        create(): void;
        deleteSelected(): void;
        selectAdjacent(delta: 1 | -1): void;
        switchMru(invocation?: SessionMruShortcutInvocation): void;
    };
    terminal: {
        create(): void;
        clearActive(): void;
        copySelection(): void;
        findActive(): void;
        hasActive(): boolean;
        /**
         * True only when the active work item is a Terminal that currently owns a selection.
         */
        hasSelection(): boolean;
        navigateCommand(direction: 1 | -1): void;
        restartActive(): void;
        startNewAgentSession(): void;
        closeActive(): void;
    };
    workbench: { closeActiveTab(): void; cycleTab(delta: 1 | -1): void };
    editor: {
        saveActive(): void;
        /**
         * True only when the active work item is an Editor tab whose owning split group can grow (not a single-tab
         * group showing only that path). Matches the split commands' `when` gate.
         */
        canSplitActive(): boolean;
        splitActive(direction: 'left' | 'right' | 'up' | 'down'): void;
    };
    inspector: { searchFiles(): void; activateMode(mode: InspectorMode): void; toggle(): void };
    bottomPanel: { activateView(view: BottomPanelView): void; toggle(): void };
    sidebar: { toggle(): void };
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
