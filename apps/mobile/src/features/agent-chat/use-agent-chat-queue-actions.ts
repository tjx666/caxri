import { useCallback, useMemo, useState } from 'react';

import type { AgentChatQueueError } from './agent-chat-queue';
import {
    AGENT_CHAT_QUEUE_ERRORS,
    agentChatQueueEntries,
    agentChatQueueHeader,
    currentQueueError,
    didRunOptimisticQueueAction,
    prunePendingQueueIds,
} from './agent-chat-queue';
import type { AgentChatController } from './use-agent-chat';

/**
 * The queue card's rows, header, and actions for one Chat. Delete and Steer hide their row at once and restore it with
 * an inline error when the Server refuses; Resume shows its own busy state, since the header it lives in stays.
 */
export const useAgentChatQueueActions = (
    chat: Pick<AgentChatController, 'removeQueued' | 'resumeQueue' | 'sendQueuedNow' | 'snapshot'>,
) => {
    const { removeQueued, resumeQueue, sendQueuedNow, snapshot } = chat;
    const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
    const [storedError, setError] = useState<AgentChatQueueError | null>(null);
    const [isResuming, setResuming] = useState(false);
    const queue = snapshot?.queue;
    // Adjusting state during render (not in an effect) drops a stale error before it paints with the next queue.
    const error = currentQueueError(storedError, queue);
    if (error !== storedError) setError(error);
    const isTurnRunning = snapshot?.activeTurnId !== undefined;
    const livePendingIds = useMemo(
        () => prunePendingQueueIds(pendingIds, queue),
        [pendingIds, queue],
    );
    const entries = useMemo(
        () => agentChatQueueEntries(queue, isTurnRunning, livePendingIds),
        [isTurnRunning, livePendingIds, queue],
    );
    const header = agentChatQueueHeader(snapshot, isTurnRunning, entries.length);

    const hide = useCallback((id: string): void => {
        setPendingIds((current) => new Set([...current, id]));
    }, []);
    const reveal = useCallback((id: string): void => {
        setPendingIds((current) => new Set([...current].filter((pending) => pending !== id)));
    }, []);
    const run = useCallback(
        (action: 'remove' | 'sendNow', id: string): Promise<boolean> =>
            didRunOptimisticQueueAction({
                action,
                hide,
                id,
                perform: action === 'remove' ? removeQueued : sendQueuedNow,
                reportError: (message) => setError(message === null ? null : { id, message }),
                reveal,
            }),
        [hide, removeQueued, reveal, sendQueuedNow],
    );
    const remove = useCallback((id: string): Promise<boolean> => run('remove', id), [run]);
    const sendNow = useCallback((id: string): Promise<boolean> => run('sendNow', id), [run]);
    const resume = useCallback(async (): Promise<void> => {
        setError(null);
        setResuming(true);
        try {
            await resumeQueue();
        } catch {
            setError({ message: AGENT_CHAT_QUEUE_ERRORS.resume });
        } finally {
            setResuming(false);
        }
    }, [resumeQueue]);

    return { entries, error: error?.message, header, isResuming, remove, resume, sendNow };
};
