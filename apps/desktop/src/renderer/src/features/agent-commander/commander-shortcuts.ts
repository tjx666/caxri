import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@caxri/protocol';
import { shortcutLeadingChord } from '@caxri/protocol';

import type { PendingChord } from '../../commands/keystroke-resolution';
import { resolveKeystroke } from '../../commands/keystroke-resolution';
import { buildShortcutMap, isModifierKey, isTerminalEventTarget } from '../../lib/keybindings';
import { useDialogStore } from '../../stores/dialogs';
import { useWorkbenchStore } from '../../stores/workbench';
import { clearActiveTerminal, findInActiveTerminal } from '../terminal/terminal-commands';
import { openTerminalLinkPicker } from '../terminal/terminal-link-actions';
import { useAgentCommanderStore } from './commander-client';

/**
 * The commands this window runs from the keyboard: the Terminal actions its context menu offers. The native Edit menu
 * already owns Copy and Paste, and every other command belongs to the Workbench window.
 */
const COMMANDER_TERMINAL_COMMANDS = {
    'terminal.clear': clearActiveTerminal,
    'terminal.find': findInActiveTerminal,
    'terminal.openDetectedLink': openTerminalLinkPicker,
} satisfies Partial<Record<CommandId, (terminalId: string) => void>>;

type CommanderTerminalCommand = keyof typeof COMMANDER_TERMINAL_COMMANDS;

function isCommanderTerminalCommand(command: string): command is CommanderTerminalCommand {
    return Object.hasOwn(COMMANDER_TERMINAL_COMMANDS, command);
}

export interface CommanderShortcutState {
    keybindings: readonly Keybinding[] | undefined;
    leadingChords: ReadonlySet<string>;
    pending: PendingChord | undefined;
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>;
}

export function createCommanderShortcutState(): CommanderShortcutState {
    return {
        keybindings: undefined,
        leadingChords: new Set(),
        pending: undefined,
        shortcutMap: new Map(),
    };
}

/**
 * Runs one keystroke against the Commander Terminal. The Workbench's chord state machine resolves it against the user's
 * keybindings narrowed to {@link COMMANDER_TERMINAL_COMMANDS}, so a rebound chord follows the user and any other chord,
 * including the start of another command's sequence, reaches the focused surface untouched.
 */
export function dispatchCommanderKeydown(
    state: CommanderShortcutState,
    event: KeyboardEvent,
    terminalId: string | undefined,
): void {
    if (!terminalId || event.isComposing || isModifierKey(event.key)) return;
    const keybindings = useWorkbenchStore.getState().bootstrap?.keybindings;
    if (!keybindings) return;
    if (keybindings !== state.keybindings) {
        const admitted = keybindings.filter(({ command }) => isCommanderTerminalCommand(command));
        state.keybindings = keybindings;
        state.shortcutMap = buildShortcutMap(admitted);
        /**
         * Only the admitted bindings open a sequence. The Workbench also reserves `Cmd+K` for Monaco's sequences, but
         * this window has no editor, and reserving it would swallow the key typed after `Cmd+K` in the Terminal.
         */
        state.leadingChords = new Set(
            admitted.flatMap(({ key }) => shortcutLeadingChord(key) ?? []),
        );
    }
    const outcome = resolveKeystroke({
        // The Commander window has no editor to hand a sequence to.
        editorFocus: false,
        event,
        leadingChords: state.leadingChords,
        pending: state.pending,
        shortcutMap: state.shortcutMap,
        terminalFocus: isTerminalEventTarget(event.target),
    });
    state.pending = undefined;
    if (outcome.kind === 'ignore' || outcome.kind === 'yieldChordContinuation') return;
    event.preventDefault();
    event.stopPropagation();
    if (outcome.kind === 'armChord') {
        state.pending = { leadingChord: outcome.leadingChord, yieldToEditor: false };
        return;
    }
    if (outcome.kind === 'cancelChord' || useDialogStore.getState().isModalOpen()) return;
    const { command } = outcome.binding;
    if (isCommanderTerminalCommand(command)) COMMANDER_TERMINAL_COMMANDS[command](terminalId);
}

/**
 * Mounts the Commander window's keyboard dispatch. The Workbench's `useCommandShortcuts` is not mounted here: it runs
 * the Workbench command registry, whose Terminal commands resolve the active Terminal from a pane layout this window
 * does not have. Terminal chords such as `Cmd+F` are Renderer-owned (no native menu accelerator), so without this they
 * would do nothing in this window.
 */
export function useCommanderShortcuts(): void {
    useEffect(() => {
        const state = createCommanderShortcutState();
        const onKeyDown = (event: KeyboardEvent): void =>
            dispatchCommanderKeydown(
                state,
                event,
                useAgentCommanderStore.getState().identity?.terminalId,
            );
        /**
         * Same rule as the Workbench: a click or leaving the window ends a half-typed sequence.
         */
        const cancelPendingChord = (): void => {
            state.pending = undefined;
        };
        addEventListener('keydown', onKeyDown, { capture: true });
        addEventListener('mousedown', cancelPendingChord, { capture: true });
        addEventListener('blur', cancelPendingChord);
        return () => {
            removeEventListener('keydown', onKeyDown, { capture: true });
            removeEventListener('mousedown', cancelPendingChord, { capture: true });
            removeEventListener('blur', cancelPendingChord);
        };
    }, []);
}
