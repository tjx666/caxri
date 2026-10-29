import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import type { AgentChatRailMark } from '../agent-chat-rail-marks';
import {
    agentChatActiveRailIndex,
    agentChatRailActiveTick,
    agentChatRailCaption,
    agentChatRailCardText,
    agentChatRailFocusStep,
    agentChatRailMarks,
    agentChatRailPreview,
    agentChatRailPreviewParts,
    agentChatRailSampleIndices,
    agentChatRailTickCapacity,
    agentChatRailTimeFormatOptions,
    isAgentChatMessageRailShown,
    MAX_AGENT_CHAT_RAIL_MARKS,
    sampleAgentChatRailMarks,
} from '../agent-chat-rail-marks';

function railMark(id: string): AgentChatRailMark {
    return { id, preview: id, title: id, summary: '', kind: 'message', isReady: true };
}

/**
 * A message that cites one folder, as the composer sends it.
 */
const FOLDER_MESSAGE =
    '# Files mentioned by the user:\n\n## prettier-config: /work/prettier-config/\n\n## My request for Codex:\n';

describe('agentChatRailMarks', () => {
    it('marks each top-level user message in order', () => {
        expect(
            agentChatRailMarks(
                [
                    {
                        kind: 'item',
                        item: { id: 'u1', type: 'userMessage', text: 'first\n  line' },
                    },
                    {
                        kind: 'item',
                        item: { id: 'r1', type: 'agentMessage', text: 'ok', streaming: false },
                    },
                    { kind: 'work', id: 'work:x', items: [] },
                    {
                        kind: 'item',
                        item: { id: 'u2', type: 'userMessage', text: '', images: [{}, {}] },
                    },
                ],
                translate,
            ),
        ).toEqual([
            {
                id: 'u1',
                preview: 'first line',
                title: 'first',
                summary: 'line',
                kind: 'message',
                isReady: true,
            },
            {
                id: 'u2',
                preview: '2 images',
                title: '2 images',
                summary: 'Images only, no text',
                kind: 'images',
                isReady: true,
            },
        ]);
    });

    it('names a steered message and previews a delegated task by what its caller asked', () => {
        expect(
            agentChatRailMarks(
                [
                    {
                        kind: 'item',
                        item: {
                            id: 'u1',
                            type: 'userMessage',
                            text: 'also this',
                            delivery: 'steered',
                        },
                    },
                    {
                        kind: 'item',
                        item: {
                            id: 'u2',
                            type: 'userMessage',
                            text: 'Read the delegated task from "/x/task.md" and carry it out. Delegation ID: d1.',
                            delegatedTask: { delegationId: 'd1', prompt: 'Fix the build' },
                        },
                    },
                ],
                translate,
            ).map(({ kind, title }) => ({ kind, title })),
        ).toEqual([
            { kind: 'steered', title: 'also this' },
            { kind: 'delegated', title: 'Fix the build' },
        ]);
    });

    it('holds the skeleton only for a message with nothing to show yet', () => {
        const [mark] = agentChatRailMarks(
            [{ kind: 'item', item: { id: 'u1', type: 'userMessage', text: '  ' } }],
            translate,
        );
        expect(mark).toMatchObject({ isReady: false, title: '', summary: '' });
    });

    it('previews a message by its words, or by the folders it cites when it has none', () => {
        expect(
            agentChatRailMarks(
                [
                    {
                        kind: 'item',
                        item: { id: 'u1', type: 'userMessage', text: `${FOLDER_MESSAGE}tidy it` },
                    },
                    { kind: 'item', item: { id: 'u2', type: 'userMessage', text: FOLDER_MESSAGE } },
                ],
                translate,
            ),
        ).toMatchObject([
            { id: 'u1', preview: 'tidy it', title: 'tidy it' },
            { id: 'u2', preview: 'prettier-config', title: 'prettier-config' },
        ]);
    });

    it('cuts a long message to fit the preview', () => {
        const preview = agentChatRailPreview('a'.repeat(500), 0, translate);
        expect(preview).toHaveLength(120);
        expect(preview.endsWith('…')).toBe(true);
    });
});

