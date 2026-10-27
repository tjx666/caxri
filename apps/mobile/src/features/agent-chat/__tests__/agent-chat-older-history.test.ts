import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatOlderHistory, prependAgentChatHistoryPage } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canLoadOlderAgentChatHistory,
    mergeAgentChatOlderHistory,
    shouldContinueAgentChatHistoryLoad,
    syncAgentChatOlderHistory,
} from '../agent-chat-older-history';
import { buildAgentChatTimeline } from '../agent-chat-timeline';

const item = (id: string, turnId = `turn-${id}`): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text: id,
    streaming: false,
    turnId,
});

const snapshot = (
    ids: string[],
    options: { truncated?: boolean; historyId?: string | null } = {},
): AgentChatSnapshot => ({
    terminalId: 'terminal-1',
    revision: 1,
    status: 'ready',
    ...(options.historyId !== null && { historyId: options.historyId ?? 'history-1' }),
    truncated: options.truncated ?? true,
    items: ids.map((id) => item(id)),
    turns: ids.map((id) => ({ id: `turn-${id}`, status: 'completed' as const })),
    requests: [],
});

const page = (
    ids: string[],
    options: { hasMore?: boolean; truncated?: boolean; historyId?: string } = {},
) => ({
    historyId: options.historyId ?? 'history-1',
    items: ids.map((id) => item(id)),
    turns: ids.map((id) => ({ id: `turn-${id}`, status: 'completed' as const })),
    hasMore: options.hasMore ?? false,
    truncated: options.truncated ?? false,
});

describe('phone Chat older history', () => {
    it('puts loaded pages in front of the window and keeps the window copy of a shared item', () => {
        const window = snapshot(['c', 'd']);
        const history = prependAgentChatHistoryPage(
            emptyAgentChatOlderHistory('history-1'),
            page(['a', 'b'], { hasMore: true }),
            window.items,
        );
        const merged = mergeAgentChatOlderHistory(window, {
            ...history,
            items: [...history.items, item('c')],
        });
        expect(merged.items.map((value) => value.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(merged.turns.map((turn) => turn.id)).toEqual([
            'turn-a',
            'turn-b',
            'turn-c',
            'turn-d',
        ]);
        // More can load, so the oldest turn may still be missing its start.
        expect(merged.truncated).toBe(true);
    });

    it('marks the list truncated only after the last page says the record is cut', () => {
        const window = snapshot(['c']);
        const done = prependAgentChatHistoryPage(
            emptyAgentChatOlderHistory('history-1'),
            page(['a', 'b']),
            window.items,
        );
        expect(canLoadOlderAgentChatHistory(done, window)).toBe(false);
        expect(mergeAgentChatOlderHistory(window, done).truncated).toBe(false);
        const cut = prependAgentChatHistoryPage(
            emptyAgentChatOlderHistory('history-1'),
            page(['a'], { truncated: true }),
            window.items,
        );
        expect(mergeAgentChatOlderHistory(window, cut).truncated).toBe(true);
    });

    it('returns the window itself when nothing older was read', () => {
        const window = snapshot(['a'], { truncated: false });
        expect(mergeAgentChatOlderHistory(window, emptyAgentChatOlderHistory('history-1'))).toBe(
            window,
        );
    });

    it('cannot page a Chat without a bound conversation', () => {
        const window = snapshot(['a'], { historyId: null });
        expect(canLoadOlderAgentChatHistory(emptyAgentChatOlderHistory(undefined), window)).toBe(
            false,
        );
    });

    it('keeps items a shrinking window evicted once reading started, and starts over for a new conversation', () => {
        const before = snapshot(['b', 'c']);
        const reading = prependAgentChatHistoryPage(
            emptyAgentChatOlderHistory('history-1'),
            page(['a'], { hasMore: true }),
            before.items,
        );
        const after = snapshot(['c', 'd']);
        const kept = syncAgentChatOlderHistory(reading, before, after);
        expect(kept.items.map((value) => value.id)).toEqual(['a', 'b']);
        expect(mergeAgentChatOlderHistory(after, kept).items.map((value) => value.id)).toEqual([
            'a',
            'b',
            'c',
            'd',
        ]);
        const replaced = syncAgentChatOlderHistory(
            kept,
            after,
            snapshot(['x'], { historyId: 'history-2' }),
        );
        expect(replaced).toEqual(emptyAgentChatOlderHistory('history-2'));
    });

    it('keeps rows a long turn slides out of the window before the reader ever scrolls back', () => {
        const before = snapshot(['a', 'b', 'c']);
        const after = snapshot(['c', 'd']);
        const kept = syncAgentChatOlderHistory(
            emptyAgentChatOlderHistory('history-1'),
            before,
            after,
        );
        expect(mergeAgentChatOlderHistory(after, kept).items.map((value) => value.id)).toEqual([
            'a',
            'b',
            'c',
            'd',
        ]);
        expect(canLoadOlderAgentChatHistory(kept, after)).toBe(true);
    });

    it('ignores a page for a replaced conversation', () => {
        const history = emptyAgentChatOlderHistory('history-2');
        expect(
            prependAgentChatHistoryPage(history, page(['a'], { historyId: 'history-1' }), []),
        ).toBe(history);
    });

    it('folds a turn that spans the page and the window as one turn', () => {
        const window: AgentChatSnapshot = {
            ...snapshot([]),
            items: [item('b', 'turn-1'), item('c', 'turn-1')],
            turns: [{ id: 'turn-1', status: 'completed' }],
        };
        const history = prependAgentChatHistoryPage(
            emptyAgentChatOlderHistory('history-1'),
            {
                historyId: 'history-1',
                items: [item('a', 'turn-1')],
                turns: [{ id: 'turn-1', status: 'completed' }],
                hasMore: false,
                truncated: false,
            },
            window.items,
        );
        const merged = mergeAgentChatOlderHistory(window, history);
        expect(merged.items.map((value) => value.id)).toEqual(['a', 'b', 'c']);
        expect(merged.turns).toEqual([{ id: 'turn-1', status: 'completed' }]);
        const timeline = buildAgentChatTimeline(merged);
        // One fold for the whole turn, then its final reply.
        expect(timeline.map((entry) => entry.kind)).toEqual(['turn', 'message']);
    });
});

describe('shouldContinueAgentChatHistoryLoad', () => {
    const previous = emptyAgentChatOlderHistory('history-1');
    const agentOnly = page(['b', 'c'], { hasMore: true });
    const next = prependAgentChatHistoryPage(previous, agentOnly, []);

    it('reads on through Agent output until the turn request', () => {
        expect(shouldContinueAgentChatHistoryLoad(false, agentOnly, previous, next, 1)).toBe(true);
    });

    it('stops a fill after one page, so pages never land in a row above a followed end', () => {
        expect(shouldContinueAgentChatHistoryLoad(true, agentOnly, previous, next, 1)).toBe(false);
    });
});
