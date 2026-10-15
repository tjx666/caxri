import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../agent-chat-contract.js';
import {
    agentChatHistoryCursor,
    emptyAgentChatOlderHistory,
    hasOlderAgentChatHistory,
    MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS,
    prependAgentChatHistoryPage,
    retainEvictedAgentChatItems,
    splitAgentChatHistory,
} from '../agent-chat-history.js';

const item = (id: string, turnId?: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text: id,
    ...(turnId && { turnId }),
});

const page = (
    ids: string[],
    options: { hasMore?: boolean; truncated?: boolean; historyId?: string } = {},
) => ({
    historyId: options.historyId ?? 'h1',
    items: ids.map((id) => item(id, `t-${id}`)),
    turns: ids.map((id) => ({ id: `t-${id}`, status: 'completed' as const })),
    hasMore: options.hasMore ?? false,
    truncated: options.truncated ?? false,
});

describe('Agent Chat older history', () => {
    it('loads before the projection until a page says there is no more', () => {
        const live = { truncated: true, items: [item('m3')] };
        let history = emptyAgentChatOlderHistory('h1');
        expect(hasOlderAgentChatHistory(history, live)).toBe(true);
        expect(agentChatHistoryCursor(history, live)).toBe('m3');
        history = prependAgentChatHistoryPage(history, page(['m1', 'm2'], { hasMore: true }), []);
        expect(history.items.map((entry) => entry.id)).toEqual(['m1', 'm2']);
        expect(agentChatHistoryCursor(history, live)).toBe('m1');
        history = prependAgentChatHistoryPage(history, page(['m0']), []);
        expect(history.items.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2']);
        expect(history.turns.map((turn) => turn.id)).toEqual(['t-m0', 't-m1', 't-m2']);
        expect(hasOlderAgentChatHistory(history, live)).toBe(false);
        expect(history.truncated).toBe(false);
    });

    it('drops a page read for a replaced history and never shows an item twice', () => {
        const history = emptyAgentChatOlderHistory('h2');
        expect(prependAgentChatHistoryPage(history, page(['m1']), [])).toBe(history);
        const next = prependAgentChatHistoryPage(
            { ...history, historyId: 'h1' },
            page(['m1', 'm2']),
            [item('m2')],
        );
        expect(next.items.map((entry) => entry.id)).toEqual(['m1']);
    });

    it('keeps what the projection evicts once history was read, so no gap opens', () => {
        const read = prependAgentChatHistoryPage(
            emptyAgentChatOlderHistory('h1'),
            page(['m0'], { hasMore: true }),
            [],
        );
        const previous = {
            items: [item('m1', 't1'), item('m2', 't2')],
            turns: [{ id: 't1', status: 'completed' as const }],
        };
        const next = { items: [item('m2', 't2'), item('m3', 't3')] };
        const retained = retainEvictedAgentChatItems(read, previous, next);
        expect(retained.items.map((entry) => entry.id)).toEqual(['m0', 'm1']);
        expect(retained.turns.map((turn) => turn.id)).toContain('t1');
        // Before any page is read, the first page starts right before the projection instead.
        const unread = emptyAgentChatOlderHistory('h1');
        expect(retainEvictedAgentChatItems(unread, previous, next)).toBe(unread);
    });

    it('keeps what the projection evicts while the first page is on its way', () => {
        const loading = { ...emptyAgentChatOlderHistory('h1'), status: 'loading' as const };
        const previous = { items: [item('m1', 't1'), item('m2', 't2')], turns: [] };
        const next = { items: [item('m2', 't2'), item('m3', 't3')] };
        const retained = retainEvictedAgentChatItems(loading, previous, next);
        expect(retained.items.map((entry) => entry.id)).toEqual(['m1']);
        // The page read before the old first item lands in front of what was kept meanwhile.
        const read = prependAgentChatHistoryPage(retained, page(['m0']), next.items);
        expect(read.items.map((entry) => entry.id)).toEqual(['m0', 'm1']);
    });

    it('lets the oldest kept items go past the bound and reads them again on scroll-back', () => {
        const kept = Array.from({ length: MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS }, (_, index) =>
            item(`k${index}`, `t-k${index}`),
        );
        const full = {
            ...emptyAgentChatOlderHistory('h1'),
            isLoaded: true,
            hasMore: false,
            items: kept,
            turns: kept.map((entry) => ({ id: entry.turnId!, status: 'completed' as const })),
        };
        const previous = { items: [item('m1', 't1'), item('m2', 't2')], turns: [] };
        const next = { items: [item('m2', 't2'), item('m3', 't3')] };
        const retained = retainEvictedAgentChatItems(full, previous, next);
        expect(retained.items).toHaveLength(MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS);
        expect(retained.items.at(-1)?.id).toBe('m1');
        expect(retained.items[0]?.id).toBe('k1');
        expect(retained.turns.some((turn) => turn.id === 't-k0')).toBe(false);
        expect(hasOlderAgentChatHistory(retained, undefined)).toBe(true);
        expect(agentChatHistoryCursor(retained, undefined)).toBe('k1');
        // A page already on its way reads before `k0`, so nothing is dropped until it lands.
        const loading = retainEvictedAgentChatItems({ ...full, status: 'loading' }, previous, next);
        expect(loading.items).toHaveLength(MAX_AGENT_CHAT_RETAINED_HISTORY_ITEMS + 1);
    });

    it('renders the start of the turn the projection begins inside with the live part', () => {
        const older = [item('a', 't1'), item('b', 't2'), item('c', 't2')];
        expect(splitAgentChatHistory(older, 't2')).toEqual({
            settled: [older[0]],
            carried: [older[1], older[2]],
        });
        expect(splitAgentChatHistory(older, 't3')).toEqual({ settled: older, carried: [] });
    });
});
