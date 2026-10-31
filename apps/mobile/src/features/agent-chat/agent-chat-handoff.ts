import { createContext } from 'react';

import type { AgentProvider, MobileContinuationOrigin } from '@caxri/protocol';
import {
    AGENT_CHAT_SESSION_HANDOFF_COMMAND,
    agentChatSessionHandoffMessage,
    parseAgentChatSessionHandoffCommand,
} from '@caxri/protocol';

/**
 * Who a Chat belongs to, as the hand-off needs it: the Session the Agent hands off from, its Project, and the Agent.
 */
export interface AgentChatHandoffSource {
    projectId: string | undefined;
    providerId: AgentProvider | undefined;
    sessionId: string;
}

/**
 * The message a `/new-session [next task]` draft sends: the hand-off instructions naming the Chat's own Project and
 * Agent (`agentChatSessionHandoffMessage`, shared with Desktop). `undefined` for a draft that is not the command, and
 * `null` when it is but the Project or Agent is unknown, so the caller reports it instead of sending the literal
 * command to the Agent.
 */
export const agentChatHandoffText = (
    draft: string,
    source: AgentChatHandoffSource,
): string | null | undefined => {
    if (parseAgentChatSessionHandoffCommand(draft) === undefined) return undefined;
    const text = agentChatSessionHandoffMessage(
        draft,
        source.providerId
            ? { kind: source.providerId, provider: source.providerId, sessionId: source.sessionId }
            : undefined,
        source.projectId ? [{ id: source.sessionId, projectId: source.projectId }] : undefined,
    );
    return text === draft ? null : text;
};

/**
 * The `/new-session` draft that starts an issue in a new Session: its reference and URL, so the Agent reads the issue
 * itself rather than retelling it from memory. Desktop sends the same draft from its issue card.
 */
export const agentChatIssueHandoffDraft = (issue: { reference: string; url: string }): string =>
    `/${AGENT_CHAT_SESSION_HANDOFF_COMMAND} Work on ${issue.reference}: ${issue.url}`;

/**
 * Sends a `/new-session` draft from the Chat as if typed in its composer, without touching the draft the user is
 * writing. Provided by the Chat view for the cards inside its timeline; absent outside a Chat that can send.
 */
export const AgentChatHandoffStarter = createContext<
    ((draft: string) => Promise<void>) | undefined
>(undefined);

/**
 * The Chat's own Session, which a hand-off message needs to find the Session it created.
 */
export const AgentChatSessionId = createContext<string | undefined>(undefined);

/**
 * Opens Continue in Another Agent for the Chat from a card in its timeline or its usage guard card, with the failure
 * it continues from. Provided by the Chat view for a control device only, as only that role may continue; absent
 * otherwise, so the cards offer nothing.
 */
export const AgentChatContinuer = createContext<
    { isConnected: boolean; open: (origin: MobileContinuationOrigin) => void } | undefined
>(undefined);
