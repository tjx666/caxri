import type { BotInboxItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    botInboxMergeState,
    botInboxSections,
    inboxMentionCandidates,
    inboxMentionSuggestion,
    inboxReplyTarget,
    inboxSendTooltip,
    insertInboxMentionTrigger,
    openBotInboxCount,
    removeInboxMention,
} from '../bot-inbox';

function item(overrides: Partial<BotInboxItem> = {}): BotInboxItem {
    return {
        id: 'item-1',
        kind: 'decision',
        status: 'open',
        title: 'Pick a table layout',
        body: '',
        options: [],
        replies: [],
        acknowledgedSequence: 0,
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

const pullRequest = {
    url: 'https://github.com/acme/widgets/pull/7',
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    headSha: 'a'.repeat(40),
};

describe('botInboxSections', () => {
    it('puts questions before pull requests and leaves closed items out', () => {
        const sections = botInboxSections([
            item({ id: 'merge', kind: 'merge', pullRequest }),
            item({ id: 'hands', kind: 'hands' }),
            item({ id: 'closed', status: 'closed', closeReason: 'resolved' }),
        ]);
        expect(sections.map((section) => [section.id, section.items.map(({ id }) => id)])).toEqual([
            ['questions', ['hands']],
            ['merge', ['merge']],
        ]);
    });
});

describe('openBotInboxCount', () => {
    it('counts open items except those still inside their dismissal Undo window', () => {
        const items = [
            item({ id: 'a' }),
            item({ id: 'b' }),
            item({ id: 'c', status: 'closed', closeReason: 'resolved' }),
        ];
        expect(openBotInboxCount(items)).toBe(2);
        expect(openBotInboxCount(items, { a: true })).toBe(1);
    });
});

describe('botInboxMergeState', () => {
    it.each([
        [{ staleReason: 'headMoved' as const }, false, 'Changed since verified'],
        [
            { pullRequestLive: { title: 't', lifecycle: 'draft' as const, refreshedAt: 1 } },
            false,
            'Draft',
        ],
        [
            {
                pullRequestLive: {
                    title: 't',
                    lifecycle: 'open' as const,
                    mergeState: 'conflicting' as const,
                    refreshedAt: 1,
                },
            },
            false,
            'Conflicts',
        ],
        [{}, true, 'GitHub state unknown'],
        [
            {
                pullRequestLive: {
                    title: 't',
                    lifecycle: 'open' as const,
                    checks: 'failure' as const,
                    refreshedAt: 1,
                },
            },
            true,
            'Checks failing',
        ],
        [
            {
                pullRequestLive: {
                    title: 't',
                    lifecycle: 'open' as const,
                    checks: 'success' as const,
                    mergeState: 'clean' as const,
                    refreshedAt: 1,
                },
            },
            true,
            'Checks passed',
        ],
    ])('%o -> canMerge %s (%s)', (overrides, canMerge, label) => {
        const state = botInboxMergeState(item({ kind: 'merge', pullRequest, ...overrides }));
        expect(state).toMatchObject({ canMerge, label });
    });
});

describe('Inbox mentions', () => {
    it('filters open items by title or kind and removes the token once chosen', () => {
        const items = [
            item({ id: 'a', title: 'Pick a table layout' }),
            item({ id: 'b', kind: 'hands', title: 'Log in to the registry' }),
            item({ id: 'c', title: 'Table', status: 'closed' }),
        ];
        expect(inboxMentionCandidates(items, 'TABLE').map(({ id }) => id)).toEqual(['a']);
        expect(inboxMentionCandidates(items, 'your action').map(({ id }) => id)).toEqual(['b']);
        expect(removeInboxMention('Use @tab two tables', { start: 4, end: 8 })).toEqual({
            text: 'Use  two tables',
            caret: 4,
        });
    });

    it('renders a candidate as a picker row keyed by the item id', () => {
        expect(
            inboxMentionSuggestion(
                item({ id: 'b', kind: 'hands', title: 'Log in to the registry' }),
            ),
        ).toEqual({
            key: 'b',
            label: 'Log in to the registry',
            isLabelLiteral: false,
            description: 'Your action',
        });
    });

    it('replies to the chosen open item, or to the only open question', () => {
        const merge = item({ id: 'm', kind: 'merge', pullRequest });
        const question = item({ id: 'q' });
        expect(inboxReplyTarget([merge, question], undefined)?.id).toBe('q');
        expect(inboxReplyTarget([merge, question], 'm')?.id).toBe('m');
        expect(inboxReplyTarget([merge, question, item({ id: 'r' })], undefined)).toBeUndefined();
        expect(inboxReplyTarget([question], 'gone')).toBeUndefined();
    });
});

describe('insertInboxMentionTrigger', () => {
    it('starts a mention at the caret as its own word', () => {
        expect(insertInboxMentionTrigger('', 0)).toEqual({ text: '@', caret: 1 });
        expect(insertInboxMentionTrigger('Ship it', 7)).toEqual({ text: 'Ship it @', caret: 9 });
        expect(insertInboxMentionTrigger('Ship it ', 8)).toEqual({ text: 'Ship it @', caret: 9 });
        expect(insertInboxMentionTrigger('Ship it', 4)).toEqual({ text: 'Ship @ it', caret: 6 });
    });
});

describe('inboxSendTooltip', () => {
    it('says why Send cannot send before naming its shortcut', () => {
        expect(inboxSendTooltip({ draft: 'Yes', hasTarget: false })).toBe(
            'Choose an item with @ first',
        );
        expect(inboxSendTooltip({ draft: '  ', hasTarget: true })).toBe('Type a reply');
        expect(inboxSendTooltip({ draft: 'Yes', hasTarget: true })).toBe('Send (Enter)');
    });
});
