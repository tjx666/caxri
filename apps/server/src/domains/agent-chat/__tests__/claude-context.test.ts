import { describe, expect, it, vi } from 'vitest';

import {
    claudeCacheTtlMinutes,
    claudeContextDetails,
    ClaudeContextRefresh,
} from '../claude-context';

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
