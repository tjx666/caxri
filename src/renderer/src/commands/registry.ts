import type { InspectorMode } from '@shared/types';

/**
 * Everything a command may reach. Passing this in keeps command `run` functions free of
 * module-level bindings to the feature actions, so a test can drive the registry with fakes.
 */
export interface CommandContext {
    project: { create(): void; removeSelected(): void };
    session: { create(): void; deleteSelected(): void; selectAdjacent(delta: 1 | -1): void };
    terminal: { create(): void; clearActive(): void; restartActive(): void; closeActive(): void };
    workbench: { closeActiveTab(): void };
    editor: { saveActive(): void };
    inspector: { searchFiles(): void; setMode(mode: InspectorMode): void; toggle(): void };
    sidebar: { toggle(): void };
    dialogs: { openSettings(): void; openPalette(): void; openPathBrowser(): void };
    windows: { openProcessExplorer(): void };
    diagnostics: { export(): void };
    updates: { check(): void };
}

export interface CommandDefinition {
    id: string;
    title: string;
    category: string;
    /** Executes the command against the active {@link CommandContext}. */
    run(ctx: CommandContext, args?: unknown): void;
    /** Optional gate; a command whose `when` reports false is treated as a no-op. */
    when?(ctx: CommandContext): boolean;
    /**
     * Keeps the command reachable from its keybinding while an editable target (input, textarea,
     * Monaco, xterm) owns focus. Defaults to false: shortcuts stand down while the user is typing.
     */
    allowInEditable?: boolean;
    /** Marks a destructive command whose confirmation is already handled inside `run` (native dialog). */
    confirm?: boolean;
}

/** Identity helper that keeps definition modules declarative while still type-checking the shape. */
export function defineCommand(definition: CommandDefinition): CommandDefinition {
    return definition;
}

const registry = new Map<string, CommandDefinition>();

export function registerCommand(definition: CommandDefinition): void {
    registry.set(definition.id, definition);
}

export function getRegisteredCommand(id: string): CommandDefinition | undefined {
    return registry.get(id);
}
