import {
    agentContextTabPath,
    agentSideChatTabPath,
    agentTaskTabPath,
    agentTranscriptTabPath,
    agentTurnReviewTabPath,
    MAX_SPLIT_RATIO,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { besideChatSplitRatio, besideChatTabTerminalId } from '../beside-chat-layout';

describe('besideChatTabTerminalId', () => {
    it('names the owning Chat of every tab that opens beside it', () => {
        expect(besideChatTabTerminalId(agentTaskTabPath('chat', 'task'))).toBe('chat');
        expect(besideChatTabTerminalId(agentTurnReviewTabPath('chat', 'turn'))).toBe('chat');
        expect(besideChatTabTerminalId(agentSideChatTabPath('chat'))).toBe('chat');
        expect(besideChatTabTerminalId(agentContextTabPath('chat'))).toBe('chat');
    });

    it('ignores files and other virtual tabs', () => {
        expect(besideChatTabTerminalId('/project/a.ts')).toBeUndefined();
        expect(besideChatTabTerminalId(agentTranscriptTabPath('chat'))).toBeUndefined();
    });
});

describe('besideChatSplitRatio', () => {
    it('caps the Chat at its readable width on a wide host', () => {
        expect(besideChatSplitRatio(1604)).toBeCloseTo(800 / 1600);
        expect(besideChatSplitRatio(2404)).toBeCloseTo(800 / 2400);
    });

    it('keeps the side pane at its minimum and gives the Chat the rest on a medium host', () => {
        // 1024px window less a 230px Primary Sidebar and its divider: the old fixed half left the Chat ~390px.
        const host = 1024 - 230 - 6;
        const ratio = besideChatSplitRatio(host);
        expect(ratio).toBeDefined();
        expect((host - 4) * (1 - (ratio ?? 0))).toBeCloseTo(360);
    });

    it('refuses to split when both minimums cannot fit', () => {
        expect(besideChatSplitRatio(420 + 360 + 4)).toBeDefined();
        expect(besideChatSplitRatio(420 + 360 + 3)).toBeUndefined();
        expect(besideChatSplitRatio(NaN)).toBeUndefined();
    });

    it('never exceeds the reducer bounds', () => {
        expect(besideChatSplitRatio(800 + 360 + 4)).toBeLessThanOrEqual(MAX_SPLIT_RATIO);
    });
});
