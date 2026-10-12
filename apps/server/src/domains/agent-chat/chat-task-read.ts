import type { AgentChatTaskSnapshot } from '@caxri/protocol';
import { agentChatTaskSnapshotSchema, CaxriError } from '@caxri/protocol';

import type { AgentChatProviderSession } from './chat-provider';
import type { ChatState } from './chat-states';

/**
 * A task's own projection: the live one, or one rebuilt from the provider's record for a task this process never saw (a
 * resumed conversation, an evicted projection). `start` resumes the provider when nothing is running, and `isCurrent`
 * says whether `state` still owns the Chat once the provider answered.
 */
export async function readChatTask(
    state: ChatState,
    taskId: string,
    start: () => Promise<AgentChatProviderSession>,
    isCurrent: () => boolean,
): Promise<AgentChatTaskSnapshot> {
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