describe('agentChatRailPreviewParts', () => {
    it('titles a message by its first line and keeps the rest as lines of summary', () => {
        expect(
            agentChatRailPreviewParts(
                'Fix the  build\n\n  then run   tests\nand ship',
                0,
                translate,
            ),
        ).toEqual({
            title: 'Fix the build',
            summary: 'then run tests\nand ship',
        });
    });

    it('ends a long first line at its first sentence when that fits', () => {
        expect(
            agentChatRailPreviewParts(
                'Please fix the flaky test. It fails on CI about once in ten runs and blocks every merge queue.',
                0,
                translate,
            ),
        ).toEqual({
            title: 'Please fix the flaky test.',
            summary: 'It fails on CI about once in ten runs and blocks every merge queue.',
        });
    });

    it('leaves the title empty and keeps a long line whole in the summary when no first sentence fits', () => {
        const line = 'Open /work/project/src/very/deeply/nested/module/index.ts please';
        expect(agentChatRailPreviewParts(`${line}\nthen tidy`, 0, translate)).toEqual({
            title: '',
            summary: `${line}\nthen tidy`,
        });
    });

    it('measures full-width text at double width and splits it at its own sentence end', () => {
        expect(
            agentChatRailPreviewParts(
                '修复构建。它在持续集成里大约每十次失败一次，先从缓存步骤查起。',
                0,
                translate,
            ),
        ).toEqual({
            title: '修复构建。',
            summary: '它在持续集成里大约每十次失败一次，先从缓存步骤查起。',
        });
    });

    it('bounds the summary it hands the card', () => {
        const { summary } = agentChatRailPreviewParts(`title\n${'b'.repeat(2000)}`, 0, translate);
        expect(summary).toHaveLength(400);
        expect(summary.endsWith('…')).toBe(true);
    });

    it('names a message of one image', () => {
        expect(agentChatRailPreviewParts('', 1, translate)).toEqual({
            title: 'Image',
            summary: 'Images only, no text',
        });
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
        expect(isAgentChatMessageRailShown([railMark('a')])).toBe(false);
        expect(isAgentChatMessageRailShown([railMark('a'), railMark('b')])).toBe(true);
    });
});

describe('sampleAgentChatRailMarks', () => {
    const marks = (count: number) =>
        Array.from({ length: count }, (_, index) => railMark(`u${index}`));

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

describe('agentChatRailCardText', () => {
    const caption = agentChatRailCaption(3, 12, 12, '17:59', translate);

    it('words the caption with position and time, or position alone', () => {
        expect(caption).toBe('Message 3 of 12 · 17:59');
        expect(agentChatRailCaption(3, 12, 12, undefined, translate)).toBe('Message 3 of 12');
    });

    it('does not claim a total while earlier history is unloaded', () => {
        expect(agentChatRailCaption(3, undefined, 8, '17:59', translate)).toBe('Sent at 17:59');
        expect(agentChatRailCaption(3, undefined, 8, undefined, translate)).toBe(
            'Message 3 of 8 loaded',
        );
    });

    it('fills an otherwise empty body with the caption', () => {
        expect(agentChatRailCardText({ title: 'table', summary: '' }, caption)).toEqual({
            title: 'table',
            body: caption,
            isBodyCaption: true,
        });
    });

    it('heads a title-less message with the caption and shows its full text once', () => {
        const parts = agentChatRailPreviewParts('word '.repeat(60), 0, translate);
        const text = agentChatRailCardText(parts, caption);
        expect(text.title).toBe(caption);
        expect(text.body).toBe(parts.summary);
        expect(text.body).not.toContain(text.title);
    });

    it('keeps a title and its remainder as they are', () => {
        expect(
            agentChatRailCardText({ title: 'Fix the build', summary: 'then ship' }, caption),
        ).toEqual({
            title: 'Fix the build',
            body: 'then ship',
            isBodyCaption: false,
        });
    });
});

describe('agentChatRailTimeFormatOptions', () => {
    const now = new Date(2026, 9, 26, 21, 15).getTime();

    it('shows the clock alone for a message sent today', () => {
        expect(agentChatRailTimeFormatOptions(new Date(2026, 9, 26, 0, 5).getTime(), now)).toEqual({
            hour: '2-digit',
            minute: '2-digit',
        });
    });

    it('adds the date for a message sent on an earlier day', () => {
        expect(
            agentChatRailTimeFormatOptions(new Date(2026, 9, 25, 23, 59).getTime(), now),
        ).toMatchObject({
            month: 'short',
            day: 'numeric',
        });
    });
});
