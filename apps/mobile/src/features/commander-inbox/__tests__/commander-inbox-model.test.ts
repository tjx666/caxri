import type { MobileCommanderInboxItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    commanderInboxCardModel,
    commanderInboxItems,
    commanderInboxReplyBody,
    commanderInboxReplyErrorMessage,
    commanderInboxScreenState,
} from '../commander-inbox-model';

const item = (overrides: Partial<MobileCommanderInboxItem> = {}): MobileCommanderInboxItem => ({
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

describe('Commander Inbox mobile model', () => {
    it('describes a pull request card with the Desktop labels', () => {
        expect(
            commanderInboxCardModel(
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
            commanderInboxCardModel(
                item({
                    kind: 'hands',
                    replies: [{ sequence: 1, body: 'done', createdAt: 1_000_000 }],
                }),
                1_000_000,
            ),
        ).toEqual({
            ageLabel: 'now',
            kindLabel: 'Your action',
            replyState: { isRead: false, label: 'Delivered to Commander' },
        });
    });

    it('orders questions above pull requests', () => {
        const ordered = commanderInboxItems({
            items: [item({ id: 'merge-1', kind: 'merge' }), item({ id: 'question-1' })],
            total: 2,
            truncated: false,
        });
        expect(ordered.map(({ id }) => id)).toEqual(['question-1', 'merge-1']);
        expect(commanderInboxItems(undefined)).toEqual([]);
    });

    it('accepts a reply exactly when the Server would', () => {
        expect(commanderInboxReplyBody(' '.repeat(3))).toBeNull();
        expect(commanderInboxReplyBody('  use accounts  ')).toBe('use accounts');
        expect(commanderInboxReplyBody('x'.repeat(8_193))).toBeNull();
    });

    it('keeps read data on screen while offline or after a failed refresh', () => {
        const base = { hasData: true, isError: false, isObservable: true, itemCount: 2 };
        expect(commanderInboxScreenState(base)).toEqual({
            kind: 'items',
            isStale: false,
            hasRefreshError: false,
        });
        expect(commanderInboxScreenState({ ...base, isObservable: false })).toMatchObject({
            kind: 'items',
            isStale: true,
        });
        expect(commanderInboxScreenState({ ...base, isError: true })).toMatchObject({
            hasRefreshError: true,
        });
        expect(commanderInboxScreenState({ ...base, itemCount: 0 })).toMatchObject({
            kind: 'empty',
        });
    });

    it('separates offline, loading, and failure before anything was read', () => {
        const base = { hasData: false, isError: false, isObservable: true, itemCount: 0 };
        expect(commanderInboxScreenState({ ...base, isObservable: false })).toEqual({
            kind: 'offline',
        });
        expect(commanderInboxScreenState(base)).toEqual({ kind: 'loading' });
        expect(commanderInboxScreenState({ ...base, isError: true })).toEqual({ kind: 'error' });
    });

    it('falls back to a plain reply failure message', () => {
        expect(commanderInboxReplyErrorMessage(new Error('Inbox item is closed'))).toBe(
            'Inbox item is closed',
        );
        expect(commanderInboxReplyErrorMessage('nope')).toBe('Unable to send the reply.');
    });
});
