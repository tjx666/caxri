import { describe, expect, it } from 'vitest';

import { hookHealthFor } from '../health';

describe('hookHealthFor', () => {
    it('reports drifted with no message, so the row states the cause and the fix exactly once', () => {
        // `hookHealthLabel` (apps/desktop) already renders "Changed outside Caxri: restart Agent Terminals to
        // reapply it" for this kind; a message here used to repeat "outside Caxri" a second time in the same row.
        expect(hookHealthFor({ kind: 'drifted' }, true, 2)).toEqual({ kind: 'drifted' });
    });

    it("keeps a stale entry's schema-specific message, which is not the same sentence its label already says", () => {
        expect(hookHealthFor({ kind: 'stale', installedSchema: 1 }, true, 2)).toEqual({
            kind: 'stale',
            installedSchema: 1,
            message: 'Installed hook schema 1 needs an update.',
        });
    });
});
