import type { Keybinding } from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { commandTitle } from '../../lib/command-labels';
import { isImeComposing } from '../../lib/ime';
import {
    buildShortcutMap,
    keyboardEventShortcut,
    resolveShortcutBinding,
} from '../../lib/keybindings';
import { createStore } from '../../lib/store';
import { pushToast } from '../../stores/toasts';

export interface ScreencastKeyboardInput {
    altKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    key: string;
    keyCode: number;
    metaKey: boolean;
    shiftKey: boolean;
}

interface ScreencastKeyOptions {
    commandAllowsEditable(commandId: string): boolean;
    editable: boolean;
    /**
     * The chord this keystroke continues, when dispatch had one armed. Without it the second key of `Cmd+K Cmd+S`
     * resolves as the unrelated single-chord `Cmd+S` and the overlay captions the wrong command.
     */
    leadingChord?: string;
    terminalFocus: boolean;
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
 * Converts only privacy-safe key events into overlay copy. Printable text never receives a generic fallback: it is
 * visible only when it resolves to a registered Caxri command, so Terminal, form, password, and IME input cannot leak
 * through Screencast Mode.
 */
export function describeScreencastKey(
    event: ScreencastKeyboardInput,
    keybindings: readonly Keybinding[],
    options: ScreencastKeyOptions,
    t: Translate = translate,
): ScreencastKeyDescription | undefined {
    if (
        isImeComposing(event) ||
        event.key === 'Dead' ||
        event.key === 'Process' ||
        event.key === 'Unidentified' ||
        modifierKeys.has(event.key) ||
        (event.key.length === 1 && !event.metaKey && !event.ctrlKey)
    )
        return undefined;

    const chord = keyboardEventShortcut(event as KeyboardEvent);
    const shortcut = options.leadingChord ? `${options.leadingChord} ${chord}` : chord;
    const binding = resolveShortcutBinding(buildShortcutMap(keybindings), shortcut, {
        terminalFocus: options.terminalFocus,
    });
    if (binding) {
        const commandId = binding.command;
        const command = commandDefinitions.find((definition) => definition.id === commandId);
        if (!command || (options.editable && !options.commandAllowsEditable(commandId)))
            return undefined;
        return { commandTitle: commandTitle(command, t), shortcut };
    }

    if (options.editable || event.key.length === 1) return undefined;
    return { shortcut };
}

interface ScreencastState {
    enabled: boolean;
    toggle(): void;
}

/**
 * Window-local by design: this store has no persistence or Server synchronization.
 */
export const useScreencastStore = createStore<ScreencastState>('screencast', (set) => ({
    enabled: false,
    toggle: () => set((state) => ({ enabled: !state.enabled })),
}));

/**
 * Pure so message selection stays independent of notification rendering.
 */
export function screencastToggleToastMessage(isEnabled: boolean): string {
    return translate(isEnabled ? 'screencast.toast.on' : 'screencast.toast.off');
}

/**
 * The overlay's ripples are the only in-context feedback while Screencast Mode is active, and they only appear after a
 * click or keystroke; the toggle itself was previously silent. A toast confirms the transition immediately; the
 * persistent status-bar chip (see `screencast-mode-chip.tsx`) covers the rest of the active session.
 */
export function toggleScreencastMode(): void {
    useScreencastStore.getState().toggle();
    const isEnabled = useScreencastStore.getState().enabled;
    pushToast('info', screencastToggleToastMessage(isEnabled));
}
