import type { AgentProvider } from '@caxri/protocol';

import type { AgentChatDriver } from './chat-provider';
import { claudeChatDriver } from './claude-chat-session';
import { codexChatDriver } from './codex-chat-session';

/**
 * The Chat implementation for each provider. Exhaustive so a provider added to the catalog fails closed here until it
 * has a structured driver; `capabilities.chat` in the catalog must agree.
 */
export const agentChatDrivers: Record<AgentProvider, AgentChatDriver | undefined> = {
    claude: claudeChatDriver,
    codex: codexChatDriver,
    grok: undefined,
};
