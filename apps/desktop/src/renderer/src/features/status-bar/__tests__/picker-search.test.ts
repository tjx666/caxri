import { describe, expect, it } from 'vitest';

import { pickerSearchScore } from '../picker-search';

describe('Status bar picker search', () => {
    it('matches contiguous keyword text without fuzzy hits across shared directory names', () => {
        expect(
            pickerSearchScore('id', 'feature/manual', [
                'feature/recent-1',
                '/tmp/manual-worktrees/recent-1',
            ]),
        ).toBe(0);
        expect(pickerSearchScore('id', 'FEATURE/MANUAL', ['feature/manual'])).toBe(1);
        expect(pickerSearchScore('id', 'recent-1', ['/tmp/worktrees/recent-1'])).toBe(1);
    });
    it('falls back to the item value when the caller supplies no keywords', () => {
        expect(pickerSearchScore('fix/Signup-Retry', 'signup')).toBe(1);
        expect(pickerSearchScore('fix/signup-retry', 'deploy')).toBe(0);
    });
    it('keeps keyword-less action rows visible while the query is empty', () => {
        expect(pickerSearchScore('show-all-worktrees', '')).toBe(1);
        expect(pickerSearchScore('show-all-worktrees', ' '.repeat(3))).toBe(1);
        expect(pickerSearchScore('id', '', [])).toBe(1);
    });
});
