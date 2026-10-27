import type { AgentChatMessageInput, AgentChatSnapshot } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { pageRequest } from './helpers';

export interface MobileAgentChatDriver {
    /**
     * Stops the active turn through the paired Desktop's public Chat action.
     */
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
        interrupt: () => pageRequest<void>(page, 'agentChat.interrupt', { terminalId }),
        read: () => pageRequest<AgentChatSnapshot>(page, 'agentChat.read', { terminalId }),
        runCommand: (command) =>
            pageRequest<void>(page, 'agentChat.runCommand', { terminalId, ...command }),
        send: (message) => pageRequest<void>(page, 'agentChat.send', { terminalId, ...message }),
        terminalId,
    };
}
