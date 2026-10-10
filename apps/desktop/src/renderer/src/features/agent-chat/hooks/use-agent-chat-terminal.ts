import { createContext, useContext } from 'react';

/**
 * The Agent Terminal a Chat timeline belongs to, for rows that ask the Server about it (such as the skill a message
 * invoked). A task tab's read-only timeline provides none, so those rows stay plain.
 */
export const AgentChatTerminalContext = createContext<string | undefined>(undefined);

export function useAgentChatTerminal(): string | undefined {
    return useContext(AgentChatTerminalContext);
}
