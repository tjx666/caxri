import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatReviewComment,
    agentChatReviewRange,
    collectAgentChatTurnReview,
    formatAgentChatReviewComment,
} from '../agent-chat-turn-review';

const fileChange = (
    id: string,
    turnId: string,
    changes: Extract<AgentChatItem, { type: 'fileChange' }>['changes'],
): AgentChatItem => ({ id, turnId, type: 'fileChange', status: 'completed', changes });

const items: AgentChatItem[] = [
    fileChange('f0', 'turn-0', [
        { path: '/p/old.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
    ]),
    fileChange('f1', 'turn-1', [
        { path: '/p/a.ts', kind: 'update', diff: '@@ -1,2 +1,2 @@\n keep\n-old\n+new' },
        { path: '/p/b.ts', kind: 'add', diff: 'one\ntwo\n' },
    ]),
    fileChange('f2', 'turn-1', [
        { path: '/p/a.ts', kind: 'update', diff: '@@ -2 +2,2 @@\n new\n+more' },
    ]),
];

describe('collectAgentChatTurnReview', () => {
    it('lists only the files the turn changed, each merged across its edits', () => {
        const files = collectAgentChatTurnReview(items, 'turn-1');
        expect(files.map(({ file }) => file.path)).toEqual(['/p/a.ts', '/p/b.ts']);
        expect(files[0]?.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
            'hunk:@@ -1,2 +1,2 @@',
            'context:keep',
            'removed:old',
            'added:new',
            'hunk:@@ -2 +2,2 @@',
            'context:new',
            'added:more',
        ]);
        expect(collectAgentChatTurnReview(items, 'turn-9')).toEqual([]);
    });
});

describe('agentChatReviewComment', () => {
    const files = collectAgentChatTurnReview(items, 'turn-1');
    const file = files.at(0);
    const added = files.at(1);
    if (!file || !added) throw new Error('missing file');

    it('records which edit and hunk each line of a file edited twice came from', () => {
        expect(file.edits).toEqual([0, 0, 0, 0, 1, 1, 1]);
        expect(file.hunks).toEqual([0, 0, 0, 0, 1, 1, 1]);
    });

    it('extends a range within one hunk and restarts it in another', () => {
        expect(agentChatReviewRange(file, 3, 1)).toEqual({ start: 1, end: 3 });
        expect(agentChatReviewRange(file, 3, 5)).toEqual({ start: 5, end: 5 });
    });

    it('cites the new lines of a range that adds or keeps code, naming the edit', () => {
        expect(
            agentChatReviewComment(file, agentChatReviewRange(file, 3, 1), ' Rename it '),
        ).toEqual({
            path: '/p/a.ts',
            source: 'Agent turn diff, edit 1 of 2',
            side: 'modified',
            startLine: 1,
            endLine: 2,
            snippet: ' keep\n-old\n+new',
            text: 'Rename it',
        });
    });

    it('cites the old lines of a range that only removes code', () => {
        expect(agentChatReviewComment(file, { start: 2, end: 2 }, 'Why?')).toMatchObject({
            side: 'original',
            startLine: 2,
            endLine: 2,
            snippet: '-old',
        });
    });

    it('skips a hunk header inside a range and refuses a range of the header alone', () => {
        expect(agentChatReviewComment(file, { start: 0, end: 1 }, 'x')).toMatchObject({
            startLine: 1,
            endLine: 1,
            snippet: ' keep',
        });
        expect(agentChatReviewComment(file, { start: 0, end: 0 }, 'x')).toBeUndefined();
    });

    it('formats a comment for the composer as a Git diff review cites it', () => {
        const later = agentChatReviewComment(file, { start: 6, end: 6 }, 'Rename it');
        const only = agentChatReviewComment(added, { start: 0, end: 1 }, 'Fine');
        if (!later || !only) throw new Error('missing comment');
        expect(formatAgentChatReviewComment(later, '/p')).toBe(
            [
                '@a.ts#L3 (Agent turn diff, edit 2 of 2, modified side)',
                '```diff',
                '+more',
                '```',
                'Rename it',
            ].join('\n'),
        );
        expect(formatAgentChatReviewComment(only, '/p').split('\n', 1).at(0)).toBe(
            '@b.ts#L1-L2 (Agent turn diff, modified side)',
        );
    });
});
