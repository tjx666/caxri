import { describe, expect, it } from 'vitest';

import {
    agentChatActiveRailIndex,
    agentChatRailActiveTick,
    agentChatRailFocusStep,
    agentChatRailMarks,
    agentChatRailPreview,
    agentChatRailSampleIndices,
    agentChatRailTickCapacity,
    isAgentChatMessageRailShown,
    MAX_AGENT_CHAT_RAIL_MARKS,
    sampleAgentChatRailMarks,
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

describe('isAgentChatMessageRailShown', () => {
    it('shows the rail from the second message, when there is somewhere to jump', () => {
        expect(isAgentChatMessageRailShown([])).toBe(false);
        expect(isAgentChatMessageRailShown([{ id: 'a', preview: 'one' }])).toBe(false);
        expect(
            isAgentChatMessageRailShown([
                { id: 'a', preview: 'one' },
                { id: 'b', preview: 'two' },
            ]),
        ).toBe(true);
    });
});

describe('sampleAgentChatRailMarks', () => {
    const marks = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ id: `u${index}`, preview: `${index}` }));

    it('keeps every mark of a conversation the rail can space apart', () => {
        const all = marks(MAX_AGENT_CHAT_RAIL_MARKS);
        expect(sampleAgentChatRailMarks(all)).toBe(all);
    });

    it('spreads a long conversation over the rail from its first message to its last', () => {
        const sampled = sampleAgentChatRailMarks(marks(4000));
        expect(sampled).toHaveLength(MAX_AGENT_CHAT_RAIL_MARKS);
        expect(sampled[0].id).toBe('u0');
        expect(sampled.at(-1)?.id).toBe('u3999');
        expect(new Set(sampled.map((mark) => mark.id)).size).toBe(MAX_AGENT_CHAT_RAIL_MARKS);
    });
});

describe('agentChatRailTickCapacity', () => {
    it('fits ticks of at least 6px and never fewer than two', () => {
        expect(agentChatRailTickCapacity(600)).toBe(100);
        expect(agentChatRailTickCapacity(65)).toBe(10);
        expect(agentChatRailTickCapacity(0)).toBe(2);
    });
});

describe('agentChatRailSampleIndices', () => {
    it('keeps every index that fits and spreads the rest from first to last', () => {
        expect(agentChatRailSampleIndices(3, 5)).toEqual([0, 1, 2]);
        expect(agentChatRailSampleIndices(10, 4)).toEqual([0, 3, 6, 9]);
    });
});

describe('agentChatRailActiveTick', () => {
    it('lights the last tick at or before the active mark', () => {
        expect(agentChatRailActiveTick([0, 3, 6, 9], 5)).toBe(1);
        expect(agentChatRailActiveTick([0, 3, 6, 9], 9)).toBe(3);
        expect(agentChatRailActiveTick([0, 3, 6, 9], -1)).toBe(-1);
    });
});

describe('agentChatRailFocusStep', () => {
    it('steps with the arrows, stops at the ends, and jumps with Home and End', () => {
        expect(agentChatRailFocusStep(2, 5, 'ArrowUp')).toBe(1);
        expect(agentChatRailFocusStep(0, 5, 'ArrowUp')).toBe(0);
        expect(agentChatRailFocusStep(4, 5, 'ArrowDown')).toBe(4);
        expect(agentChatRailFocusStep(2, 5, 'Home')).toBe(0);
        expect(agentChatRailFocusStep(2, 5, 'End')).toBe(4);
        expect(agentChatRailFocusStep(2, 5, 'Enter')).toBeUndefined();
    });
});
