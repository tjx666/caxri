import type { AgentChatMessageInput } from '@caxri/protocol';
import {
    AGENT_CHAT_IMPLEMENT_PLAN_MESSAGE,
    agentChatImplementablePlanId,
    CaxriError,
} from '@caxri/protocol';

import type { ChatStates } from '../chat-states';

/**
 * The slice of `AgentChatService` that approving a plan drives.
 */
export interface ChatPlanImplementHost {
    states: Pick<ChatStates, 'admitOpen'>;
    /**
     * Turns plan mode off for the next turn and saves it as the Chat's choice.
     */
    setPermission: (terminalId: string, request: { planMode: boolean }) => Promise<void>;
    send: (terminalId: string, message: Omit<AgentChatMessageInput, 'delivery'>) => Promise<void>;
}

/**
 * Approves a Codex Chat's proposed plan: leaves plan mode and starts the build turn as one Server step, because Codex
 * has no "implement this plan" request of its own (its TUI does the same two steps client-side). The plan must still be
 * the Chat's latest (`agentChatImplementablePlanId`), so a stale card fails with `CONFLICT`; a second click while the
 * first runs fails the same way, and one after it finds plan mode off.
 */
export class ChatPlanImplementations {
    private readonly running = new Set<string>();

    constructor(private readonly host: ChatPlanImplementHost) {}

    async implement(terminalId: string, itemId: string): Promise<void> {
        const state = this.host.states.admitOpen(terminalId);
        if (
            this.running.has(terminalId) ||
            agentChatImplementablePlanId(state.projection.snapshot) !== itemId
        )
            throw new CaxriError('CONFLICT', 'This plan is no longer the one to build');
        this.running.add(terminalId);
        try {
            await this.host.setPermission(terminalId, { planMode: false });
            await this.host.send(terminalId, { text: AGENT_CHAT_IMPLEMENT_PLAN_MESSAGE });
        } finally {
            this.running.delete(terminalId);
        }
    }
}
