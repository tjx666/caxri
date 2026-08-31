import type { PaneSplitSide, TerminalKind } from '@caxri/protocol';
import {
    findResourceTabs,
    moveTab,
    openResource,
    selectTab,
    splitTabIntoPane,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { getBootstrap, getSelectedSession, getSessionState } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { patchSessionState, refreshWorkbench } from '../../stores/workbench';
import type { TerminalCommandNavigationDirection } from './terminal-commands';
import { didNavigateTerminalCommand } from './terminal-commands';
import { clearTerminalProgress } from './terminal-progress';
import { openTerminalSearch } from './terminal-search';

/**
 * Reveals a Terminal wherever it is placed. A Terminal owns exactly one tab occurrence, so this is a plain selection —
 * there is no separate "which pane should it go to" question to answer.
 */
export function activateTerminal(terminalId: string): void {
    const sessionState = getSessionState();
    if (!sessionState) return;
    const occurrence = findResourceTabs(sessionState.paneLayout, {
        kind: 'terminal',
        terminalId,
    }).at(0);
    if (occurrence)
        patchSessionState(
            {
                ...sessionState,
                paneLayout: selectTab(sessionState.paneLayout, occurrence.tab.id),
            },
            'Unable to activate Terminal',
        );
}

interface CreateTerminalOptions {
    cwd?: string;
    /**
     * Where to place the new Terminal; defaults to the active pane.
     */
    paneId?: string;
    /**
     * Open the Terminal in a new pane split off the target pane instead of as another tab in it.
     */
    split?: PaneSplitSide;
}

export async function createTerminal(
    kind: TerminalKind = 'shell',
    { cwd, paneId, split }: CreateTerminalOptions = {},
): Promise<void> {
    const session = getSelectedSession();
    if (!session) return;
    await tryCommand('Terminal creation failed', async () => {
        const terminal = await caxri.request('terminal.create', {
            sessionId: session.id,
            kind,
            ...(cwd && { cwd }),
        });
        /**
         * Every Root the Session has already arranged gets this Terminal placed into it as a background tab before
         * `terminal.create` even resolves (`SessionsModel.addTerminalToAllRootStates`), including the active Root this
         * caller is about to update. Refreshing first, instead of mutating the caller's stale cached layout, means
         * `openResource` below finds that placement already there and reuses its tab id — computing a second, competing
         * tab id here would fight the server's for the same Terminal and flash a duplicate.
         */
        await refreshWorkbench();
        /**
         * `Cmd+T` immediately followed by `Cmd+W` can close this Terminal while the refresh above is still in flight.
         * Placing it afterwards would open a tab for a Terminal the Server has already deleted, which renders as a
         * permanently blank pane no close can reach.
         */
        if (!getBootstrap()?.terminals.some((candidate) => candidate.id === terminal.id)) return;
        const currentState = getSessionState();
        if (currentState) {
            const resource = { kind: 'terminal' as const, terminalId: terminal.id };
            const placed = findResourceTabs(currentState.paneLayout, resource).at(0);
            const opened = placed
                ? paneId && placed.pane.id !== paneId
                    ? moveTab(currentState.paneLayout, placed.tab.id, paneId)
                    : selectTab(currentState.paneLayout, placed.tab.id)
                : openResource(currentState.paneLayout, resource, { paneId });
            const target = findResourceTabs(opened, resource).at(0);
            patchSessionState({
                ...currentState,
                paneLayout:
                    split && target
                        ? splitTabIntoPane(opened, target.tab.id, target.pane.id, split)
                        : opened,
            });
        }
    });
}

export function closeTerminal(terminalId: string): void {
    // This is a sync UI handler; tryCommand already routes any failure into a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Terminal close failed',
        async () => {
            await caxri.request('terminal.close', { terminalId });
            clearTerminalProgress(terminalId);
        },
        {
            refresh: refreshWorkbench,
        },
    );
}

async function requestTerminalRestart(terminalId: string, mode: 'resume' | 'fresh'): Promise<void> {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    /**
     * A stopped PTY lost Server attachment ownership, while a running PTY must not be reattached because replaying its
     * screen without a new xterm consumer would discard queued live output.
     */
    if (terminal?.lastProcessState !== 'running')
        await caxri.request('terminal.attach', { terminalId });
    await caxri.request('terminal.restart', { terminalId, mode });
}

/**
 * Recovery path used by the in-pane Restart action.
 */
export function restartTerminal(terminalId: string): void {
    // This is a sync UI handler; tryCommand already routes any failure into a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Terminal restart failed', () => requestTerminalRestart(terminalId, 'resume'), {
        refresh: refreshWorkbench,
    });
}

export function restartActiveTerminal(terminalId: string): void {
    // This is a sync UI handler; tryCommand already routes any failure into a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Terminal restart failed', () => requestTerminalRestart(terminalId, 'resume'), {
        refresh: refreshWorkbench,
    });
}

/**
 * The only user action allowed to clear a durable provider-session binding.
 */
export function startNewAgentSession(terminalId: string): void {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    if (!terminal?.provider || !terminal.agentSessionId) {
        pushToast('info', 'The active Terminal has no Agent session to replace.');
        return;
    }
    // This is a sync UI handler; tryCommand already routes any failure into a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Starting a new Agent session failed',
        () => requestTerminalRestart(terminalId, 'fresh'),
        { refresh: refreshWorkbench },
    );
}

