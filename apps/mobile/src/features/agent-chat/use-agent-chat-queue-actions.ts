import { useCallback, useMemo, useState } from 'react';
import { Alert } from 'react-native';

import { useTranslation } from '../../i18n';
import type {
    AgentChatQueueEditTarget,
    AgentChatQueueError,
    AgentChatQueueRowAction,
} from './agent-chat-queue';
import {
    agentChatQueueEditAlert,
    agentChatQueueEditMode,
    agentChatQueueEntries,
    agentChatQueueErrorMessage,
    agentChatQueueFailure,
    agentChatQueueHeader,
    currentQueueError,
    didRunOptimisticQueueAction,
    prunePendingQueueIds,
} from './agent-chat-queue';
import type { AgentChatController } from './use-agent-chat';

/**
 * A queued message being edited where it stands (`agentChatQueueEditMode`), with the text its editor starts from.
 */
export interface AgentChatQueueInPlaceEdit extends AgentChatQueueEditTarget {
    id: string;
}

const errorCode = (error: unknown): string | undefined =>
    error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;

/**
 * The queue card's rows, header, and actions for one Chat. Delete, Steer, and Edit hide their row at once and restore
 * it with an inline error when the Server refuses; Resume shows its own busy state, since the header it lives in stays.
 * Edit of a plain message hands its full text to `onEdit` (the composer draft) only once the Server took it out of the
 * queue. Edit of a message with images or file references opens an in-place editor instead (`editing`, `saveEdit`,
 * `cancelEdit`): the draft would otherwise show the serialized reference block, and images cannot return to a
 * composer.
 */
export const useAgentChatQueueActions = (
    chat: Pick<
        AgentChatController,
        | 'editQueued'
        | 'pending'
        | 'readQueued'
        | 'removeQueued'
        | 'resumeQueue'
        | 'sendQueuedNow'
        | 'snapshot'
        | 'takeQueued'
    >,
    onEdit: (text: string) => void,
) => {
    const {
        editQueued,
        pending,
        readQueued,
        removeQueued,
        resumeQueue,
        sendQueuedNow,
        snapshot,
        takeQueued,
    } = chat;
    const { t } = useTranslation();
    const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
    const [storedError, setError] = useState<AgentChatQueueError | null>(null);
    const [isResuming, setResuming] = useState(false);
    const [editing, setEditing] = useState<AgentChatQueueInPlaceEdit | null>(null);
    const [isSavingEdit, setSavingEdit] = useState(false);
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
    /**
     * Reports a failed Edit: a message that left the queue, or is too long for a phone, gets an alert, since its row is
     * gone or cannot be retried; anything else an inline error on the card.
     */
    const reportEditFailure = useCallback(
        (error: unknown, id: string): void => {
            const failure = agentChatQueueFailure('edit', errorCode(error));
            if (failure === 'gone' || failure === 'tooLong') {
                const { title, message } = agentChatQueueEditAlert(failure, t);
                Alert.alert(title, message);
                return;
            }
            setError({ id, message: agentChatQueueErrorMessage('edit', t) });
        },
        [t],
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
    const edit = useCallback(
        async (id: string): Promise<boolean> => {
            setError(null);
            let target: AgentChatQueueEditTarget;
            try {
                target = await readQueued(id);
            } catch (error) {
                reportEditFailure(error, id);
                return false;
            }
            if (agentChatQueueEditMode(target) === 'draft') return run('edit', id);
            setEditing({ id, ...target });
            return true;
        },
        [readQueued, reportEditFailure, run],
    );
    const cancelEdit = useCallback((): void => setEditing(null), []);
    /**
     * Saves the in-place editor's text. A failure keeps the editor open with the typed text, so the edit can be retried
     * instead of lost; a message that left the queue meanwhile closes it with the alert.
     */
    const saveEdit = useCallback(
        async (text: string): Promise<void> => {
            if (!editing || isSavingEdit) return;
            setSavingEdit(true);
            try {
                await editQueued(editing.id, text);
                setEditing(null);
            } catch (error) {
                reportEditFailure(error, editing.id);
                if (agentChatQueueFailure('edit', errorCode(error)) === 'gone') setEditing(null);
            } finally {
                setSavingEdit(false);
            }
        },
        [editQueued, editing, isSavingEdit, reportEditFailure],
    );
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

    return {
        cancelEdit,
        edit,
        // A message the queue sent or another device removed meanwhile leaves nothing to edit.
        editing: editing && entries.some((entry) => entry.id === editing.id) ? editing : null,
        entries,
        error: error?.message,
        header,
        isResuming,
        isSavingEdit,
        remove,
        resume,
        saveEdit,
        sendNow,
    };
};
