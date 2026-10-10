import type { MethodResult, PaneSplitSide, TerminalKind, TerminalSurface } from '@caxri/protocol';
import {
    findResourceTabs,
    isCaxriError,
    isChatTerminal,
    moveTab,
    openResource,
    selectTab,
    splitTabIntoPane,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { getBootstrap, getSelectedSession, getSessionState } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { patchSessionState, refreshWorkbench } from '../../stores/workbench';
import { newAgentSurface, newTerminalCommandKind } from './new-terminal-agent';
import type { TerminalCommandNavigationDirection } from './terminal-command-tracker';
import { didNavigateTerminalCommand } from './terminal-command-tracker';
import { clearTerminalProgress } from './terminal-progress';
import { openTerminalSearch } from './terminal-search';
import type { TerminalSize } from './terminal-size';

/**
 * Reveals a Terminal wherever it is placed. A Terminal owns exactly one tab occurrence, so this is a plain selection:
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
     * Starts a shell in this external document's folder instead of `cwd`. Main resolves the opaque ID to the folder,
     * because a Renderer-supplied cwd must stay inside the Session's roots.
     */
    externalDocumentId?: string;
    /**
     * Where to place the new Terminal; defaults to the active pane.
     */
    paneId?: string;
    /**
     * Open the Terminal in a new pane split off the target pane instead of as another tab in it.
     */
    split?: PaneSplitSide;
    /**
     * `chat` creates a Chat Terminal for an Agent whose catalog entry supports it; defaults to a PTY.
     */
    surface?: TerminalSurface;
}

export async function createTerminal(
    kind: TerminalKind = 'shell',
    options: CreateTerminalOptions = {},
): Promise<void> {
    const session = getSelectedSession();
    if (!session) return;
    await createTerminalForSession(session.id, kind, options);
}

/**
 * The `session.defaultAgent` reader for Terminals created inside a Session. Until this existed the setting was only
 * consulted while creating a Session, so `Cmd+T` and the New Terminal button ignored the Agent the user had named.
 */
export async function createDefaultTerminal(options: CreateTerminalOptions = {}): Promise<void> {
    const settings = getBootstrap()?.settings;
    const kind = newTerminalCommandKind(settings?.['session.defaultAgent']);
    await createTerminal(kind, {
        surface: newAgentSurface(kind, settings?.['session.openAgentsInChat']),
        ...options,
    });
}

