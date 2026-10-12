import { createContext, useContext, useMemo, useRef, useState } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatRewindableMessageIds } from '@caxri/protocol';

import { forkAgentChat, restoreAgentChatFiles } from '../agent-chat-commands';
import {
    agentChatEditAvailability,
    agentChatForkAvailability,
    agentChatRestoreAvailability,
    readAgentChatEdit,
} from '../agent-chat-edit';
import type { AgentChatComposerEditHandle } from './use-agent-chat-composer-edit';

/**
 * What a Chat's user messages need to offer "Edit from here" and "Fork from here": which messages offer them, why an
 * action is disabled when it is, the message being edited now, and how to start an edit or a fork. Provided by the Chat
 * pane; a task tab's read-only timeline provides nothing, so its messages offer neither.
 */
export interface AgentChatEditActions {
    /**
     * `undefined` when the message offers no edit; otherwise the reason the action is disabled, or `null` when enabled.
     */
    availability: (itemId: string) => string | null | undefined;
    editingId: string | undefined;
    startEdit: (itemId: string, text: string) => void;
    /**
     * "Fork from here", absent when the host cannot show the forked Session (`AgentChatHostCapabilities.canFork`).
     * `availability` follows the same shape as the edit's.
     */
    fork?: {
        availability: (itemId: string) => string | null | undefined;
        run: (itemId: string, text: string) => Promise<void>;
    };
    /**
     * "Restore code to here", absent when the provider cannot restore files. `availability` follows the same shape as
     * the edit's: `undefined` offers no action, a string disables it with that reason, `null` enables it.
     */
    restore?: {
        availability: (itemId: string) => string | null | undefined;
        run: (itemId: string) => void;
    };
}

export const AgentChatEditContext = createContext<AgentChatEditActions | undefined>(undefined);

export function useAgentChatEdit(): AgentChatEditActions | undefined {
    return useContext(AgentChatEditContext);
}

/**
 * The Chat pane's "Edit from here", "Fork from here", and (when the provider restores files) "Restore code to here"
 * state: the actions its user messages read, the composer handle that starts an edit, and the setter the composer
 * reports the edited message through. The actions are memoized on what the availability reads, so a streamed delta does
 * not re-render every user message.
 */
export function useAgentChatEditActions(
    terminalId: string,
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'> | undefined,
    {
        canFork,
        providerName,
        supportsRewindFiles,
    }: { canFork: boolean; providerName: string; supportsRewindFiles: boolean },
) {
    const composerEdit = useRef<AgentChatComposerEditHandle | null>(null);
    const [editingId, setEditingId] = useState(() => readAgentChatEdit(terminalId)?.itemId);
    const items = snapshot?.items;
    const turns = snapshot?.turns;
    const activeTurnId = snapshot?.activeTurnId;
    const editActions = useMemo<AgentChatEditActions | undefined>(() => {
        if (!items || !turns) return;
        const rewindable = agentChatRewindableMessageIds({ items, turns, activeTurnId });
        return {
            availability: (itemId) => {
                if (!rewindable.has(itemId)) return;
                const availability = agentChatEditAvailability(
                    { items, turns, activeTurnId },
                    itemId,
                );
                return availability.canEdit ? null : availability.reason;
            },
            editingId,
            startEdit: (itemId, text) => composerEdit.current?.startEdit(itemId, text),
            ...(canFork && {
                fork: {
                    availability: (itemId) => {
                        if (!rewindable.has(itemId)) return;
                        const availability = agentChatForkAvailability(
                            { items, turns, activeTurnId },
                            itemId,
                        );
                        return availability.canFork ? null : availability.reason;
                    },
                    run: (itemId, text) => forkAgentChat(terminalId, itemId, text),
                },
            }),
            ...(supportsRewindFiles && {
                restore: {
                    availability: (itemId) => {
                        if (!rewindable.has(itemId)) return;
                        const availability = agentChatRestoreAvailability(
                            { items, turns, activeTurnId },
                            itemId,
                        );
                        return 'reason' in availability ? availability.reason : null;
                    },
                    run: (itemId) => {
                        const availability = agentChatRestoreAvailability(
                            { items, turns, activeTurnId },
                            itemId,
                        );
                        if ('reason' in availability) return;
                        // eslint-disable-next-line no-void -- tryCommand reports a failure through the toast
                        void restoreAgentChatFiles(terminalId, {
                            itemId,
                            providerName,
                            restoredTurns: availability.restoredTurns,
                        });
                    },
                },
            }),
        };
    }, [
        items,
        turns,
        activeTurnId,
        editingId,
        canFork,
        supportsRewindFiles,
        terminalId,
        providerName,
    ]);
    return { composerEdit, editActions, setEditingId };
}
