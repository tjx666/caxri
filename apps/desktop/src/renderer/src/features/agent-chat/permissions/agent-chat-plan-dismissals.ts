import { createStore } from '../../../lib/store';

/**
 * Per Chat Terminal, the proposed plan whose approval card the user dismissed with Keep Planning. Only the latest plan
 * can show a card (`agentChatImplementablePlanId`), so one item id per Chat is all that needs remembering. Module state
 * so a pane remount does not bring the card back; it is not persisted, so a restart shows the card again for a plan the
 * user is still planning around, which is harmless.
 */
const useAgentChatPlanDismissalStore = createStore<Readonly<Record<string, string>>>(
    'agent-chat-plan-dismissals',
    () => ({}),
);

export function dismissAgentChatPlan(terminalId: string, itemId: string): void {
    useAgentChatPlanDismissalStore.setState({ [terminalId]: itemId });
}

/**
 * The plan item the user dismissed for this Chat, if any.
 */
export function useDismissedAgentChatPlanId(terminalId: string): string | undefined {
    return useAgentChatPlanDismissalStore((state) => state[terminalId]);
}
