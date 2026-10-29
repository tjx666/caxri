import { describe, expect, it } from 'vitest';

import { mapCodexReviewItem, parseCodexReviewArguments } from '../codex-review';

describe('parseCodexReviewArguments', () => {
    it('reviews the uncommitted changes without arguments', () => {
        expect(parseCodexReviewArguments(undefined)).toEqual({ type: 'uncommittedChanges' });
        expect(parseCodexReviewArguments(' '.repeat(3))).toEqual({ type: 'uncommittedChanges' });
    });

    it('maps --base, --commit, and free text to their targets', () => {
        expect(parseCodexReviewArguments('--base main')).toEqual({
            type: 'baseBranch',
            branch: 'main',
        });
        expect(parseCodexReviewArguments('--commit abc1234')).toEqual({
            type: 'commit',
            sha: 'abc1234',
            title: null,
        });
        expect(parseCodexReviewArguments('look at the retry logic\nand the cache')).toEqual({
            type: 'custom',
            instructions: 'look at the retry logic\nand the cache',
        });
        // Only the exact flags are special; other text is instructions.
        expect(parseCodexReviewArguments('--basement leaks')).toEqual({
            type: 'custom',
            instructions: '--basement leaks',
        });
    });

    it('rejects a flag without a single value', () => {
        for (const bad of ['--base', '--base  ', '--commit', '--base a b', '--commit a b'])
            expect(() => parseCodexReviewArguments(bad)).toThrow(
                expect.objectContaining({ code: 'VALIDATION' }),
            );
    });
});

describe('mapCodexReviewItem', () => {
    it('shows entering review mode as a notice and leaving it as the review text', () => {
        expect(
            mapCodexReviewItem(
                { type: 'enteredReviewMode', id: 'e', review: 'current changes' },
                {
                    id: 'e',
                    turnId: 't',
                },
            ),
        ).toEqual({
            id: 'e',
            turnId: 't',
            type: 'notice',
            kind: 'output',
            message: 'Reviewing current changes',
        });
        expect(
            mapCodexReviewItem(
                { type: 'exitedReviewMode', id: 'x', review: '## Findings' },
                {
                    id: 'x',
                },
            ),
        ).toEqual({ id: 'x', type: 'agentMessage', text: '## Findings', streaming: false });
        expect(
            mapCodexReviewItem({ type: 'exitedReviewMode', id: 'x', review: ' ' }, { id: 'x' }),
        ).toBeUndefined();
    });
});
