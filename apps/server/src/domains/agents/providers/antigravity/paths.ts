import { join } from 'node:path';

import type { AgentEnvironment } from '../../contract';

/**
 * Antigravity keeps its CLI state under `~/.gemini/antigravity-cli` and reads no environment variable that relocates
 * it; only `agy acp`'s `--gemini-dir` flag does. Verified against `agy` 1.4.11.
 */
export function antigravityStateDirectory(environment: AgentEnvironment): string {
    return join(environment.homeDirectory, '.gemini', 'antigravity-cli');
}

/**
 * The user-global hooks file every `agy` process reads, shared with Antigravity's other Gemini-based surfaces.
 */
export function antigravityHooksPath(environment: AgentEnvironment): string {
    return join(environment.homeDirectory, '.gemini', 'config', 'hooks.json');
}

/**
 * The per-conversation record whose presence proves a conversation can be resumed locally.
 */
export function antigravityConversationPath(
    environment: AgentEnvironment,
    conversationId: string,
): string {
    return join(antigravityStateDirectory(environment), 'conversations', `${conversationId}.db`);
}
