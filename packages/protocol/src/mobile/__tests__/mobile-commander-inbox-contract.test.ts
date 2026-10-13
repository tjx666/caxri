import { describe, expect, it } from 'vitest';

import type { CommanderInboxItem } from '../../agent/agent-commander-inbox-contract.js';
import {
    commanderInboxKindLabel,
    commanderInboxReplyState,
    orderCommanderInboxItems,
} from '../../agent/agent-commander-inbox-presentation.js';
import {
    MOBILE_COMMANDER_INBOX_BODY_MAX_LENGTH,
    MOBILE_COMMANDER_INBOX_MAX_BYTES,
    MOBILE_COMMANDER_INBOX_MAX_REPLIES,
    mobileCommanderInboxListResultSchema,
    projectCommanderInboxForMobile,
} from '../mobile-commander-inbox-contract.js';

const item = (id: string, overrides: Partial<CommanderInboxItem> = {}): CommanderInboxItem => ({
    id,
    kind: 'decision',
    status: 'open',
    title: `Question ${id}`,
    body: '',
    options: [],
    replies: [],
    acknowledgedSequence: 0,
    revision: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
});

const reply = (sequence: number, body = `reply ${sequence}`) => ({
    sequence,
    body,
    source: 'desktop' as const,
    createdAt: 1_000 + sequence,
});

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('Commander Inbox presentation', () => {
    it('labels kinds with the Desktop names', () => {
        expect(commanderInboxKindLabel('decision')).toBe('Decision');
        expect(commanderInboxKindLabel('hands')).toBe('Needs you');
        expect(commanderInboxKindLabel('merge')).toBe('Pull request');
    });

    it('puts questions before pull requests and keeps the order within each group', () => {
        const ordered = orderCommanderInboxItems([
            item('merge-1', { kind: 'merge' }),
            item('decision-1'),
            item('merge-2', { kind: 'merge' }),
            item('hands-1', { kind: 'hands' }),
        ]);
        expect(ordered.map(({ id }) => id)).toEqual([
            'decision-1',
            'hands-1',
            'merge-1',
            'merge-2',
        ]);
    });

    it('reports the read state of the latest reply only', () => {
        expect(commanderInboxReplyState({ acknowledgedSequence: 0, replies: [] })).toBeUndefined();
        expect(
            commanderInboxReplyState({ acknowledgedSequence: 1, replies: [reply(1), reply(2)] }),
        ).toEqual({ isRead: false, label: 'Delivered to Commander' });
        expect(
            commanderInboxReplyState({ acknowledgedSequence: 2, replies: [reply(1), reply(2)] }),
        ).toEqual({ isRead: true, label: 'Read by Commander' });
    });
});

describe('projectCommanderInboxForMobile', () => {
    it('shortens long bodies and keeps only the newest replies, latest included', () => {
        const replies = Array.from({ length: MOBILE_COMMANDER_INBOX_MAX_REPLIES + 3 }, (_, index) =>
            reply(index + 1),
        );
        const result = projectCommanderInboxForMobile({
            generatedAt: 3_000,
            items: [item('long', { body: 'x'.repeat(10_000), replies, acknowledgedSequence: 8 })],
        });
        const [projected] = result.items;
        expect(projected.isBodyClipped).toBe(true);
        expect(projected.body.startsWith('x'.repeat(MOBILE_COMMANDER_INBOX_BODY_MAX_LENGTH))).toBe(
            true,
        );
        expect(projected.body.endsWith('…')).toBe(true);
        expect(projected.replies.map(({ sequence }) => sequence)).toEqual([4, 5, 6, 7, 8]);
        expect(projected.earlierReplyCount).toBe(3);
        expect(commanderInboxReplyState(projected)?.isRead).toBe(true);
        expect(mobileCommanderInboxListResultSchema.parse(result)).toEqual(result);
    });

    it('fits one mobile frame by dropping pull requests before questions', () => {
        const big = 'y'.repeat(MOBILE_COMMANDER_INBOX_BODY_MAX_LENGTH);
        const items = [
            ...Array.from({ length: 20 }, (_, index) =>
                item(`merge-${index}`, { kind: 'merge', body: big }),
            ),
            ...Array.from({ length: 5 }, (_, index) => item(`question-${index}`, { body: big })),
        ];
        const result = projectCommanderInboxForMobile({ generatedAt: 3_000, items });
        expect(byteLength(result)).toBeLessThanOrEqual(MOBILE_COMMANDER_INBOX_MAX_BYTES);
        expect(result.truncated).toBe(true);
        expect(result.total).toBe(25);
        expect(result.items.slice(0, 5).map(({ id }) => id)).toEqual([
            'question-0',
            'question-1',
            'question-2',
            'question-3',
            'question-4',
        ]);
        expect(result.items.length).toBeLessThan(25);
    });

    it('omits closed items from both the list and the total', () => {
        const result = projectCommanderInboxForMobile({
            generatedAt: 3_000,
            items: [
                item('open-1'),
                item('closed-1', { status: 'closed', closeReason: 'dismissed' }),
            ],
        });
        expect(result).toMatchObject({ total: 1, truncated: false, items: [{ id: 'open-1' }] });
    });
});
