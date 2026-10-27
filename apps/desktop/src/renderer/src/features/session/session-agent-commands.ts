import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { isChatTerminal } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { writeClipboardText } from '../../lib/clipboard';
import { copyFilePath } from '../../lib/copy-file-path';
import { getBootstrap, getSelectedSession } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { confirmBeforeEndingTurn } from '../terminal/agent-turn-guard';

/**
 * The Agent Terminal whose turn Detach would cut short: the Session's Primary Agent while it is live, else the first
 * live Agent Terminal. Session Activity tracks only the Primary Agent, so that is the one whose running turn is known;
 * any other live Agent reads as idle to the running-turn check either way.
 */
export function detachTurnTerminalId(
    session: Pick<SessionRecord, 'id' | 'primaryAgentTerminalId'>,
    terminals: ReadonlyArray<
        Pick<TerminalRecord, 'id' | 'lastProcessState' | 'provider' | 'sessionId'>
    >,
): string | undefined {
    const live = terminals.filter(
        (terminal) =>
            terminal.sessionId === session.id &&
            terminal.provider !== undefined &&
            (terminal.lastProcessState === 'running' || terminal.lastProcessState === 'starting'),
    );
    return (
        live.find((terminal) => terminal.id === session.primaryAgentTerminalId)?.id ?? live[0]?.id
    );
}

/**
 * Why "Fork Session" cannot copy a Session's Primary Agent conversation, or `undefined` when it can. The fork goes
 * through the Chat's provider (`agentChat.fork`), so a PTY Agent offers it only once it is open as Chat, and only after
 * the provider created a conversation to copy. A running turn is left to Server Core, which refuses it with the
 * reason.
 */
export type SessionForkBlocker = 'noAgent' | 'notChat' | 'noConversation';

export function sessionForkBlocker(
    terminal: Pick<TerminalRecord, 'agentSessionId' | 'provider' | 'surface'> | undefined,
): SessionForkBlocker | undefined {
    if (!terminal?.provider) return 'noAgent';
    if (!isChatTerminal(terminal)) return 'notChat';
    if (!terminal.agentSessionId) return 'noConversation';
    return undefined;
}

/**
 * Codex refuses to open one conversation in two processes, so handing a Session to an editor Terminal means Caxri must
 * stop its own Agent first. `session.detach` parks the Agent Terminals as `detached`; unlike background suspension,
 * selecting the Session again does not relaunch them; only `resumeSession` does.
 *
 * Parking ends the Agent Run, so a running turn asks first through the same {@link confirmBeforeEndingTurn} question as
 * Restart Agent; an idle Agent detaches at once.
 */
export function detachSession(sessionId: string): void {
    const latest = getBootstrap();
    const session = latest?.sessions.find((entry) => entry.id === sessionId);
    const terminalId = session ? detachTurnTerminalId(session, latest?.terminals ?? []) : undefined;
    const failureTitle = translate('session.errors.detachFailed');
    const detach = (): void => {
        // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
        void tryCommand(failureTitle, () => caxri.request('session.detach', { sessionId }), {
            refresh: refreshWorkbench,
        });
    };
    if (!terminalId) {
        detach();
        return;
    }
    void confirmBeforeEndingTurn(
        terminalId,
        {
            confirmLabel: translate('session.detach.confirm'),
            failureTitle,
            outcome: translate('session.detach.outcome'),
        },
        detach,
    );
}

export function resumeSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    void tryCommand(
        translate('session.errors.resumeFailed'),
        () => caxri.request('session.resume', { sessionId }),
        {
            refresh: refreshWorkbench,
        },
    );
}

export function detachSelectedSession(): void {
    const session = getSelectedSession();
    if (session) detachSession(session.id);
}

export function resumeSelectedSession(): void {
    const session = getSelectedSession();
    if (session) resumeSession(session.id);
}

/**
 * The Agent's own conversation identifier (a Codex thread id, a Claude Code session id), which is not Caxri's Session
 * row id. Provider CLIs and their on-disk state are keyed by this value, so it is what lines a Session up against
 * `codex resume`, a rollout file, or a `~/.claude/projects` transcript when an Agent binding has to be inspected.
 */
export function copyAgentSessionId(agentSessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the failure into a toast internally.
    void tryCommand(translate('session.errors.copyConversationIdFailed'), async () => {
        await writeClipboardText(agentSessionId);
        pushToast('success', translate('session.agent.conversationIdCopied'));
    });
}

/**
 * Resolves the transcript path on click rather than subscribing every Session row to a transcript query: Codex names
 * its rollout files by wall-clock time, so the Server answers by scanning its sessions directory, and the sidebar
 * renders one menu per row. `withContent: false` keeps that lookup off the file's contents.
 */
export function copyAgentTranscriptPath(terminalId: string): void {
    // Fire-and-forget: `tryCommand` funnels the failure into a toast internally, and `copyFilePath` reports its own.
    void tryCommand(translate('session.errors.copyTranscriptPathFailed'), async () => {
        const transcript = await caxri.request('terminal.agentTranscript', {
            terminalId,
            withContent: false,
        });
        if (!transcript) throw new Error(translate('session.agent.noTranscript'));
        await copyFilePath(transcript.path);
    });
}

/**
 * True when the Session has at least one Agent Terminal parked by `detachSession`, i.e. the menu should offer Resume
 * instead of Detach.
 */
export function hasDetachedAgentTerminal(
    sessionId: string,
    terminals: ReadonlyArray<Pick<TerminalRecord, 'lastProcessState' | 'provider' | 'sessionId'>>,
): boolean {
    return terminals.some(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            terminal.lastProcessState === 'detached',
    );
}

/**
 * True when the Session has a live Agent Terminal that `detachSession` could hand over.
 */
export function hasLiveAgentTerminal(
    sessionId: string,
    terminals: ReadonlyArray<Pick<TerminalRecord, 'lastProcessState' | 'provider' | 'sessionId'>>,
): boolean {
    return terminals.some(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            (terminal.lastProcessState === 'running' || terminal.lastProcessState === 'starting'),
    );
}
