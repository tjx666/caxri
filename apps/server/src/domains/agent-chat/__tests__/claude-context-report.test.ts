import type { AgentChatContextComposition } from '@caxri/protocol';
import { agentChatContextCompositionSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { claudeContextComposition, ClaudeContextLedger } from '../claude-context-report';
import { claudeContextRequests } from '../claude-context-requests';

function assistant(
    id: string,
    timestamp: string,
    usage: Record<string, unknown>,
    extra: Record<string, unknown> = {},
): string {
    return JSON.stringify({
        type: 'assistant',
        timestamp,
        message: { id, model: 'claude-opus-4-5', usage },
        ...extra,
    });
}

describe('claudeContextRequests', () => {
    const usage = {
        input_tokens: 2,
        cache_read_input_tokens: 13_000,
        cache_creation_input_tokens: 4_000,
        output_tokens: 300,
        cache_creation: { ephemeral_1h_input_tokens: 4_000, ephemeral_5m_input_tokens: 0 },
    };

    it('counts each response once, from its first content block', () => {
        const transcript = [
            assistant('msg-1', '2026-01-01T00:00:00.000Z', usage),
            assistant('msg-1', '2026-01-01T00:00:02.000Z', usage),
            assistant('msg-2', '2026-01-01T00:00:05.000Z', {
                ...usage,
                cache_read_input_tokens: 17_002,
            }),
        ].join('\n');

        const requests = claudeContextRequests(transcript);

        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
            at: Date.parse('2026-01-01T00:00:00.000Z'),
            model: 'claude-opus-4-5',
            input: 2,
            cacheRead: 13_000,
            cacheWrite: 4_000,
            output: 300,
            cacheTtlMinutes: 60,
        });
        expect(requests[0].cacheWriteUsd).toBeGreaterThan(0);
        expect(requests[1].cacheRead).toBe(17_002);
    });

    it('skips subagent, synthetic, and malformed records, and marks the request after a compaction', () => {
        const transcript = [
            assistant('side', '2026-01-01T00:00:00.000Z', usage, { isSidechain: true }),
            JSON.stringify({
                type: 'assistant',
                timestamp: '2026-01-01T00:00:01.000Z',
                message: { id: 'synthetic', model: '<synthetic>', usage },
            }),
            'not json "assistant"',
            assistant('no-time', 'yesterday', usage),
            JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
            assistant('after', '2026-01-01T00:01:00.000Z', usage),
            assistant('next', '2026-01-01T00:01:05.000Z', usage),
        ].join('\n');

        const requests = claudeContextRequests(transcript);

        expect(requests.map((request) => request.afterCompaction)).toEqual([true, undefined]);
    });
});

describe('claudeContextComposition', () => {
    it('keeps every list Claude Code reports, within the protocol bounds', () => {
        const composition = claudeContextComposition({
            totalTokens: 87_900,
            rawMaxTokens: 280_000,
            model: 'claude-opus-4-5',
            autoCompactThreshold: 247_000,
            isAutoCompactEnabled: true,
            categories: [
                { name: 'System prompt', tokens: 1_900, kind: 'used' },
                { name: 'System tools (deferred)', tokens: 12_000, kind: 'deferred' },
                { name: 'Mystery', tokens: 1, kind: 'other' },
            ],
            memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 900 }],
            skills: {
                totalSkills: 3,
                includedSkills: 2,
                tokens: 400,
                skillFrontmatter: [{ name: 'review', source: 'projectSettings', tokens: 200 }, {}],
            },
            mcpTools: [
                { name: 'mcp__docs__search', serverName: 'docs', tokens: 300, isLoaded: false },
                { name: 'mcp__docs__read', serverName: 'docs', tokens: 200 },
            ],
            agents: [{ agentType: 'reviewer', source: 'projectSettings', tokens: 120 }],
            slashCommands: { totalCommands: 10, includedCommands: 9, tokens: 500 },
            messageBreakdown: {
                toolCallTokens: 100,
                toolResultTokens: 5_000,
                attachmentTokens: 50,
                assistantMessageTokens: 400,
                userMessageTokens: 80,
                redirectedContextTokens: 5,
                unattributedTokens: 10,
                toolCallsByType: [{ name: 'Read', callTokens: 40, resultTokens: 4_000 }],
                attachmentsByType: [{ name: 'hook_success', tokens: 50 }],
            },
        });

        expect(agentChatContextCompositionSchema.parse(composition)).toEqual(composition);
        expect(composition).toMatchObject({
            totalTokens: 87_900,
            window: 280_000,
            autoCompactThreshold: 247_000,
            categories: [
                { label: 'System prompt', tokens: 1_900, kind: 'used' },
                { label: 'System tools (deferred)', tokens: 12_000, kind: 'deferred' },
            ],
            skills: { total: 3, included: 2, items: [{ name: 'review' }] },
            mcpTools: [
                { name: 'mcp__docs__search', server: 'docs', isLoaded: false },
                { name: 'mcp__docs__read', server: 'docs', isLoaded: true },
            ],
            agents: [{ type: 'reviewer' }],
            messages: { toolResults: 5_000, other: 15, tools: [{ name: 'Read' }] },
        });
    });

    it('rejects an answer without a total', () => {
        expect(claudeContextComposition({ categories: [] })).toBeUndefined();
        expect(claudeContextComposition('nope')).toBeUndefined();
    });
});

describe('ClaudeContextLedger', () => {
    const base: AgentChatContextComposition = {
        totalTokens: 10_000,
        window: 200_000,
        isAutoCompactEnabled: true,
        categories: [
            { label: 'System prompt', tokens: 2_000, kind: 'used' },
            { label: 'System tools', tokens: 6_000, kind: 'used' },
        ],
        memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 900 }],
        skills: {
            total: 1,
            included: 1,
            tokens: 100,
            items: [{ name: 'a', source: 'x', tokens: 100 }],
        },
        mcpTools: [{ name: 'mcp__docs__read', server: 'docs', tokens: 200, isLoaded: true }],
        agents: [],
    };

    it('records nothing for the first read or an unchanged prefix', () => {
        const ledger = new ClaudeContextLedger();
        ledger.record(base, 1);
        ledger.record({ ...base, totalTokens: 20_000 }, 2);

        expect(ledger.changes).toEqual([]);
    });

    it('names what changed between two reads', () => {
        const ledger = new ClaudeContextLedger();
        ledger.record(base, 1);
        ledger.record(
            {
                ...base,
                categories: [
                    { label: 'System prompt', tokens: 2_010, kind: 'used' },
                    { label: 'System tools', tokens: 7_000, kind: 'used' },
                ],
                memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 1_200 }],
                skills: { ...base.skills!, items: [{ name: 'b', source: 'x', tokens: 100 }] },
                mcpTools: [
                    ...base.mcpTools,
                    { name: 'mcp__linear__list', server: 'linear', tokens: 300, isLoaded: true },
                ],
                agents: [{ type: 'reviewer', source: 'projectSettings', tokens: 50 }],
            },
            2,
        );

        expect(ledger.changes).toEqual([
            { at: 2, kind: 'mcpToolsAdded', names: ['mcp__linear__list'] },
            { at: 2, kind: 'skillsAdded', names: ['b'] },
            { at: 2, kind: 'skillsRemoved', names: ['a'] },
            { at: 2, kind: 'agentsChanged', names: ['reviewer'] },
            { at: 2, kind: 'memoryChanged', names: ['/repo/CLAUDE.md'] },
            { at: 2, kind: 'systemToolsChanged', names: [], tokenDelta: 1_000 },
        ]);
    });
});
