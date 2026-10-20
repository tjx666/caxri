import type { AgentChatHistoryPage, AgentChatTaskSnapshot } from '@caxri/protocol';
import {
    agentChatHistoryPageSchema,
    agentChatTaskSnapshotSchema,
    CaxriError,
} from '@caxri/protocol';

import { requireChatTerminal } from './chat-launch';
import type { AgentChatProviderSession } from './chat-provider';
import type { ChatState, ChatStates } from './chat-states';

/**
 * What a task read needs from the service: the Chat Terminals, the live Chat states, and a way to start a Chat's
 * provider.
 */
export interface ChatTaskHost {
    database: Parameters<typeof requireChatTerminal>[0];
    states: ChatStates;
    ensureStarted: (terminalId: string, state: ChatState) => Promise<AgentChatProviderSession>;
}

/**
 * The Chat's state with a provider start for it, and whether that state still owns the Chat once the provider answered.
 */
function openTask(
    host: ChatTaskHost,
    terminalId: string,
): [ChatState, () => Promise<AgentChatProviderSession>, () => boolean] {
    requireChatTerminal(host.database, terminalId);
    const state = host.states.open(terminalId);
    return [
        state,
        () => host.ensureStarted(terminalId, state),
        () => host.states.get(terminalId) === state,
    ];
}

/**
 * A task's own projection: the live one, or one rebuilt from the provider's record for a task this process never saw (a
 * resumed conversation, an evicted projection). `start` resumes the provider when nothing is running, and `isCurrent`
 * says whether `state` still owns the Chat once the provider answered.
 */
export async function readChatTask(
    host: ChatTaskHost,
    terminalId: string,
    taskId: string,
): Promise<AgentChatTaskSnapshot> {
    const [state, start, isCurrent] = openTask(host, terminalId);
    state.projection.flush();
    const live = state.projection.tasks.resolve(taskId);
    const listed = state.projection.snapshot.tasks?.find(
        (task) => task.id === taskId || task.itemId === taskId,
    );
    // Opening a running shell's tab confirms the provider still runs it; the list patch follows.
    if (listed?.kind === 'shell' && listed.status === 'running' && state.session?.isOpen)
        // eslint-disable-next-line no-void -- best effort: an unreadable list leaves the tasks as they are
        void state.session.refreshTasks?.().catch(() => {});
    if (live) return agentChatTaskSnapshotSchema.parse(live);
    let session: AgentChatProviderSession;
    try {
        session = await start();
    } catch {
        throw new CaxriError('NOT_FOUND', 'This task is no longer available');
    }
    const history = await session.readTaskHistory(taskId);
    if (!history || !isCurrent())
        throw new CaxriError('NOT_FOUND', 'This task is no longer available');
    return agentChatTaskSnapshotSchema.parse(state.projection.tasks.install(history));
}

/**
 * The page of a task's history right before `beforeItemId`, read from the items the task's projection evicted. A task
 * this process no longer holds is rebuilt from the provider's record first, which archives what its budget cuts. An
 * unknown cursor returns an empty page, like the Chat's own history.
 */
export async function readChatTaskHistory(
    host: ChatTaskHost,
    terminalId: string,
    taskId: string,
    beforeItemId: string,
): Promise<AgentChatHistoryPage> {
    const { taskId: id } = await readChatTask(host, terminalId, taskId);
    const page = host.states
        .open(terminalId)
        .projection.tasks.readHistoryPage(id, beforeItemId) ?? {
        historyId: id,
        items: [],
        turns: [],
        hasMore: false,
        truncated: false,
    };
    return agentChatHistoryPageSchema.parse(page);
}

/**
 * Stops a running task the provider can stop. `state` is the Chat's live state, if any; a task that already settled, or
 * a Chat whose provider is not running, is a `CONFLICT`.
 */
export async function stopChatTask(state: ChatState | undefined, taskId: string): Promise<void> {
    const task = state?.projection.snapshot.tasks?.find(
        (candidate) => candidate.id === taskId || candidate.itemId === taskId,
    );
    if (!state?.session?.isOpen || task?.status !== 'running' || !task.canStop)
        throw new CaxriError('CONFLICT', 'This task is no longer running');
    await state.session.stopTask(task.id);
}
