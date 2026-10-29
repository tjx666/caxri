import { afterEach, describe, expect, it } from 'vitest';

import { translate, useLocaleStore, withLocale } from '../../../../i18n';
import {
    agentChatDayBreaks,
    agentChatDayLabel,
    agentChatLastDay,
    agentChatMessageFullTime,
    agentChatMessageTime,
} from '../agent-chat-time';
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
        const time = agentChatMessageTime(at(10, 11, 17, 59), 'en');
        expect(agentChatDayLabel(at(10, 11, 17, 59), now, translate)).toBe(`Today ${time}`);
        expect(agentChatDayLabel(at(10, 10, 17, 59), now, translate)).toBe(`Yesterday ${time}`);
        expect(agentChatDayLabel(at(10, 3, 17, 59), now, translate)).not.toMatch(
            /2026|Today|Yesterday/u,
        );
        expect(agentChatDayLabel(at(12, 30, 17, 59, 2025), now, translate)).toMatch(/2025/u);
    });
});

describe('agent chat time locale', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('formats dates in the interface language rather than the system one', () => {
        const now = at(10, 11, 18);
        useLocaleStore.setState({ locale: 'en' });
        expect(agentChatDayLabel(at(10, 3, 17, 59), now, translate)).toMatch(/^Oct 3 /u);
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(agentChatDayLabel(at(10, 3, 17, 59), now, translate)).toMatch(/^10月3日 /u);
    });

    /**
     * React Compiler memoizes a component by its inputs, so a formatter that read the global locale would keep the old
     * language after a runtime switch. The locale has to arrive as an argument.
     */
    it('takes the locale from its argument instead of the global store', () => {
        useLocaleStore.setState({ locale: 'en' });
        expect(agentChatMessageFullTime(at(10, 3, 17, 59), 'zh-CN')).toMatch(/2026年10月3日/u);
        expect(agentChatMessageFullTime(at(10, 3, 17, 59), 'en')).toMatch(/October 3, 2026/u);
        expect(
            agentChatDayLabel(at(10, 3, 17, 59), at(10, 11, 18), withLocale(translate, 'zh-CN')),
        ).toMatch(/^10月3日 /u);
    });
});

describe('agentChatDayBreaks', () => {
    it('continues the day of the history rendered above it', () => {
        const earlier = [userEntry('a', at(10, 10, 9))];
        const timeline = [userEntry('b', at(10, 10, 20)), userEntry('c', at(10, 11, 8))];
        const breaks = agentChatDayBreaks(timeline, agentChatLastDay(earlier));
        expect(breaks.keys().toArray()).toEqual(['c']);
    });

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
