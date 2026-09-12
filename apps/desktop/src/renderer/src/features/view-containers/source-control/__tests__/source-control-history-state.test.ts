import { describe, expect, it } from 'vitest';

import {
    applySourceControlHistoryPage,
    areSourceControlHistoryActionsCurrent,
} from '../source-control-history-state';

function item(id: string) {
    return {
        action: {
            command: { id: 'caxri.git.openCommit' },
            icon: { kind: 'theme' as const, id: 'git-commit' },
            id: `action-${id}`,
            label: id,
        },
        author: 'Author',
        authorFallback: 'A',
        decorations: [],
        description: id,
        id,
        label: id,
        timestamp: 1,
        tooltipTimestamp: 'January 1, 1970',
    };
}

describe('applySourceControlHistoryPage', () => {
    it('replaces the visible page in one shot instead of emptying it first', () => {
        const current = {
            items: [item('old-1'), item('old-2')],
            nextOffset: 2,
            selectedId: 'old-1',
        };
        const next = applySourceControlHistoryPage(
            current,
            { items: [item('new-1')], nextOffset: undefined, revision: '2' },
            true,
        );

        expect(next.items.map((entry) => entry.id)).toEqual(['new-1']);
        expect(next.selectedId).toBeUndefined();
        expect(next.nextOffset).toBeUndefined();
    });

    it('keeps a selection that still exists after a replace', () => {
        const current = {
            items: [item('commit-1')],
            nextOffset: 1,
            selectedId: 'commit-1',
        };

        expect(
            applySourceControlHistoryPage(
                current,
                { items: [item('commit-1'), item('commit-2')], nextOffset: 2, revision: '1' },
                true,
            ).selectedId,
        ).toBe('commit-1');
    });

    it('appends the next page without dropping the current selection', () => {
        const current = {
            items: [item('commit-1')],
            nextOffset: 1,
            selectedId: 'commit-1',
        };
        const next = applySourceControlHistoryPage(
            current,
            { items: [item('commit-2')], nextOffset: 2, path: '/project/file.ts', revision: '1' },
            false,
        );

        expect(next.items.map((entry) => entry.id)).toEqual(['commit-1', 'commit-2']);
        expect(next.selectedId).toBe('commit-1');
        expect(next.nextOffset).toBe(2);
        expect(next.committedRevision).toBe('1');
        expect(next.committedPath).toBe('/project/file.ts');
    });

    it('disables kept-page actions until the replacement identity commits', () => {
        const current = applySourceControlHistoryPage(
            { items: [], nextOffset: undefined, selectedId: undefined },
            {
                items: [item('commit-1')],
                nextOffset: undefined,
                path: '/project/file.ts',
                revision: '1',
            },
            true,
        );

        expect(
            areSourceControlHistoryActionsCurrent(current, {
                path: '/project/file.ts',
                revision: '1',
            }),
        ).toBe(true);
        expect(
            areSourceControlHistoryActionsCurrent(current, {
                path: '/project/file.ts',
                revision: '2',
            }),
        ).toBe(false);
        expect(
            areSourceControlHistoryActionsCurrent(current, {
                path: '/project/other.ts',
                revision: '1',
            }),
        ).toBe(false);
    });
});
