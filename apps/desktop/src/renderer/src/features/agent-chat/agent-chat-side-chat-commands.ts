import { agentSideChatTabPath } from '@caxri/protocol';
import { omit } from 'es-toolkit';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { createStore } from '../../lib/store';
import { getBootstrap, getSessionState } from '../../stores/selectors';
import { describeFailureNotice, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { didSelectSession } from '../session/session-commands';
import { findPaneTabId } from '../workbench/pane-actions';
import { didSendAgentChatMessage } from './agent-chat-commands';
import type { SideChatExchange } from './agent-chat-side-thread';
import { agentChatSideHistory, agentChatSideSeedPrompt } from './agent-chat-side-thread';

interface AgentChatSideChatState {
    /**
     * The side chat of each Chat Terminal. Renderer memory only: a side chat is never saved, and discarding it (closing
     * its tab) forgets it for good. A store rather than component state so a tab that remounts (a Session switch, a
     * pane move) keeps its answers and an answer that arrives while the tab is hidden still lands.
     */
    threads: Readonly<Partial<Record<string, readonly SideChatExchange[]>>>;
}

export const useAgentChatSideChatStore = createStore<AgentChatSideChatState>(
    'agentChatSideChat',
    () => ({ threads: {} }),
);

const exchangeIds = { next: 0 };

function patchExchange(terminalId: string, id: string, patch: Partial<SideChatExchange>): void {
    useAgentChatSideChatStore.setState(({ threads }) => {
        const exchanges = threads[terminalId];
        if (!exchanges?.some((exchange) => exchange.id === id)) return { threads };
        return {
            threads: {
                ...threads,
                [terminalId]: exchanges.map((exchange) =>
                    exchange.id === id ? { ...exchange, ...patch } : exchange,
                ),
            },
        };
    });
}

/**
 * Asks Server Core to answer `exchange` from its Chat's context and records the outcome on it. Nothing here touches the
 * main conversation: Server Core answers beside the running turn without queueing or steering it. A failure stays on
 * the exchange, in the thread, for Retry rather than raising a toast over a pane the user is reading.
 */
async function answerExchange(terminalId: string, exchange: SideChatExchange): Promise<void> {
    const thread = useAgentChatSideChatStore.getState().threads[terminalId] ?? [];
    const history = agentChatSideHistory(thread, exchange.id);
    patchExchange(terminalId, exchange.id, {
        status: 'pending',
        error: undefined,
        response: undefined,
    });
    try {
        const { response } = await caxri.request('agentChat.askSideQuestion', {
            terminalId,
            question: exchange.question,
            history,
        });
        patchExchange(terminalId, exchange.id, { status: 'answered', response });
    } catch (error) {
        patchExchange(terminalId, exchange.id, {
            status: 'failed',
            error: describeFailureNotice(error, translate('agentChat.sideChat.askFailed')).message,
        });
    }
}

/**
 * Whether the thread has a question still waiting for its answer; the composer holds Send meanwhile, so a follow-up
 * always carries the answer before it as context.
 */
export function isAgentChatSideChatBusy(exchanges: readonly SideChatExchange[]): boolean {
    return exchanges.some(({ status }) => status === 'pending');
}

/**
 * Adds `question` to the Chat's side chat and asks it. Resolves once the answer or the failure is recorded.
 */
export async function askAgentChatSideQuestion(
    terminalId: string,
    question: string,
): Promise<void> {
    const text = question.trim();
    const current = useAgentChatSideChatStore.getState().threads[terminalId] ?? [];
    if (!text || isAgentChatSideChatBusy(current)) return;
    exchangeIds.next += 1;
    const exchange: SideChatExchange = {
        id: `side-${exchangeIds.next}`,
        question: text,
        status: 'pending',
    };
    useAgentChatSideChatStore.setState(({ threads }) => ({
        threads: { ...threads, [terminalId]: [...(threads[terminalId] ?? []), exchange] },
    }));
    await answerExchange(terminalId, exchange);
}

/**
 * Asks a failed exchange again, with the answered exchanges before it as context.
 */
export async function retryAgentChatSideQuestion(
    terminalId: string,
    exchangeId: string,
): Promise<void> {
    const thread = useAgentChatSideChatStore.getState().threads[terminalId] ?? [];
    const exchange = thread.find(({ id }) => id === exchangeId);
    if (exchange?.status !== 'failed' || isAgentChatSideChatBusy(thread)) return;
    await answerExchange(terminalId, exchange);
}

/**
 * Forgets the Chat's side chat.
 */
export function discardAgentChatSideChat(terminalId: string): void {
    useAgentChatSideChatStore.setState(({ threads }) => {
        if (!(terminalId in threads)) return { threads };
        return { threads: omit(threads, [terminalId]) };
    });
}

/**
 * Discards the side chat once its tab is really closed, called as the tab unmounts. An unmount alone proves nothing: a
 * Session switch unmounts every tab of the Session left behind, and a pane move remounts the tab. The tab is closed
 * when its Chat is gone, or when its Session is on screen and its layout no longer lists the tab.
 */
export function discardAgentChatSideChatIfClosed(terminalId: string): void {
    const bootstrap = getBootstrap();
    const terminal = bootstrap?.terminals.find(({ id }) => id === terminalId);
    const isTabOpen = findPaneTabId({ kind: 'file', path: agentSideChatTabPath(terminalId) });
    const isSessionShown =
        terminal !== undefined &&
        getSessionState() !== undefined &&
        bootstrap?.selectedSessionId === terminal.sessionId;
    if (!terminal || (isSessionShown && !isTabOpen)) discardAgentChatSideChat(terminalId);
}

/**
 * "Convert to Session": opens a Chat of the same Agent in a new Session of the same Project, seeds it with the side
 * thread's answered Q&A as its first message, and selects it. The side chat is discarded only once the new Chat has
 * accepted the seed, so a failure leaves the thread intact to try again.
 */
export async function convertAgentChatSideChatToSession(terminalId: string): Promise<void> {
    const bootstrap = getBootstrap();
    const terminal = bootstrap?.terminals.find(({ id }) => id === terminalId);
    const session = bootstrap?.sessions.find(({ id }) => id === terminal?.sessionId);
    if (!terminal || !session || terminal.kind === 'shell') return;
    const exchanges = useAgentChatSideChatStore.getState().threads[terminalId] ?? [];
    if (agentChatSideHistory(exchanges).length === 0) return;
    await tryCommand(
        translate('agentChat.sideChat.convertFailed'),
        async () => {
            const created = await caxri.request('session.create', {
                projectId: session.projectId,
                defaultAgent: terminal.kind,
                surface: 'chat',
            });
            if (!created.terminal) return;
            await didSelectSession(created.session.id);
            const isSent = await didSendAgentChatMessage(created.terminal.id, {
                text: agentChatSideSeedPrompt(exchanges),
            });
            if (isSent) discardAgentChatSideChat(terminalId);
        },
        { refresh: refreshWorkbench },
    );
}
