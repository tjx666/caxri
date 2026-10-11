import { createContext, useContext } from 'react';

/**
 * What a Chat's user messages need to offer "Edit from here": which messages can start one, why the action is disabled
 * when it is, the message being edited now, and how to start an edit. Provided by the Chat pane; a task tab's read-only
 * timeline provides nothing, so its messages offer no edit.
 */
export interface AgentChatEditActions {
    /**
     * `undefined` when the message offers no edit; otherwise the reason the action is disabled, or `null` when enabled.
     */
    availability: (itemId: string) => string | null | undefined;
    editingId: string | undefined;
    startEdit: (itemId: string, text: string) => void;
}

export const AgentChatEditContext = createContext<AgentChatEditActions | undefined>(undefined);

export function useAgentChatEdit(): AgentChatEditActions | undefined {
    return useContext(AgentChatEditContext);
}
