import type { MethodResult, PaneSplitSide, TerminalKind, TerminalSurface } from '@caxri/protocol';
import {
    findResourceTabs,
    isCaxriError,
    moveTab,
    openResource,
    selectTab,
    splitTabIntoPane,
} from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap, getSelectedSession, getSessionState } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { patchSessionState, refreshWorkbench } from '../../stores/workbench';
import { confirmBeforeEndingTurn } from './agent-turn-guard';
import { newAgentSurface, newTerminalCommandKind } from './new-terminal-agent';
import { canSendTerminalInput } from './terminal-pane-handlers';
import { clearTerminalProgress } from './terminal-progress';
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
            translate('terminal.errors.activateFailed'),
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

/**
 * Resolves the new Terminal's id once it is placed, or `undefined` when creation failed (already reported in a toast)
 * or the Terminal was closed before it could be placed.
 */
export async function createTerminalForSession(
    sessionId: string,
    kind: TerminalKind,
    { cwd, externalDocumentId, paneId, split, surface }: CreateTerminalOptions,
): Promise<string | undefined> {
    return tryCommand(
        translate('terminal.errors.createFailed'),
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
            return terminal.id;
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
        translate('terminal.errors.closeFailed'),
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
    void tryCommand(translate('terminal.errors.stopFailed'), () =>
        caxri.request('terminal.suspend', { terminalId }),
    );
}

export function refreshTerminalState(): void {
    // eslint-disable-next-line no-void -- tryCommand reports refresh failures through the toast
    void tryCommand(translate('terminal.errors.refreshFailed'), refreshWorkbench);
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

const TERMINAL_RESTART_FAILED: TranslationKey = 'terminal.errors.restartFailed';

/**
 * Resume-restarts a Terminal with the lost-reply recovery offer, without asking first: the notification center's Retry
 * and {@link restartTerminal} (after its running-turn confirmation) both land here. `failureTitle` names the action the
 * user took, so a failed Restart Agent does not report itself as a Terminal restart. It is a translation key,
 * translated when the failure is reported, so callers outside this module never hold a language-frozen string.
 */
export function restartTerminalWithRecovery(
    terminalId: string,
    failureTitle: TranslationKey = TERMINAL_RESTART_FAILED,
): void {
    let isRestartSubmitted = false;
    // Captured before the attempt: the offer stays in the notification center indefinitely, and the handler refuses it
    // once this Terminal is running something else, so the number has to describe the failure rather than the present.
    const processId = getBootstrap()?.terminals.find((entry) => entry.id === terminalId)?.processId;
    // eslint-disable-next-line no-void -- tryCommand reports restart failures through the toast
    void tryCommand(
        translate(failureTitle),
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

export const RESTART_AGENT_FAILED: TranslationKey = 'terminal.errors.restartAgentFailed';

/**
 * Restarts a Terminal: a Shell starts again, and an Agent Terminal ends its current Agent Run and resumes the same
 * Agent Session ("Restart Agent"). A running turn is never ended silently: every entry point (`terminal.restart`, the
 * recovery row, the Session row and tab menus' Restart Agent, a detached Chat's Resume) asks first through
 * {@link confirmBeforeEndingTurn}. A failed Chat's Retry skips it: the failure already ended the turn, while Session
 * Activity can still read `running` because the crashed provider never reported the turn's end.
 */
export function restartTerminal(terminalId: string): void {
    const isAgent = Boolean(
        getBootstrap()?.terminals.find((entry) => entry.id === terminalId)?.provider,
    );
    const failureTitle = isAgent ? RESTART_AGENT_FAILED : TERMINAL_RESTART_FAILED;
    // eslint-disable-next-line no-void -- the confirmation and the restart report their own errors
    void confirmBeforeEndingTurn(
        terminalId,
        {
            confirmLabel: translate('terminal.restart.confirmLabel'),
            failureTitle: translate(failureTitle),
            outcome: translate('terminal.restart.outcome'),
        },
        () => restartTerminalWithRecovery(terminalId, failureTitle),
    );
}

/**
 * `terminal.restart` from a shortcut, the palette, or the native menu: the same guarded restart as the menus.
 */
export function restartActiveTerminal(terminalId: string): void {
    restartTerminal(terminalId);
}

/**
 * Start New Conversation: the only user action allowed to clear a durable provider-session binding. It ends the current
 * Agent Run like a restart, and it always asks first, even for an exited or idle Agent: once confirmed, this Terminal
 * stops resuming the conversation it was bound to, which no later Restart can take back. A running turn asks only the
 * running-turn question, which already names that consequence.
 *
 * The UI says "conversation" rather than "Agent Session" because a bare "session" collides with Caxri's Session.
 */
export function startNewAgentSession(terminalId: string): void {
    const terminal = getBootstrap()?.terminals.find((entry) => entry.id === terminalId);
    if (!terminal?.provider || !terminal.agentSessionId) {
        pushToast('info', translate('terminal.newConversation.none'));
        return;
    }
    const failureTitle = translate('terminal.newConversation.failed');
    // eslint-disable-next-line no-void -- the confirmation and the restart report their own errors
    void confirmBeforeEndingTurn(
        terminalId,
        {
            confirmLabel: translate('terminal.newConversation.stopConfirmLabel'),
            failureTitle,
            idle: {
                confirmLabel: translate('terminal.newConversation.confirmLabel'),
                message: translate('terminal.newConversation.message'),
                title: translate('terminal.newConversation.title'),
            },
            outcome: translate('terminal.newConversation.outcome'),
        },
        () =>
            // eslint-disable-next-line no-void -- tryCommand routes any failure into a toast
            void tryCommand(failureTitle, () => requestTerminalRestart(terminalId, 'fresh'), {
                refresh: refreshWorkbench,
            }),
    );
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
    void tryCommand(translate('terminal.errors.inputFailed'), () =>
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
