import type { AgentChatLabelTranslate } from '@caxri/protocol';
import { interpolate, translateAgentChatLabel } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { elapsedTimeFigures, elapsedTimeText, goalTimeFigures } from '../agent-chat-elapsed-time';

const CHINESE_TEMPLATES: Record<string, string> = {
    'agentChat.fold.durationSeconds': '{{seconds}}秒',
    'agentChat.fold.durationMinutesSeconds': '{{minutes}}分 {{seconds}}秒',
    'agentChat.fold.durationHoursMinutesSeconds': '{{hours}}小时 {{minutes}}分 {{seconds}}秒',
};

const chinese: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(CHINESE_TEMPLATES[key] ?? key, parameters);

describe('elapsedTimeFigures', () => {
    it('shows nothing until the time is noticeable', () => {
        expect(elapsedTimeFigures(999, translateAgentChatLabel)).toBeNull();
    });

    it('shows seconds alone under a minute', () => {
        expect(elapsedTimeFigures(45_000, translateAgentChatLabel)).toEqual([
            { unit: 'seconds', value: 45, separator: '', prefix: '', suffix: 's' },
        ]);
    });

    it('splits minutes and seconds with the units and space of the label', () => {
        expect(elapsedTimeFigures(534_000, translateAgentChatLabel)).toEqual([
            { unit: 'minutes', value: 8, separator: '', prefix: '', suffix: 'm' },
            { unit: 'seconds', value: 54, separator: ' ', prefix: '', suffix: 's' },
        ]);
        expect(elapsedTimeText(elapsedTimeFigures(534_000, chinese) ?? [])).toBe('8分 54秒');
    });

    it('keeps zero seconds on a whole minute so the live time never drops them', () => {
        expect(elapsedTimeFigures(120_000, translateAgentChatLabel)).toMatchObject([
            { unit: 'minutes', value: 2 },
            { unit: 'seconds', value: 0, suffix: 's' },
        ]);
    });
});

describe('goalTimeFigures', () => {
    it('shows a goal from zero seconds', () => {
        expect(elapsedTimeText(goalTimeFigures(0, translateAgentChatLabel))).toBe('0s');
    });

    it('spells out hours, as the settled goal time does', () => {
        const figures = goalTimeFigures(5849, chinese);
        expect(figures.map(({ unit, value }) => [unit, value])).toEqual([
            ['hours', 1],
            ['minutes', 37],
            ['seconds', 29],
        ]);
        expect(elapsedTimeText(figures)).toBe('1小时 37分 29秒');
        expect(elapsedTimeText(goalTimeFigures(725, translateAgentChatLabel))).toBe('12m 5s');
    });
});
