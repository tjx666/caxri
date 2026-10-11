import type { CommanderInboxItem } from '@caxri/protocol';
import { commanderInboxKindLabel } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    commanderInboxMergeState,
    commanderInboxSections,
    inboxMentionCandidates,
    inboxMentionSuggestion,
    inboxReplyTarget,
    removeInboxMention,
} from '../commander-inbox';

function item(overrides: Partial<CommanderInboxItem> = {}): CommanderInboxItem {
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

describe('commanderInboxSections', () => {
    it('puts questions before pull requests and leaves closed items out', () => {
        const sections = commanderInboxSections([
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

describe('commanderInboxMergeState', () => {
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
        const state = commanderInboxMergeState(item({ kind: 'merge', pullRequest, ...overrides }));
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
        expect(inboxMentionCandidates(items, 'hands').map(({ id }) => id)).toEqual(['b']);
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
            description: commanderInboxKindLabel('hands'),
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
