import type { AgentProvider } from '@caxri/protocol';

import type { AgentChatDriver } from './chat-provider';
import { antigravityChatDriver } from './providers/antigravity/chat-session';
import { claudeChatDriver } from './providers/claude/chat-session';
import { codexChatDriver } from './providers/codex/chat-session';
import { grokChatDriver } from './providers/grok/chat-session';

/**
 * The Chat implementation for each provider. Exhaustive so a provider added to the catalog fails closed here until it
 * has a structured driver (`undefined`); `capabilities.chat` in the catalog must agree.
 */
export const agentChatDrivers: Record<AgentProvider, AgentChatDriver | undefined> = {
    claude: claudeChatDriver,
    codex: codexChatDriver,
    grok: grokChatDriver,
    antigravity: antigravityChatDriver,
};
