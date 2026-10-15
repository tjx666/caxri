import { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';

import { useTranslation } from '../../i18n';
import type { AgentChatQueueError, AgentChatQueueRowAction } from './agent-chat-queue';
import {
    agentChatQueueEditAlert,
    agentChatQueueEntries,
    agentChatQueueErrorMessage,
    agentChatQueueHeader,
    currentQueueError,
    didRunOptimisticQueueAction,
    prunePendingQueueIds,
} from './agent-chat-queue';
import type { AgentChatController } from './use-agent-chat';

/**
 * The queue card's rows, header, and actions for one Chat. Delete, Steer, and Edit hide their row at once and restore
 * it with an inline error when the Server refuses; Resume shows its own busy state, since the header it lives in stays.
 * Edit hands the message's full text to `onEdit` (the composer draft) only once the Server took it out of the queue.
 */
export const useAgentChatQueueActions = (
    chat: Pick<
        AgentChatController,
        'pending' | 'removeQueued' | 'resumeQueue' | 'sendQueuedNow' | 'snapshot' | 'takeQueued'
    >,
    onEdit: (text: string) => void,
) => {
    const { pending, removeQueued, resumeQueue, sendQueuedNow, snapshot, takeQueued } = chat;
    const { t } = useTranslation();
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
        () => agentChatQueueEntries(queue, isTurnRunning, livePendingIds, pending.queue),
        [isTurnRunning, livePendingIds, pending.queue, queue],
    );
    const header = agentChatQueueHeader(snapshot, isTurnRunning, entries.length, t);

    const hide = useCallback((id: string): void => {
        setPendingIds((current) => new Set([...current, id]));
    }, []);
    const reveal = useCallback((id: string): void => {
        setPendingIds((current) => new Set([...current].filter((pending) => pending !== id)));
    }, []);
    const takeForEdit = useCallback(
        async (id: string): Promise<void> => {
            onEdit(await takeQueued(id));
        },
        [onEdit, takeQueued],
    );
    const run = useCallback(
        (action: AgentChatQueueRowAction, id: string): Promise<boolean> =>
            didRunOptimisticQueueAction({
                action,
                hide,
                id,
                perform: { remove: removeQueued, sendNow: sendQueuedNow, edit: takeForEdit }[
                    action
                ],
                reportError: (message, failure) => {
                    if (action === 'edit' && (failure === 'gone' || failure === 'tooLong')) {
                        const { title, message: detail } = agentChatQueueEditAlert(failure, t);
                        Alert.alert(title, detail);
                        return;
                    }
                    setError(message === null ? null : { id, message });
                },
                reveal,
                t,
            }),
        [hide, removeQueued, reveal, sendQueuedNow, t, takeForEdit],
    );
    const remove = useCallback((id: string): Promise<boolean> => run('remove', id), [run]);
    const sendNow = useCallback((id: string): Promise<boolean> => run('sendNow', id), [run]);
    const edit = useCallback((id: string): Promise<boolean> => run('edit', id), [run]);
    const resume = useCallback(async (): Promise<void> => {
        setError(null);
        setResuming(true);
        try {
            await resumeQueue();
        } catch {
            setError({ message: agentChatQueueErrorMessage('resume', t) });
        } finally {
            setResuming(false);
        }
    }, [resumeQueue, t]);

    return { edit, entries, error: error?.message, header, isResuming, remove, resume, sendNow };
};
