import type { AgentChatLabelTranslate } from '@caxri/protocol';
import { interpolate, translateAgentChatLabel } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { elapsedTimeFigures } from '../agent-chat-elapsed-time';

const CHINESE_TEMPLATES: Record<string, string> = {
    'agentChat.fold.durationSeconds': '{{seconds}}秒',
    'agentChat.fold.durationMinutesSeconds': '{{minutes}}分 {{seconds}}秒',
};

const chinese: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(CHINESE_TEMPLATES[key] ?? key, parameters);

describe('elapsedTimeFigures', () => {
    it('shows nothing until the time is noticeable', () => {
        expect(elapsedTimeFigures(999, translateAgentChatLabel)).toBeNull();
    });

    it('shows seconds alone under a minute', () => {
        expect(elapsedTimeFigures(45_000, translateAgentChatLabel)).toEqual({
            separator: '',
            seconds: { value: 45, prefix: '', suffix: 's' },
        });
    });

    it('splits minutes and seconds with the units and space of the label', () => {
        expect(elapsedTimeFigures(534_000, translateAgentChatLabel)).toEqual({
            minutes: { value: 8, prefix: '', suffix: 'm' },
            separator: ' ',
            seconds: { value: 54, prefix: '', suffix: 's' },
        });
        expect(elapsedTimeFigures(534_000, chinese)).toEqual({
            minutes: { value: 8, prefix: '', suffix: '分' },
            separator: ' ',
            seconds: { value: 54, prefix: '', suffix: '秒' },
        });
    });

    it('keeps zero seconds on a whole minute so the live time never drops them', () => {
        expect(elapsedTimeFigures(120_000, translateAgentChatLabel)).toMatchObject({
            minutes: { value: 2 },
            seconds: { value: 0, suffix: 's' },
        });
    });
});
