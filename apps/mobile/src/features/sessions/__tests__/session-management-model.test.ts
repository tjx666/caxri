import { describe, expect, it } from 'vitest';

import { sessionRenameDraft } from '../session-management-model';

describe('sessionRenameDraft', () => {
    it('returns the trimmed title for a valid change', () => {
        expect(sessionRenameDraft('  Fix login  ', 'Untitled')).toBe('Fix login');
    });

    it('rejects blank, unchanged, multi-line, and over-long titles', () => {
        expect(sessionRenameDraft(' '.repeat(3), 'Untitled')).toBeNull();
        expect(sessionRenameDraft(' Same ', 'Same')).toBeNull();
        expect(sessionRenameDraft('two\nlines', 'Untitled')).toBeNull();
        expect(sessionRenameDraft('x'.repeat(201), 'Untitled')).toBeNull();
    });
});
