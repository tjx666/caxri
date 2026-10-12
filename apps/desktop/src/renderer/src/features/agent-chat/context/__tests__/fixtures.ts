import type { AgentChatContextComposition, AgentChatContextRequest } from '@caxri/protocol';

export const MINUTE = 60_000;

export function request(
    at: number,
    usage: Partial<AgentChatContextRequest> = {},
): AgentChatContextRequest {
    return { at, input: 2, cacheRead: 0, cacheWrite: 0, output: 100, ...usage };
}

export function composition(
    overrides: Partial<AgentChatContextComposition> = {},
): AgentChatContextComposition {
    return {
        model: 'claude-opus-4-5',
        totalTokens: 60_000,
        window: 200_000,
        autoCompactThreshold: 167_000,
        isAutoCompactEnabled: true,
        categories: [
            { label: 'Messages', tokens: 30_000, kind: 'used' },
            { label: 'System prompt', tokens: 3_000, kind: 'used' },
            { label: 'Free space', tokens: 107_000, kind: 'free' },
            { label: 'System tools', tokens: 12_000, kind: 'used' },
            { label: 'MCP tools', tokens: 15_000, kind: 'used' },
            { label: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
            { label: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
        ],
        memoryFiles: [{ path: '/repo/AGENTS.md', type: 'Project', tokens: 6_000 }],
        mcpTools: [
            { name: 'mcp__github__search', server: 'github', tokens: 4_000, isLoaded: true },
            { name: 'mcp__github__create_pr', server: 'github', tokens: 7_000, isLoaded: true },
            { name: 'mcp__linear__list', server: 'linear', tokens: 4_000, isLoaded: true },
            { name: 'mcp__docs__read', server: 'docs', tokens: 9_000, isLoaded: false },
        ],
        agents: [],
        ...overrides,
    };
}
