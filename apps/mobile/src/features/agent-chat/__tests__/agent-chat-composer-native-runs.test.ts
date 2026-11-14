import { describe, expect, it } from 'vitest';

import { agentChatComposerNativeRuns } from '../agent-chat-composer-native-runs';
import type { AgentChatComposerSpan } from '../agent-chat-composer-spans';
import { agentChatComposerSpans } from '../agent-chat-composer-spans';

const COLORS: Record<string, number> = {
    '#00000001': 0x01_00_00_00,
    'muted': 1,
    'pill': 2,
    'primary': 3,
};
const color = (value: string) => COLORS[value];

const styleOf = (span: AgentChatComposerSpan) => ({
    ...(span.inline.includes('syntax') && { color: 'muted' }),
    ...(span.inline.includes('strong') && { fontWeight: '600' as const }),
    ...(span.isImage && { backgroundColor: 'pill', color: 'primary' }),
    ...(span.isHidden && { color: '#00000001', fontSize: 1 }),
});

describe('agentChatComposerNativeRuns', () => {
    it('sends only the runs that change the field look, in draft offsets', () => {
        const draft = '[Image #1] \n1. 第一项\n2';
        const spans = agentChatComposerSpans(
            draft,
            { end: draft.length, start: draft.length },
            new Set([1]),
        );
        const runs = agentChatComposerNativeRuns(spans, styleOf, color);
        expect(runs).toEqual([
            expect.objectContaining({ backgroundColor: 2, color: 3, from: 0, to: 10 }),
            expect.objectContaining({ bold: false, color: 1, from: 12, to: 14 }),
        ]);
    });

    it('keeps a hidden marker as a transparent sliver', () => {
        const draft = '**粗体** 后面';
        const spans = agentChatComposerSpans(draft, { end: draft.length, start: draft.length });
        const runs = agentChatComposerNativeRuns(spans, styleOf, color);
        expect(runs).toContainEqual(
            expect.objectContaining({ color: 0x01_00_00_00, fontSize: 1, from: 0, to: 2 }),
        );
        expect(runs).toContainEqual(expect.objectContaining({ bold: true, from: 2, to: 4 }));
    });
});
