import type { AgentChatMessageInput, AgentChatSnapshot } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { pageRequest } from './helpers';

export interface MobileAgentChatDriver {
    /**
     * Stops the active turn through the paired Desktop's public Chat action.
     */
    /**
     * Cancels the Chat's pending wait for a used-up plan limit, the notice's Cancel on Desktop.
     */
    cancelUsageWait(): Promise<void>;
    /**
     * Changes the Chat's next-turn choices (such as plan mode) through the paired Desktop's public Chat action.
     */
    configure(change: { planMode: boolean }): Promise<void>;
    interrupt(): Promise<void>;
    read(): Promise<AgentChatSnapshot>;
    /**
     * Runs a provider command such as `/goal` through the paired Desktop's public Chat action.
     */
    runCommand(command: { name: string; arguments?: string }): Promise<void>;
    /**
     * Submits Desktop-side messages, including synthetic image input.
     */
    send(message: AgentChatMessageInput): Promise<void>;
    terminalId: string;
}

/**
 * Keeps fixture actions on the same public Chat boundary as the paired Desktop.
 */
export function createMobileAgentChatDriver(page: Page, terminalId: string): MobileAgentChatDriver {
    return {
        cancelUsageWait: async () => {
            const snapshot = await pageRequest<AgentChatSnapshot>(page, 'agentChat.read', {
                terminalId,
            });
            const failure = snapshot.items.findLast(
                (item) => item.type === 'notice' && item.usageLimit && item.turnId,
            );
            if (!failure?.turnId) throw new Error('The Chat has no usage-limit failure to cancel');
            await pageRequest<void>(page, 'agentChat.usageLimitWait', {
                terminalId,
                turnId: failure.turnId,
                action: 'cancel',
            });
        },
        configure: (change) =>
            pageRequest<void>(page, 'agentChat.configure', { terminalId, ...change }),
        interrupt: () => pageRequest<void>(page, 'agentChat.interrupt', { terminalId }),
        read: () => pageRequest<AgentChatSnapshot>(page, 'agentChat.read', { terminalId }),
        runCommand: (command) =>
            pageRequest<void>(page, 'agentChat.runCommand', { terminalId, ...command }),
        send: (message) => pageRequest<void>(page, 'agentChat.send', { terminalId, ...message }),
        terminalId,
    };
}
