import { describe, expect, it } from 'vitest';

import {
    AGENT_CHAT_BACKFILL_ENTRIES,
    AGENT_CHAT_TAIL_ENTRIES,
    agentChatBackfillStart,
    agentChatTailStart,
} from '../use-agent-chat-tail-first-mount';

describe('agentChatTailStart', () => {
    it('mounts only the last entries of a long timeline', () => {
        expect(agentChatTailStart(100)).toBe(100 - AGENT_CHAT_TAIL_ENTRIES);
    });

    it('mounts a short timeline whole', () => {
        expect(agentChatTailStart(AGENT_CHAT_TAIL_ENTRIES)).toBe(0);
        expect(agentChatTailStart(2)).toBe(0);
        expect(agentChatTailStart(0)).toBe(0);
    });
});

describe('agentChatBackfillStart', () => {
    it('adds older entries above the mounted ones, newest first, until the first entry', () => {
        let start = agentChatTailStart(30);
        const starts = [start];
        while (start > 0) {
            const next = agentChatBackfillStart(start);
            expect(next).toBeLessThan(start);
            expect(start - next).toBeLessThanOrEqual(AGENT_CHAT_BACKFILL_ENTRIES);
            start = next;
            starts.push(start);
        }
        expect(starts.at(-1)).toBe(0);
        expect(starts[0]).toBe(30 - AGENT_CHAT_TAIL_ENTRIES);
    });

    it('never goes below the first entry', () => {
        expect(agentChatBackfillStart(3)).toBe(0);
        expect(agentChatBackfillStart(0)).toBe(0);
    });
});
