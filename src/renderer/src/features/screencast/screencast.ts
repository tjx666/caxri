import { create } from 'zustand';

import { commandDefinitions } from '@shared/commands';
import type { Keybinding } from '@shared/types';

import { buildShortcutMap, keyboardEventShortcut } from '../../lib/keybindings';

export interface ScreencastKeyboardInput {
    altKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
}

interface ScreencastKeyOptions {
    commandAllowsEditable(commandId: string): boolean;
    editable: boolean;
}

export interface ScreencastKeyDescription {
    commandTitle?: string;
    shortcut: string;
}

const modifierKeys = new Set([
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Fn',
    'FnLock',
    'Meta',
    'NumLock',
    'ScrollLock',
    'Shift',
    'Super',
    'Symbol',
    'SymbolLock',
]);

/**
 * Converts only privacy-safe key events into overlay copy. Printable text never receives a generic
 * fallback: it is visible only when it resolves to a registered Caxri command, so Terminal, form,
 * password, and IME input cannot leak through Screencast Mode.
 */
export function describeScreencastKey(
    event: ScreencastKeyboardInput,
    keybindings: readonly Keybinding[],
    options: ScreencastKeyOptions,
): ScreencastKeyDescription | undefined {
    if (
        event.isComposing ||
        event.key === 'Dead' ||
        event.key === 'Process' ||
        event.key === 'Unidentified' ||
        modifierKeys.has(event.key) ||
        (event.key.length === 1 && !event.metaKey && !event.ctrlKey)
    )
        return undefined;

    const shortcut = keyboardEventShortcut(event as KeyboardEvent);
    const commandId = buildShortcutMap([...keybindings]).get(shortcut);
    if (commandId) {
        const command = commandDefinitions.find((definition) => definition.id === commandId);
        if (!command || (options.editable && !options.commandAllowsEditable(commandId)))
            return undefined;
        return { commandTitle: command.title, shortcut };
    }

    if (options.editable || event.key.length === 1) return undefined;
    return { shortcut };
}

interface ScreencastState {
    enabled: boolean;
    toggle(): void;
}

/** Window-local by design: this store has no persistence or Runtime synchronization. */
export const useScreencastStore = create<ScreencastState>((set) => ({
    enabled: false,
    toggle: () => set((state) => ({ enabled: !state.enabled })),
}));

export function toggleScreencastMode(): void {
    useScreencastStore.getState().toggle();
}
