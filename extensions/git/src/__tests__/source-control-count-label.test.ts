import { describe, expect, it } from 'vitest';

import { formatRepoCountLabel as formatRepoCountLabel } from '../source-control-model';

const zero = { ahead: 0, behind: 0, count: 0, uncommittedCount: 0, unpushedCommitCount: 0 };

describe('formatRepoCountLabel', () => {
    it('shows nothing for a synced, clean repository', () => {
        expect(formatRepoCountLabel(zero)).toBe('');
    });

    it('keeps only the nonzero parts', () => {
        expect(formatRepoCountLabel({ ...zero, ahead: 2, count: 3 })).toBe(' · ↑2 · 3');
        expect(formatRepoCountLabel({ ...zero, behind: 1 })).toBe(' · ↓1');
        expect(
            formatRepoCountLabel({
                ahead: 1,
                behind: 4,
                count: 5,
                uncommittedCount: 1,
                unpushedCommitCount: 2,
            }),
        ).toBe(' · ↑1 ↓4 · 5 · 2 unpushed · 1 uncommitted');
    });
});
