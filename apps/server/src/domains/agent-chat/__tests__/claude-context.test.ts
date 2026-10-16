import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    claudeCacheTtlMinutes,
    claudeContextDetails,
    ClaudeContextRefresh,
    refreshClaudeContextDetails,
} from '../claude-context';
import { ClaudeContextTracker } from '../claude-context-report';

describe('claudeCacheTtlMinutes', () => {
    it('reads the cache lifetime from the split of a cache write', () => {
        expect(
            claudeCacheTtlMinutes({
                cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 20 },
            }),
        ).toBe(60);
        expect(
            claudeCacheTtlMinutes({
                cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 20 },
            }),
        ).toBe(5);
    });

    it('says nothing when the response wrote no cache', () => {
        expect(
            claudeCacheTtlMinutes({
                cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            }),
        ).toBeUndefined();
        expect(claudeCacheTtlMinutes({ input_tokens: 10 })).toBeUndefined();
        expect(claudeCacheTtlMinutes(undefined)).toBeUndefined();
    });
});

describe('claudeContextDetails', () => {
    const categories = [
        { name: 'System prompt', tokens: 3000, kind: 'used' },
        { name: 'Messages', tokens: 0, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 900, kind: 'deferred' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
        { name: 'Free space', tokens: 120_000, kind: 'free' },
    ];

    it('keeps the rows that fill the window and the smaller compaction window', () => {
        expect(claudeContextDetails({ categories, rawMaxTokens: 280_000 }, 1_000_000)).toEqual({
            breakdown: [
                { label: 'System prompt', tokens: 3000 },
                { label: 'Autocompact buffer', tokens: 33_000 },
            ],
            compactWindow: 280_000,
        });
    });

    it('omits a compaction window that is the model window itself', () => {
        expect(claudeContextDetails({ categories: [], rawMaxTokens: 200_000 }, 200_000)).toEqual(
            {},
        );
        expect(claudeContextDetails('not a response', 200_000)).toEqual({});
    });

    it('names no compaction window while auto-compact is off', () => {
        expect(
            claudeContextDetails(
                { categories: [], rawMaxTokens: 280_000, isAutoCompactEnabled: false },
                1_000_000,
            ),
        ).toEqual({});
    });
});

describe('ClaudeContextRefresh', () => {
    it('keeps one request in flight and collapses the ones made meanwhile into one more', async () => {
        const pending: Array<() => void> = [];
        let calls = 0;
        const refresh = new ClaudeContextRefresh(async () => {
            calls += 1;
            await new Promise<void>((resolve) => pending.push(resolve));
        });
        refresh.request();
        refresh.request();
        refresh.request();
        expect(calls).toBe(1);
        pending.shift()?.();
        await vi.waitFor(() => expect(calls).toBe(2));
        pending.shift()?.();
        await Promise.resolve();
        refresh.request();
        await vi.waitFor(() => expect(calls).toBe(3));
    });

    it('keeps refreshing after a failed request', async () => {
        let calls = 0;
        const refresh = new ClaudeContextRefresh(() => {
            calls += 1;
            return Promise.reject(new Error('timeout'));
        });
        refresh.request();
        await vi.waitFor(() => expect(calls).toBe(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        refresh.request();
        await vi.waitFor(() => expect(calls).toBe(2));
    });
});

describe('refreshClaudeContextDetails', () => {
    it('replaces the pre-compaction token total with the authoritative context answer', async () => {
        let snapshot: AgentChatSnapshot = {
            ...emptyAgentChatSnapshot('example'),
            usage: { totalTokens: 243_000, contextWindow: 1_000_000 },
        };
        const host = {
            read: () => snapshot,
            apply: (operations: AgentChatPatchOperation[]) => {
                for (const operation of operations)
                    snapshot = applyAgentChatOperation(snapshot, operation);
            },
        };
        await refreshClaudeContextDetails(
            {
                getContextUsage: vi.fn().mockResolvedValue({
                    totalTokens: 12_000,
                    rawMaxTokens: 280_000,
                    categories: [],
                }),
            },
            host,
            () => false,
        );
        expect(snapshot.usage?.totalTokens).toBe(12_000);
    });

    it('does not overwrite a newer usage sample even when its token count is unchanged', async () => {
        const original = {
            ...emptyAgentChatSnapshot('example'),
            usage: { totalTokens: 243_000, contextWindow: 1_000_000, lastResponseAt: 1 },
        };
        let snapshot = original;
        const apply = vi.fn();
        await refreshClaudeContextDetails(
            {
                getContextUsage: vi.fn().mockImplementation(() => {
                    snapshot = { ...original, usage: { ...original.usage, lastResponseAt: 2 } };
                    return Promise.resolve({ totalTokens: 12_000, categories: [] });
                }),
            },
            { read: () => snapshot, apply },
            () => false,
        );
        expect(apply).not.toHaveBeenCalled();
    });
});

describe('Claude compaction context boundary', () => {
    it('clears the old pressure and cache immediately and rejects an in-flight pre-compaction answer', async () => {
        let snapshot: AgentChatSnapshot = {
            ...emptyAgentChatSnapshot('example'),
            usage: {
                totalTokens: 243_000,
                contextWindow: 1_000_000,
                lastResponseAt: 1,
                cacheTtlMinutes: 5,
            },
        };
        const host = {
            read: () => snapshot,
            apply: (operations: AgentChatPatchOperation[]) => {
                for (const operation of operations)
                    snapshot = applyAgentChatOperation(snapshot, operation);
            },
        };
        const old = Promise.withResolvers<unknown>();
        const fresh = Promise.withResolvers<unknown>();
        const getContextUsage = vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockReturnValueOnce(fresh.promise);
        const tracker = new ClaudeContextTracker(() => ({
            query: { getContextUsage },
            host,
            isEnded: () => false,
        }));
        tracker.request();
        await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(1));
        tracker.resetAfterCompaction();
        expect(snapshot.usage).toBeUndefined();
        old.resolve({ totalTokens: 243_000, categories: [] });
        await vi.waitFor(() => expect(getContextUsage).toHaveBeenCalledTimes(2));
        expect(snapshot.usage).toBeUndefined();
        fresh.resolve({ totalTokens: 12_000, rawMaxTokens: 280_000, categories: [] });
        await vi.waitFor(() => expect(snapshot.usage?.totalTokens).toBe(12_000));
        expect(snapshot.usage).toMatchObject({ contextWindow: 1_000_000 });
        expect(snapshot.usage?.lastResponseAt).toBeUndefined();
        expect(snapshot.usage?.cacheTtlMinutes).toBeUndefined();
    });
});
