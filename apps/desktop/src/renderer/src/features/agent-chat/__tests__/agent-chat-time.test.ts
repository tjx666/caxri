import { describe, expect, it } from 'vitest';

import { agentChatDayBreaks, agentChatDayLabel, agentChatMessageTime } from '../agent-chat-time';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';

const at = (month: number, day: number, hour: number, minute = 0, year = 2026): number =>
    new Date(year, month - 1, day, hour, minute).getTime();

const userEntry = (id: string, createdAt?: number): AgentChatTimelineEntry => ({
    kind: 'item',
    item: { id, type: 'userMessage', text: id, ...(createdAt !== undefined && { createdAt }) },
});

describe('agentChatDayLabel', () => {
    const now = at(10, 11, 18);
    it('names today and yesterday by word and older days by date', () => {
        const time = agentChatMessageTime(at(10, 11, 17, 59));
        expect(agentChatDayLabel(at(10, 11, 17, 59), now)).toBe(`Today ${time}`);
        expect(agentChatDayLabel(at(10, 10, 17, 59), now)).toBe(`Yesterday ${time}`);
        expect(agentChatDayLabel(at(10, 3, 17, 59), now)).not.toMatch(/2026|Today|Yesterday/u);
        expect(agentChatDayLabel(at(12, 30, 17, 59, 2025), now)).toMatch(/2025/u);
    });
});

describe('agentChatDayBreaks', () => {
    it('breaks before the first dated message and each one that starts a new day', () => {
        const breaks = agentChatDayBreaks([
            userEntry('undated'),
            userEntry('a', at(10, 10, 9)),
            {
                kind: 'item',
                item: {
                    id: 'r',
                    type: 'agentMessage',
                    text: 'ok',
                    streaming: false,
                    createdAt: at(10, 11, 1),
                },
            },
            userEntry('b', at(10, 10, 23)),
            userEntry('c', at(10, 11, 8)),
            userEntry('d', at(10, 11, 9)),
        ]);
        expect(breaks.keys().toArray()).toEqual(['a', 'c']);
        expect(breaks.get('c')).toBe(at(10, 11, 8));
    });
});
