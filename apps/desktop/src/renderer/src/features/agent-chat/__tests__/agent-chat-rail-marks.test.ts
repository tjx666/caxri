import { describe, expect, it } from 'vitest';

import {
    agentChatActiveRailIndex,
    agentChatRailMarks,
    agentChatRailPreview,
} from '../agent-chat-rail-marks';

describe('agentChatRailMarks', () => {
    it('marks each top-level user message in order', () => {
        expect(
            agentChatRailMarks([
                { kind: 'item', item: { id: 'u1', type: 'userMessage', text: 'first\n  line' } },
                {
                    kind: 'item',
                    item: { id: 'r1', type: 'agentMessage', text: 'ok', streaming: false },
                },
                { kind: 'work', id: 'work:x', items: [] },
                {
                    kind: 'item',
                    item: { id: 'u2', type: 'userMessage', text: '', images: [{}, {}] },
                },
            ]),
        ).toEqual([
            { id: 'u1', preview: 'first line' },
            { id: 'u2', preview: '2 images' },
        ]);
    });

    it('cuts a long message to fit the preview', () => {
        const preview = agentChatRailPreview('a'.repeat(500), 0);
        expect(preview).toHaveLength(120);
        expect(preview.endsWith('…')).toBe(true);
    });
});

describe('agentChatActiveRailIndex', () => {
    it('is the last message above the reading line, or the last one at the end', () => {
        const tops = [0, 400, 900];
        expect(agentChatActiveRailIndex(tops, 450, false)).toBe(1);
        expect(agentChatActiveRailIndex([100, 400], 50, false)).toBe(-1);
        expect(agentChatActiveRailIndex(tops, 450, true)).toBe(2);
    });
});
