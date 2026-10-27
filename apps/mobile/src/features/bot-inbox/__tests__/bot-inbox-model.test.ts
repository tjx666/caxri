import type { MobileBotInboxItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    botInboxCardModel,
    botInboxItems,
    botInboxReplyBody,
    botInboxReplyErrorMessage,
    botInboxScreenState,
} from '../bot-inbox-model';

const item = (overrides: Partial<MobileBotInboxItem> = {}): MobileBotInboxItem => ({
    id: 'item-1',
    kind: 'decision',
    title: 'Pick a table name',
    body: 'Which one?',
    isBodyClipped: false,
    options: [],
    replies: [],
    earlierReplyCount: 0,
    acknowledgedSequence: 0,
    updatedAt: 1_000_000,
    ...overrides,
});

describe('Bot Inbox mobile model', () => {
    it('describes a pull request card with the Desktop labels', () => {
        expect(
            botInboxCardModel(
                item({
                    kind: 'merge',
                    staleReason: 'headMoved',
                    pullRequest: {
                        url: 'https://github.com/acme/widgets/pull/7',
                        repo: 'widgets',
                        number: 7,
                    },
                }),
                1_000_000 + 5 * 60_000,
            ),
        ).toEqual({
            ageLabel: '5m ago',
            kindLabel: 'Pull request',
            pullRequestLabel: 'widgets#7',
            staleLabel: 'Changed since verified',
        });
    });

    it('shows the reply read state and "now" for a fresh item', () => {
        expect(
            botInboxCardModel(
                item({
                    kind: 'hands',
                    replies: [{ sequence: 1, body: 'done', createdAt: 1_000_000 }],
                }),
                1_000_000,
            ),
        ).toEqual({
            ageLabel: 'now',
            kindLabel: 'Your action',
            replyState: { isRead: false, label: 'Delivered to Caxri Bot' },
        });
    });

    it('orders questions above pull requests', () => {
        const ordered = botInboxItems({
            items: [item({ id: 'merge-1', kind: 'merge' }), item({ id: 'question-1' })],
            total: 2,
            truncated: false,
        });
        expect(ordered.map(({ id }) => id)).toEqual(['question-1', 'merge-1']);
        expect(botInboxItems(undefined)).toEqual([]);
    });

    it('accepts a reply exactly when the Server would', () => {
        expect(botInboxReplyBody(' '.repeat(3))).toBeNull();
        expect(botInboxReplyBody('  use accounts  ')).toBe('use accounts');
        expect(botInboxReplyBody('x'.repeat(8_193))).toBeNull();
    });

    it('keeps read data on screen while offline or after a failed refresh', () => {
        const base = { hasData: true, isError: false, isObservable: true, itemCount: 2 };
        expect(botInboxScreenState(base)).toEqual({
            kind: 'items',
            isStale: false,
            hasRefreshError: false,
        });
        expect(botInboxScreenState({ ...base, isObservable: false })).toMatchObject({
            kind: 'items',
            isStale: true,
        });
        expect(botInboxScreenState({ ...base, isError: true })).toMatchObject({
            hasRefreshError: true,
        });
        expect(botInboxScreenState({ ...base, itemCount: 0 })).toMatchObject({
            kind: 'empty',
        });
    });

    it('separates offline, loading, and failure before anything was read', () => {
        const base = { hasData: false, isError: false, isObservable: true, itemCount: 0 };
        expect(botInboxScreenState({ ...base, isObservable: false })).toEqual({
            kind: 'offline',
        });
        expect(botInboxScreenState(base)).toEqual({ kind: 'loading' });
        expect(botInboxScreenState({ ...base, isError: true })).toEqual({ kind: 'error' });
    });

    it('falls back to a plain reply failure message', () => {
        expect(botInboxReplyErrorMessage(new Error('Inbox item is closed'))).toBe(
            'Unable to send the reply.',
        );
        expect(botInboxReplyErrorMessage('nope')).toBe('Unable to send the reply.');
    });
});
