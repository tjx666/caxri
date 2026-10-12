import { describe, expect, it } from 'vitest';

import {
    agentChatFindCountLabel,
    agentChatFindOccurrences,
    isAgentChatTurnFoldMatch,
    locateAgentChatFindMatch,
    stepAgentChatFindIndex,
} from '../agent-chat-find';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';

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

describe('agentChatFindCountLabel', () => {
    it('counts from one, shows No results without matches, and nothing before a query', () => {
        expect(agentChatFindCountLabel('a', 12, 2)).toBe('3/12');
        expect(agentChatFindCountLabel('a', 0, 0)).toBe('No results');
        expect(agentChatFindCountLabel('', 0, 0)).toBe('');
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
        label: 'Worked for 2s',
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
