import { createContext, useContext, useMemo, useRef, useState } from 'react';

import type { AgentChatSnapshot, AgentProviderCatalogEntry } from '@caxri/protocol';

import type { TranslationKey } from '../../../i18n';
import { forkAgentChat, restoreAgentChatFiles } from '../agent-chat-commands';
import {
    parseAgentChatEditAvailability,
    readAgentChatEdit,
    serializeAgentChatEditAvailability,
} from '../composer/agent-chat-edit';
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
    availability: (itemId: string) => TranslationKey | null | undefined;
    editingId: string | undefined;
    startEdit: (itemId: string, text: string) => void;
    /**
     * "Fork from here", absent when the host cannot show the forked Session (`AgentChatHostCapabilities.canFork`).
     * `availability` follows the same shape as the edit's.
     */
    fork?: {
        availability: (itemId: string) => TranslationKey | null | undefined;
        run: (itemId: string, text: string) => Promise<void>;
    };
    /**
     * "Restore code to here", absent when the provider cannot restore files. `availability` follows the same shape as
     * the edit's: `undefined` offers no action, a string disables it with that reason, `null` enables it.
     */
    restore?: {
        availability: (itemId: string) => TranslationKey | null | undefined;
        run: (itemId: string) => void;
    };
}

export const AgentChatEditContext = createContext<AgentChatEditActions | undefined>(undefined);

export function useAgentChatEdit(): AgentChatEditActions | undefined {
    return useContext(AgentChatEditContext);
}

/**
 * The Chat pane's "Edit from here", "Fork from here", and (when the provider restores files) "Restore code to here"
 * state, offered only when the provider can rewind (`chatRewind`): the actions its user messages read, the composer
 * handle that starts an edit, and the setter the composer reports the edited message through. The actions derive from
 * the serialized availability table, which a streamed delta leaves equal, so the context value keeps its identity and
 * does not re-render every user message.
 */
export function useAgentChatEditActions(
    terminalId: string,
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'> | undefined,
    {
        canFork,
        providerName,
        capabilities,
    }: {
        canFork: boolean;
        providerName: string;
        capabilities: Pick<
            AgentProviderCatalogEntry['capabilities'],
            'chatRewind' | 'chatRewindFiles'
        >;
    },
) {
    const { chatRewind: supportsRewind, chatRewindFiles: supportsRewindFiles } = capabilities;
    const composerEdit = useRef<AgentChatComposerEditHandle | null>(null);
    const [editingId, setEditingId] = useState(() => readAgentChatEdit(terminalId)?.itemId);
    const availability = useMemo(
        () => (snapshot ? serializeAgentChatEditAvailability(snapshot) : undefined),
        [snapshot],
    );
    const table = useMemo(
        () =>
            availability === undefined ? undefined : parseAgentChatEditAvailability(availability),
        [availability],
    );
    const editActions = useMemo<AgentChatEditActions | undefined>(() => {
        if (!table || !supportsRewind) return;
        return {
            availability: (itemId) => table.get(itemId)?.edit,
            editingId,
            startEdit: (itemId, text) => composerEdit.current?.startEdit(itemId, text),
            ...(canFork && {
                fork: {
                    availability: (itemId) => table.get(itemId)?.fork,
                    run: (itemId, text) => forkAgentChat(terminalId, { itemId, text }),
                },
            }),
            ...(supportsRewindFiles && {
                restore: {
                    availability: (itemId) => {
                        const restore = table.get(itemId)?.restore;
                        if (restore === undefined) return;
                        return typeof restore === 'string' ? restore : null;
                    },
                    run: (itemId) => {
                        const restore = table.get(itemId)?.restore;
                        if (typeof restore !== 'number') return;
                        void restoreAgentChatFiles(terminalId, {
                            itemId,
                            providerName,
                            restoredTurns: restore,
                        });
                    },
                },
            }),
        };
    }, [table, editingId, canFork, supportsRewind, supportsRewindFiles, terminalId, providerName]);
    return { composerEdit, editActions, setEditingId };
}