/**
 * The mounted `TerminalPane` registers its clear handler here so `terminal.clear` can reach the live xterm instance
 * with a direct call instead of a window-wide `CustomEvent`. Only one pane owns a given Terminal at a time, so a plain
 * `Map` keyed by id is enough.
 */
const clearHandlers = new Map<string, () => void>();

export function registerTerminalClearHandler(terminalId: string, handler: () => void): () => void {
    clearHandlers.set(terminalId, handler);
    return () => {
        if (clearHandlers.get(terminalId) === handler) clearHandlers.delete(terminalId);
    };
}

export function clearActiveTerminal(terminalId: string): void {
    clearHandlers.get(terminalId)?.();
}

/**
 * Files-to-Terminal drops must enter through the mounted xterm instance so bracketed-paste mode, PTY ordering, and
 * focus behave exactly like an ordinary paste. The layout owns the drop target while the pane owns xterm, so this
 * per-Terminal registry bridges those two Renderer surfaces without adding another IPC input path.
 */
interface TerminalPasteHandlers {
    paste(data: string): boolean;
}

const pasteHandlers = new Map<string, TerminalPasteHandlers>();

export function registerTerminalPasteHandler(
    terminalId: string,
    handlers: TerminalPasteHandlers,
): () => void {
    pasteHandlers.set(terminalId, handlers);
    return () => {
        if (pasteHandlers.get(terminalId) === handlers) pasteHandlers.delete(terminalId);
    };
}

export function didPasteIntoTerminal(terminalId: string, data: string): boolean {
    return pasteHandlers.get(terminalId)?.paste(data) ?? false;
}

/**
 * Every Renderer input path consults the mounted pane's live gate so commands and dialogs cannot bypass a pending
 * long-paste lock. Missing gates preserve command behavior while a pane is still mounting.
 */
const inputGates = new Map<string, () => boolean>();

export function registerTerminalInputGate(
    terminalId: string,
    canAcceptInput: () => boolean,
): () => void {
    inputGates.set(terminalId, canAcceptInput);
    return () => {
        if (inputGates.get(terminalId) === canAcceptInput) inputGates.delete(terminalId);
    };
}

export function canSendTerminalInput(terminalId: string): boolean {
    return inputGates.get(terminalId)?.() ?? true;
}

/**
 * Dialogs opened from a keyboard command have no DOM trigger for Radix to restore focus to. The mounted Terminal pane
 * therefore exposes its live xterm focus operation through the same ownership-safe registry used by clear and copy.
 */
const focusHandlers = new Map<string, () => void>();

export function registerTerminalFocusHandler(terminalId: string, handler: () => void): () => void {
    focusHandlers.set(terminalId, handler);
    return () => {
        if (focusHandlers.get(terminalId) === handler) focusHandlers.delete(terminalId);
    };
}

export function focusTerminalById(terminalId: string): void {
    focusHandlers.get(terminalId)?.();
}

/**
 * The mounted `TerminalPane` registers its live xterm selection here, mirroring {@link registerTerminalClearHandler}:
 * `copySelection` reuses `TerminalSelectionClipboard` (already serializing writes against a stale selection) instead of
 * a second clipboard write path, and `hasSelection` backs both the `terminal.copy` command's `when` gate and the
 * context menu's disabled state.
 */
interface TerminalSelectionHandlers {
    copySelection(): void;
    hasSelection(): boolean;
}

const selectionHandlers = new Map<string, TerminalSelectionHandlers>();

export function registerTerminalSelectionHandlers(
    terminalId: string,
    handlers: TerminalSelectionHandlers,
): () => void {
    selectionHandlers.set(terminalId, handlers);
    return () => {
        if (selectionHandlers.get(terminalId) === handlers) selectionHandlers.delete(terminalId);
    };
}

export function copyActiveTerminalSelection(terminalId: string): void {
    selectionHandlers.get(terminalId)?.copySelection();
}

/**
 * Answers only "does this Terminal currently own a selection" — focus is checked by the caller.
 */
export function hasActiveTerminalSelection(terminalId: string): boolean {
    return selectionHandlers.get(terminalId)?.hasSelection() ?? false;
}

export function findInActiveTerminal(terminalId: string): void {
    openTerminalSearch(terminalId);
}

export function navigateActiveTerminalCommand(
    terminalId: string,
    direction: TerminalCommandNavigationDirection,
): void {
    didNavigateTerminalCommand(terminalId, direction);
}

/**
 * Sends the configured bytes through the same typed input boundary as xterm's `onData`. The text is intentionally not
 * escaped or rewritten: JSONC already decoded sequences such as `\u001b`, and the command exists specifically to let a
 * user reproduce an exact Terminal input sequence.
 */
export function sendTerminalSequence(terminalId: string, text: string): void {
    if (!canSendTerminalInput(terminalId)) return;
    // This is a sync command handler; tryCommand already routes any failure into a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Terminal input failed', () =>
        caxri.request('terminal.input', { terminalId, data: text }),
    );
}
