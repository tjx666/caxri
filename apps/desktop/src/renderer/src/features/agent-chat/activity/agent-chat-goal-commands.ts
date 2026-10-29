import type { AgentChatGoalChange } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND, agentChatGoalArguments } from '@caxri/protocol';

import { didRunAgentChatCommand } from '../agent-chat-commands';

/**
 * Chat Terminals whose goal row has a change in flight.
 */
const changingGoals = new Set<string>();

/**
 * Sets, pauses, resumes, or clears the Chat's goal outside the composer (its goal row, a user message's Set as Goal),
 * through the same `/goal` command the composer runs. A click while an earlier change is in flight is dropped: a Claude Code clear first stops the goal's turn and waits
 * for it to end, and a second click meanwhile would only queue another `/goal clear`.
 */
export async function changeAgentChatGoal(
    terminalId: string,
    change: AgentChatGoalChange,
): Promise<void> {
    if (changingGoals.has(terminalId)) return;
    changingGoals.add(terminalId);
    try {
        await didRunAgentChatCommand(terminalId, {
            name: AGENT_CHAT_GOAL_COMMAND,
            arguments: agentChatGoalArguments(change),
        });
    } finally {
        changingGoals.delete(terminalId);
    }
}