export async function createTerminalForSession(
    sessionId: string,
    kind: TerminalKind,
    { cwd, externalDocumentId, paneId, split, surface }: CreateTerminalOptions,
): Promise<void> {
    await tryCommand(
        'Terminal creation failed',
        async () => {
            const terminal = externalDocumentId
                ? await caxri.request('externalDocument.openInTerminal', {
                      documentId: externalDocumentId,
                      sessionId,
                  })
                : await caxri.request('terminal.create', {
                      sessionId,
                      kind,
                      ...(cwd && { cwd }),
                      ...(surface === 'chat' && { surface }),
                  });
            /**
             * Every Root the Session has already arranged gets this Terminal placed into it as a background tab before
             * `terminal.create` even resolves (`SessionsModel.addTerminalToAllRootStates`), including the active Root
             * this caller is about to update. Refreshing first, instead of mutating the caller's stale cached layout,
             * means `openResource` below finds that placement already there and reuses its tab id, computing a second,
             * competing tab id here would fight the server's for the same Terminal and flash a duplicate.
             */
            await refreshWorkbench();
            /**
             * `Cmd+T` immediately followed by `Cmd+W` can close this Terminal while the refresh above is still in
             * flight. Placing it afterwards would open a tab for a Terminal the Server has already deleted, which
             * renders as a permanently blank pane no close can reach.
             */
            if (!getBootstrap()?.terminals.some((candidate) => candidate.id === terminal.id))
                return;
            const currentState = getSessionState();
            if (currentState?.sessionId === sessionId) {
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
        },
        {
            // These errors come from directory/session validation before Server creates a Terminal. A lost response
            // could follow a successful durable create, so an uncertain result may only refresh the current state.
            recovery: (error) =>
                !externalDocumentId &&
                isCaxriError(error) &&
                ['IO', 'VALIDATION', 'PATH_DENIED', 'NOT_FOUND'].includes(error.code)
                    ? {
                          id: 'terminal.create',
                          params: { sessionId, kind, cwd, paneId, split, surface },
                      }
                    : { id: 'terminal.refresh' },
        },
    );
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

/**
 * Suspends a Terminal: its whole process tree exits, while the Session and the Agent conversation stay resumable from
 * the Terminal pane.
 */
export function stopTerminal(terminalId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports stop failures through the toast
    void tryCommand('Unable to stop the Terminal', () =>
        caxri.request('terminal.suspend', { terminalId }),
    );
}

export function refreshTerminalState(): void {
    // eslint-disable-next-line no-void -- tryCommand reports refresh failures through the toast
    void tryCommand('Terminal refresh failed', refreshWorkbench);
}

async function requestTerminalRestart(
    terminalId: string,
    mode: 'resume' | 'fresh',
    onRestartSubmitted?: () => void,
): Promise<void> {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    /**
     * A stopped PTY lost Server attachment ownership, while a running PTY must not be reattached because replaying its
     * screen without a new xterm consumer would discard queued live output.
     */
    if (terminal?.lastProcessState !== 'running')
        await caxri.request('terminal.attach', { terminalId });
    onRestartSubmitted?.();
    await caxri.request('terminal.restart', { terminalId, mode });
}

/**
 * Resume-restarts a Terminal with the lost-reply recovery offer. `failureTitle` names the action the user took, so a
 * failed Reload Agent does not report itself as a Terminal restart.
 */
export function restartTerminalWithRecovery(
    terminalId: string,
    failureTitle = 'Terminal restart failed',
): void {
    let isRestartSubmitted = false;
    // Captured before the attempt: the offer stays in the notification center indefinitely, and the handler refuses it
    // once this Terminal is running something else, so the number has to describe the failure rather than the present.
    const processId = getBootstrap()?.terminals.find((entry) => entry.id === terminalId)?.processId;
    // eslint-disable-next-line no-void -- tryCommand reports restart failures through the toast
    void tryCommand(
        failureTitle,
        () =>
            requestTerminalRestart(terminalId, 'resume', () => {
                isRestartSubmitted = true;
            }),
        {
            refresh: refreshWorkbench,
            // Restart replaces a live PTY. Repeating a submitted request after a lost reply would kill the new process.
            recovery: () =>
                isRestartSubmitted
                    ? { id: 'terminal.refresh' }
                    : { id: 'terminal.restart', params: { processId, terminalId } },
        },
    );
}

/**
 * Recovery path used by the in-pane Restart action.
 */
export function restartTerminal(terminalId: string): void {
    restartTerminalWithRecovery(terminalId);
}

export function restartActiveTerminal(terminalId: string): void {
    restartTerminalWithRecovery(terminalId);
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

/**
 * A Chat Terminal has no PTY to write bytes into (ADR 0012), so every PTY input path refuses it here, at one boundary.
 */
export function canSendTerminalInput(terminalId: string): boolean {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    if (terminal && isChatTerminal(terminal)) return false;
    return inputGates.get(terminalId)?.() ?? true;
}

/**
 * Dialogs opened from a keyboard command have no DOM trigger for Base UI to restore focus to. The mounted Terminal pane
 * therefore exposes its live xterm focus operation through the same ownership-safe registry used by clear and copy. The
 * element getter serves the picker close path, where Base UI wants the target element itself rather than an imperative
 * focus call (see `lib/picker-final-focus.ts`).
 */
interface TerminalFocusHandler {
    focus: () => void;
    getFocusElement: () => HTMLElement | null;
}

const focusHandlers = new Map<string, TerminalFocusHandler>();

export function registerTerminalFocusHandler(
    terminalId: string,
    focus: () => void,
    getFocusElement: () => HTMLElement | null = () => null,
): () => void {
    const handler: TerminalFocusHandler = { focus, getFocusElement };
    focusHandlers.set(terminalId, handler);
    return () => {
        if (focusHandlers.get(terminalId) === handler) focusHandlers.delete(terminalId);
    };
}

export function focusTerminalById(terminalId: string): void {
    focusHandlers.get(terminalId)?.focus();
}

export function getTerminalFocusElement(terminalId: string): HTMLElement | null {
    return focusHandlers.get(terminalId)?.getFocusElement() ?? null;
}

/**
 * Server admits ordinary `terminal.input` only while a Renderer view holds the Terminal's attachment (`acceptInput` in
 * the Terminal Host drops it silently otherwise). A hidden tab has no mounted pane and therefore no attachment, so a
 * command that first reveals a Terminal must wait here before writing into it. The mounted pane reports the initial
 * attach completion; unmounting clears it.
 */
const attachedTerminals = new Set<string>();
const attachmentWaiters = new Map<string, Set<() => void>>();

export function markTerminalAttached(terminalId: string, isAttached: boolean): void {
    if (!isAttached) {
        attachedTerminals.delete(terminalId);
        return;
    }
    attachedTerminals.add(terminalId);
    const waiters = attachmentWaiters.get(terminalId);
    attachmentWaiters.delete(terminalId);
    if (waiters) for (const resolve of waiters) resolve();
}

export function isTerminalAttached(terminalId: string): boolean {
    return attachedTerminals.has(terminalId);
}

/**
 * Resolves `true` once the Terminal's pane has attached, or `false` after `timeoutMs` without an attachment.
 */
export function whenTerminalAttached(terminalId: string, timeoutMs: number): Promise<boolean> {
    if (attachedTerminals.has(terminalId)) return Promise.resolve(true);
    return new Promise((resolve) => {
        const waiters = attachmentWaiters.get(terminalId) ?? new Set();
        attachmentWaiters.set(terminalId, waiters);
        const timer = setTimeout(() => {
            waiters.delete(settle);
            if (waiters.size === 0 && attachmentWaiters.get(terminalId) === waiters)
                attachmentWaiters.delete(terminalId);
            resolve(false);
        }, timeoutMs);
        function settle(): void {
            clearTimeout(timer);
            resolve(true);
        }
        waiters.add(settle);
    });
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
 * Answers only "does this Terminal currently own a selection": focus is checked by the caller.
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

/**
 * The PTY write behind xterm's `onData`. Rejection is deliberately propagated: the pane decides whether a failed write
 * is worth a toast, because a Terminal torn down mid-keystroke rejects the same way a transport failure does.
 */
export async function sendTerminalInput(
    terminalId: string,
    data: string,
    requiresRunningAgent = false,
): Promise<void> {
    await caxri.request('terminal.input', {
        terminalId,
        data,
        ...(requiresRunningAgent && { requireRunningAgent: true }),
    });
}

/**
 * The same write, refused by the Server unless the named Agent launch is still the one running. Input typed at an Agent
 * that has since exited must not reach whatever took over the PTY.
 */
export async function sendTerminalInputToAgent(
    terminalId: string,
    data: string,
    expectedAgentLaunchId: string,
): Promise<void> {
    await caxri.request('terminal.inputAgentExact', { terminalId, data, expectedAgentLaunchId });
}

/**
 * Xterm's onBinary string contains raw byte values, including values above ASCII.
 */
export async function sendTerminalBinaryInput(
    terminalId: string,
    data: string,
    expectedAgentLaunchId?: string,
): Promise<void> {
    await caxri.request('terminal.inputBinary', {
        terminalId,
        data,
        ...(expectedAgentLaunchId && { expectedAgentLaunchId }),
    });
}

/**
 * Hands a large paste to the Server so it can be summarized into a reference the Agent reads instead of pasted byte by
 * byte.
 */
export async function prepareTerminalLongPaste(
    terminalId: string,
    content: string,
): Promise<MethodResult<'terminal.prepareLongPaste'>> {
    return caxri.request('terminal.prepareLongPaste', { content, terminalId });
}

/**
 * Reports the pane's measured grid so the Server resizes the parsed screen behind the same ordering barrier the output
 * stream uses.
 */
export async function resizeTerminal(terminalId: string, size: TerminalSize): Promise<void> {
    await caxri.request('terminal.resize', { terminalId, ...size });
}

/**
 * Claims the Terminal's output for this pane and returns the snapshot to replay ahead of it. The grid is omitted while
 * no process is running: there is nothing to resize, and sending a size would move the parsed screen for nothing.
 */
export async function attachTerminal(
    terminalId: string,
    size?: TerminalSize,
): Promise<MethodResult<'terminal.attach'>> {
    return caxri.request('terminal.attach', size ? { terminalId, ...size } : { terminalId });
}

/**
 * A Server restart can race a pane teardown, leaving no live view to notify; the failure is intentionally unobserved
 * instead of surfaced through `onError`.
 */
export async function detachTerminalQuietly(terminalId: string): Promise<void> {
    try {
        await caxri.request('terminal.detach', { terminalId });
    } catch {
        // Intentionally swallowed, see the function comment above.
    }
}
