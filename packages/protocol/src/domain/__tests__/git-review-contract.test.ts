import { describe, expect, it } from 'vitest';

import type { GitReviewComment } from '../git-review-contract';
import {
    formatGitReviewComments,
    formatReviewComment,
    formatReviewTerminalInput,
    isGitReviewPromptInline,
    reviewSnippet,
} from '../git-review-contract';

const comment: GitReviewComment = {
    id: 'comment-1',
    sessionId: 'session-1',
    repositoryId: 'repo-1',
    sourceKey: 'working',
    path: 'src/example.ts',
    side: 'modified',
    startLine: 2,
    endLine: 3,
    snippet: 'second\nthird',
    text: 'Handle this case',
    status: 'pending',
};

describe('Git review comment formatting', () => {
    it('serializes multiple line spans with paths, snippets, and feedback', () => {
        const result = formatGitReviewComments(
            [
                comment,
                { ...comment, id: 'comment-2', startLine: 7, endLine: 7, text: 'Rename this' },
            ],
            '/project',
            () => '/project/src/example.ts',
        );
        expect(result).toContain('@src/example.ts#L2-L3 (working, modified side)');
        expect(result).toContain('second\nthird');
        expect(result).toContain('Handle this case');
        expect(result).toContain('@src/example.ts#L7 (working, modified side)');
        expect(result).toContain('Rename this');
    });

    it('extracts an inclusive line span', () => {
        expect(reviewSnippet('one\ntwo\nthree', 2, 3)).toBe('two\nthree');
    });

    it('submits a multiline review as one bracketed paste', () => {
        expect(formatReviewTerminalInput('first\nsecond')).toBe(
            '\u{1B}[200~first\rsecond\u{1B}[201~\r',
        );
    });

    it('treats a prompt at or under the inline limit as inline', () => {
        expect(isGitReviewPromptInline('x'.repeat(4_000))).toBe(true);
        expect(isGitReviewPromptInline('x'.repeat(4_001))).toBe(false);
    });

    it('fences a snippet in a language, longer than any fence inside it', () => {
        expect(
            formatReviewComment(
                {
                    path: '/project/README.md',
                    side: 'modified',
                    startLine: 4,
                    endLine: 4,
                    snippet: '+```ts',
                    text: 'Close this block',
                },
                '/project',
                'Agent turn',
                'diff',
            ),
        ).toBe(
            [
                '@README.md#L4 (Agent turn, modified side)',
                '````diff',
                '+```ts',
                '````',
                'Close this block',
            ].join('\n'),
        );
    });
});
