import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@caxri/protocol';
import { shortcutLeadingChord } from '@caxri/protocol';

import type { PendingChord } from '../../commands/keystroke-resolution';
import { resolveKeystroke } from '../../commands/keystroke-resolution';
import { isImeComposing } from '../../lib/ime';
import {
    buildShortcutMap,
    isEditableEventTarget,
    isModifierKey,
    isTerminalEventTarget,
} from '../../lib/keybindings';
import { useDialogStore } from '../../stores/dialogs';
import { useWorkbenchStore } from '../../stores/workbench';
import type { AgentChatComposerCommand } from '../agent-chat/composer/agent-chat-composer-commands';
import {
    canRunAgentChatComposerCommand,
    runAgentChatComposerCommand,
} from '../agent-chat/composer/agent-chat-composer-commands';
import { restartActiveTerminal } from '../terminal/terminal-commands';
import { openTerminalLinkPicker } from '../terminal/terminal-link-actions';
import { clearActiveTerminal, findInActiveTerminal } from '../terminal/terminal-pane-handlers';
import { switchTerminalToOtherSurface } from '../terminal/terminal-surface-commands';
import { useCaxriBotStore } from './bot-client';
import { requestBotPalette } from './bot-dialogs-store';

interface BotKeyboardCommandEntry {
    allowInEditable: boolean;
    run: (terminalId: string) => void;
    when?: (terminalId: string) => boolean;
}

function composerCommand(command: AgentChatComposerCommand): BotKeyboardCommandEntry {
    return {
        allowInEditable: true,
        run: (terminalId) => runAgentChatComposerCommand(terminalId, command),
        when: (terminalId) => canRunAgentChatComposerCommand(terminalId, command),
    };
}

/**
 * The commands this window runs from the keyboard: the Terminal actions its context menu offers, the Restart its exited
 * pane shows with this shortcut, the `Terminal | Chat` switch its title bar offers, its Chat composer's model menu,
 * permission menu, and plan toggle, and its own Command Palette, which lists every other entry here. The native Edit
 * menu already owns Copy and Paste, and every other command belongs to the Workbench window. The palette's default
 * chord is a native menu accelerator that Main forwards to this window as `caxriBot.commandPaletteRequested`; the entry
 * here serves a chord the user rebound to one Main leaves to the Renderer. `allowInEditable` matches each command's
 * Workbench definition (`commands/definitions.ts`): Restart replaces the PTY, so it does not reach through a focused
 * Terminal or input. This window deliberately does not load the Workbench registry, so the values are a copy; the
 * parity test in `__tests__/bot-shortcuts.test.ts` fails when either table changes without the other. A command with
 * `when` leaves its chord to the focused surface while `when` is false, as the Workbench's does.
 */
export const BOT_KEYBOARD_COMMANDS = {
    'terminal.clear': { allowInEditable: true, run: clearActiveTerminal },
    'terminal.find': { allowInEditable: true, run: findInActiveTerminal },
    'terminal.openDetectedLink': { allowInEditable: true, run: openTerminalLinkPicker },
    'terminal.restart': { allowInEditable: false, run: restartActiveTerminal },
    'terminal.switchAgentSurface': { allowInEditable: true, run: switchTerminalToOtherSurface },
    'agentChat.changeModel': composerCommand('changeModel'),
    'agentChat.changePermissionMode': composerCommand('changePermissionMode'),
    'agentChat.togglePlanMode': composerCommand('togglePlanMode'),
    'commandPalette.open': { allowInEditable: true, run: requestBotPalette },
} satisfies Partial<Record<CommandId, BotKeyboardCommandEntry>>;

export type BotKeyboardCommand = keyof typeof BOT_KEYBOARD_COMMANDS;

function isBotKeyboardCommand(command: string): command is BotKeyboardCommand {
    return Object.hasOwn(BOT_KEYBOARD_COMMANDS, command);
}

