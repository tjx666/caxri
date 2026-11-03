import { describe, expect, it } from 'vitest';

import { sessionRowKeyShortcuts } from '../session-row-key-shortcuts';

describe('sessionRowKeyShortcuts', () => {
    it('announces rename and reorder on an ordinary row that can be renamed with AI', () => {
        expect(
            sessionRowKeyShortcuts({ canReorder: true, canSuggest: true, renaming: false }),
        ).toBe('Shift+Enter Alt+ArrowUp Alt+ArrowDown');
    });

    it('drops Rename with AI when the Session cannot be asked for a name', () => {
        expect(
            sessionRowKeyShortcuts({ canReorder: true, canSuggest: false, renaming: false }),
        ).toBe('Alt+ArrowUp Alt+ArrowDown');
    });

    it('announces no reorder keys on a nested row, which cannot move', () => {
        expect(
            sessionRowKeyShortcuts({ canReorder: false, canSuggest: true, renaming: false }),
        ).toBe('Shift+Enter');
        expect(
            sessionRowKeyShortcuts({ canReorder: false, canSuggest: false, renaming: false }),
        ).toBeUndefined();
    });

    it('announces nothing while the row is being renamed', () => {
        expect(
            sessionRowKeyShortcuts({ canReorder: false, canSuggest: true, renaming: true }),
        ).toBeUndefined();
    });
});
