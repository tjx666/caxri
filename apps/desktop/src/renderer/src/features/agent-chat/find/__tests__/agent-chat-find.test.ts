import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '../../../../i18n';
import type { AgentChatTimelineEntry } from '../../transcript/agent-chat-timeline';
import {
    AGENT_CHAT_FIND_REPAINT_INTERVAL_MS,
    agentChatFindCountLabel,
    agentChatFindOccurrences,
    agentChatFindVisibleWindow,
    canAgentChatFindSearchEarlier,
    createAgentChatFindRepaintScheduler,
    hasAgentChatFindEarlierLoadSettled,
    isAgentChatTurnFoldMatch,
    locateAgentChatFindMatch,
    nextAgentChatFindAutoLoad,
    stepAgentChatFindIndex,
} from '../agent-chat-find';

describe('agentChatFindOccurrences', () => {
    it('finds every occurrence ignoring case, without overlaps', () => {
        expect(agentChatFindOccurrences('Alpha alpha ALPHA', 'alpha')).toEqual([0, 6, 12]);
        expect(agentChatFindOccurrences('aaaa', 'aa')).toEqual([0, 2]);
    });

    it('treats the query as text, not a pattern', () => {
        expect(agentChatFindOccurrences('a.b axb (c)', 'a.b')).toEqual([0]);
        expect(agentChatFindOccurrences('call (c)', '(c)')).toEqual([5]);
    });

    it('keeps offsets aligned for characters whose case forms differ in length', () => {
        expect(agentChatFindOccurrences('İstanbul and istanbul', 'istanbul')).toEqual([13]);
    });

    it('matches a typed space against the no-break spaces a colorized code block renders', () => {
        expect(
            agentChatFindOccurrences('add "Call\u{A0}Alice at\u{A0}3pm"', 'call alice at 3pm'),
        ).toEqual([5]);
    });

    it('finds nothing for an empty query', () => {
        expect(agentChatFindOccurrences('anything', '')).toEqual([]);
    });
});

describe('locateAgentChatFindMatch', () => {
    // `Run **the** tests` renders as three text nodes: `Run `, `the`, ` tests`.
    const spans = [
        { start: 0, end: 4 },
        { start: 4, end: 7 },
        { start: 7, end: 13 },
    ];

    it('places a match inside one text node', () => {
        expect(locateAgentChatFindMatch(spans, 8, 5)).toEqual({ start: [2, 1], end: [2, 6] });
    });

    it('places a match that crosses inline elements', () => {
        expect(locateAgentChatFindMatch(spans, 2, 6)).toEqual({ start: [0, 2], end: [2, 1] });
    });

    it('ends a match at the end of a node rather than the start of the next', () => {
        expect(locateAgentChatFindMatch(spans, 4, 3)).toEqual({ start: [1, 0], end: [1, 3] });
    });

    it('refuses a match that runs off the end', () => {
        expect(locateAgentChatFindMatch(spans, 10, 5)).toBeUndefined();
    });
});

describe('canAgentChatFindSearchEarlier', () => {
    it('offers earlier history only for a query that found nothing while more can load', () => {
        expect(canAgentChatFindSearchEarlier('bug', 0, true)).toBe(true);
        expect(canAgentChatFindSearchEarlier('bug', 2, true)).toBe(false);
        expect(canAgentChatFindSearchEarlier('bug', 0, false)).toBe(false);
        expect(canAgentChatFindSearchEarlier('', 0, true)).toBe(false);
    });
});

describe('agentChatFindCountLabel', () => {
    it('counts from one, shows No results without matches, and nothing before a query', () => {
        expect(agentChatFindCountLabel('a', 12, 2, translate)).toBe('3/12');
        expect(agentChatFindCountLabel('a', 0, 0, translate)).toBe('No results');
        expect(agentChatFindCountLabel('', 0, 0, translate)).toBe('');
    });

    it('limits an empty result to the loaded messages while older history is not searched', () => {
        expect(agentChatFindCountLabel('a', 0, 0, translate, { isPartial: true })).toBe(
            'No results in loaded messages',
        );
        expect(agentChatFindCountLabel('a', 2, 0, translate, { isPartial: true })).toBe('1/2');
    });
});

describe('stepAgentChatFindIndex', () => {
    it('wraps around at either end', () => {
        expect(stepAgentChatFindIndex(2, 3, 1)).toBe(0);
        expect(stepAgentChatFindIndex(0, 3, -1)).toBe(2);
        expect(stepAgentChatFindIndex(1, 3, 1)).toBe(2);
        expect(stepAgentChatFindIndex(0, 0, 1)).toBe(0);
    });
});

describe('isAgentChatTurnFoldMatch', () => {
    const fold: Extract<AgentChatTimelineEntry, { kind: 'turn' }> = {
        kind: 'turn',
        id: 'turn:1',
        durationMs: 2000,
        status: 'completed',
        entries: [
            {
                kind: 'item',
                item: {
                    id: 'm-1',
                    turnId: 'turn-1',
                    type: 'agentMessage',
                    text: 'Looking around the project.',
                    streaming: false,
                },
            },
            { kind: 'work', id: 'work:c-1', items: [] },
        ],
    };

    it('opens for a query a folded message mentions', () => {
        expect(isAgentChatTurnFoldMatch(fold, 'LOOKING around')).toBe(true);
    });

    it('stays shut for another query or none', () => {
        expect(isAgentChatTurnFoldMatch(fold, 'tests')).toBe(false);
        expect(isAgentChatTurnFoldMatch(fold, '')).toBe(false);
    });

    it('waits for a query long enough not to match nearly every message', () => {
        expect(isAgentChatTurnFoldMatch(fold, 'lo')).toBe(false);
        expect(isAgentChatTurnFoldMatch(fold, 'loo')).toBe(true);
    });
});

describe('createAgentChatFindRepaintScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('repaints the first change after a quiet spell at once', () => {
        const repaint = vi.fn();
        const repaints = createAgentChatFindRepaintScheduler(repaint);
        repaints.schedule();
        expect(repaint).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(AGENT_CHAT_FIND_REPAINT_INTERVAL_MS * 4);
        expect(repaint).toHaveBeenCalledTimes(1);
        repaints.schedule();
        expect(repaint).toHaveBeenCalledTimes(2);
    });

    it('bounds repaints while a reply streams and repaints once after its last change', () => {
        const repaint = vi.fn();
        const repaints = createAgentChatFindRepaintScheduler(repaint);
        const streamMs = 2000;
        const chunkMs = 16;
        for (let elapsed = 0; elapsed < streamMs; elapsed += chunkMs) {
            repaints.schedule();
            vi.advanceTimersByTime(chunkMs);
        }
        const whileStreaming = repaint.mock.calls.length;
        expect(whileStreaming).toBeGreaterThan(1);
        expect(whileStreaming).toBeLessThanOrEqual(
            Math.ceil(streamMs / AGENT_CHAT_FIND_REPAINT_INTERVAL_MS) + 1,
        );
        vi.advanceTimersByTime(AGENT_CHAT_FIND_REPAINT_INTERVAL_MS);
        expect(repaint).toHaveBeenCalledTimes(whileStreaming + 1);
        vi.advanceTimersByTime(AGENT_CHAT_FIND_REPAINT_INTERVAL_MS * 4);
        expect(repaint).toHaveBeenCalledTimes(whileStreaming + 1);
    });

    it('drops a pending repaint once cancelled', () => {
        const repaint = vi.fn();
        const repaints = createAgentChatFindRepaintScheduler(repaint);
        repaints.schedule();
        repaints.schedule();
        repaints.cancel();
        vi.advanceTimersByTime(AGENT_CHAT_FIND_REPAINT_INTERVAL_MS * 4);
        expect(repaint).toHaveBeenCalledTimes(1);
    });
});

describe('hasAgentChatFindEarlierLoadSettled', () => {
    it('settles a waiting request once the earlier page stops loading', () => {
        expect(hasAgentChatFindEarlierLoadSettled(true, false, true)).toBe(true);
        expect(hasAgentChatFindEarlierLoadSettled(true, true, true)).toBe(false);
        expect(hasAgentChatFindEarlierLoadSettled(false, false, true)).toBe(false);
        expect(hasAgentChatFindEarlierLoadSettled(true, false, false)).toBe(false);
    });
});

describe('nextAgentChatFindAutoLoad', () => {
    const ready = {
        isActive: true,
        hasQuery: true,
        hasContent: true,
        matchCount: 0,
        hasFailed: false,
        isLoading: false,
        canLoadEarlier: true,
    };

    it('loads the next older page while no loaded message matches', () => {
        expect(nextAgentChatFindAutoLoad(ready)).toBe('load');
    });

    it('waits for the conversation, a page in flight, or the snapshot that reports older history', () => {
        expect(nextAgentChatFindAutoLoad({ ...ready, hasContent: false })).toBe('wait');
        expect(nextAgentChatFindAutoLoad({ ...ready, isLoading: true })).toBe('wait');
        expect(nextAgentChatFindAutoLoad({ ...ready, canLoadEarlier: false })).toBe('wait');
    });

    it('stops once a match is found, a page failed, or the handoff is no longer active', () => {
        expect(nextAgentChatFindAutoLoad({ ...ready, matchCount: 1 })).toBe('stop');
        expect(nextAgentChatFindAutoLoad({ ...ready, hasFailed: true })).toBe('stop');
        expect(nextAgentChatFindAutoLoad({ ...ready, isActive: false })).toBe('stop');
    });
});

describe('agentChatFindVisibleWindow', () => {
    /**
     * One match per 20px row, row `index` spanning `[index * 20, index * 20 + 20]`.
     */
    const rows = (index: number) => ({ top: index * 20, bottom: index * 20 + 20 });

    it('returns only the matches whose rows touch the band', () => {
        // Rows 5 to 9 touch [100, 200]: row 4 ends at 100, which still touches, and row 10 starts at 200.
        expect(agentChatFindVisibleWindow(1000, rows, 110, 190)).toEqual([5, 10]);
        expect(agentChatFindVisibleWindow(1000, rows, 100, 200)).toEqual([4, 11]);
    });

    it('covers every match when the band spans them all and none when it misses them', () => {
        expect(agentChatFindVisibleWindow(10, rows, -1000, 1000)).toEqual([0, 10]);
        expect(agentChatFindVisibleWindow(10, rows, 5000, 6000)).toEqual([10, 10]);
        expect(agentChatFindVisibleWindow(10, rows, -500, -100)).toEqual([0, 0]);
        expect(agentChatFindVisibleWindow(0, rows, 0, 100)).toEqual([0, 0]);
    });

    it('measures only a logarithmic number of matches', () => {
        const measure = vi.fn(rows);
        agentChatFindVisibleWindow(10_000, measure, 100_000, 100_400);
        expect(measure.mock.calls.length).toBeLessThan(40);
    });

    it('treats a match that cannot be measured as above the band', () => {
        const measure = (index: number) => (index < 3 ? undefined : rows(index));
        expect(agentChatFindVisibleWindow(10, measure, 0, 100)[0]).toBe(3);
    });
});