export function isBotCommandAvailable(command: string, terminalId: string): boolean {
    if (!isBotKeyboardCommand(command)) return false;
    const entry: BotKeyboardCommandEntry = BOT_KEYBOARD_COMMANDS[command];
    return entry.when?.(terminalId) ?? true;
}

function isAllowedInEditable(command: string): boolean {
    return isBotKeyboardCommand(command) && BOT_KEYBOARD_COMMANDS[command].allowInEditable;
}

export interface BotShortcutState {
    keybindings: readonly Keybinding[] | undefined;
    leadingChords: ReadonlySet<string>;
    pending: PendingChord | undefined;
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>;
}

export function createBotShortcutState(): BotShortcutState {
    return {
        keybindings: undefined,
        leadingChords: new Set(),
        pending: undefined,
        shortcutMap: new Map(),
    };
}

/**
 * Runs one keystroke against Caxri Bot's Terminal. The Workbench's chord state machine resolves it against the user's
 * keybindings narrowed to {@link BOT_KEYBOARD_COMMANDS}, so a rebound chord follows the user and any other chord,
 * including the start of another command's sequence, reaches the focused surface untouched.
 */
export function dispatchBotKeydown(
    state: BotShortcutState,
    event: KeyboardEvent,
    terminalId: string | undefined,
): void {
    if (!terminalId || isImeComposing(event) || isModifierKey(event.key)) return;
    const keybindings = useWorkbenchStore.getState().bootstrap?.keybindings;
    if (!keybindings) return;
    if (keybindings !== state.keybindings) {
        const admitted = keybindings.filter(({ command }) => isBotKeyboardCommand(command));
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
    const isChordContinuation = state.pending !== undefined;
    const outcome = resolveKeystroke({
        // The Caxri Bot window has no editor to hand a sequence to.
        editorFocus: false,
        event,
        leadingChords: state.leadingChords,
        pending: state.pending,
        shortcutMap: state.shortcutMap,
        terminalFocus: isTerminalEventTarget(event.target),
    });
    state.pending = undefined;
    if (outcome.kind === 'ignore' || outcome.kind === 'yieldChordContinuation') return;
    /**
     * The Workbench's rule: a chord typed into the running Caxri Bot's Terminal or an input falls through to it unless
     * the command opts in. A stopped Terminal gives up focus, which is when its Restart shortcut is offered. A chord
     * continuation is exempt, since its leading chord was already consumed here.
     */
    if (
        !isChordContinuation &&
        outcome.kind === 'dispatch' &&
        isEditableEventTarget(event.target) &&
        !isAllowedInEditable(outcome.binding.command)
    )
        return;
    if (outcome.kind === 'dispatch' && !isBotCommandAvailable(outcome.binding.command, terminalId))
        return;
    event.preventDefault();
    event.stopPropagation();
    if (outcome.kind === 'armChord') {
        state.pending = { leadingChord: outcome.leadingChord, yieldToEditor: false };
        return;
    }
    if (outcome.kind === 'cancelChord' || useDialogStore.getState().isModalOpen()) return;
    const { command } = outcome.binding;
    if (isBotKeyboardCommand(command)) BOT_KEYBOARD_COMMANDS[command].run(terminalId);
}

/**
 * Mounts the Caxri Bot window's keyboard dispatch. The Workbench's `useCommandShortcuts` is not mounted here: it runs
 * the Workbench command registry, whose Terminal commands resolve the active Terminal from a pane layout this window
 * does not have. Terminal chords such as `Cmd+F` are Renderer-owned (no native menu accelerator), so without this they
 * would do nothing in this window.
 */
export function useBotShortcuts(): void {
    useEffect(() => {
        const state = createBotShortcutState();
        const onKeyDown = (event: KeyboardEvent): void =>
            dispatchBotKeydown(state, event, useCaxriBotStore.getState().identity?.terminalId);
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
