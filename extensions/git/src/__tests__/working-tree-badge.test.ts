import { describe, expect, it } from 'vitest';

import { workingTreeBadge } from '../working-tree-badge';
import { repo } from './git-provider.fixture';

describe('working tree badge', () => {
    it('counts all repositories before filtering and truncation', () => {
        expect(
            workingTreeBadge({
                isRepository: true,
                repositories: [
                    { ...repo, changedFileCount: 120, truncated: true, files: [] },
                    { ...repo, id: 'submodule', kind: 'submodule', changedFileCount: 2 },
                ],
            }),
        ).toEqual({ kind: 'count', count: 122, description: '122 changes' });
    });

    it('hides zero and unavailable summaries', () => {
        expect(workingTreeBadge({ isRepository: false, repositories: [] })).toBeUndefined();
        expect(
            workingTreeBadge({ isRepository: true, repositories: [repo], error: 'Unavailable' }),
        ).toBeUndefined();
        expect(
            workingTreeBadge({
                isRepository: true,
                repositories: [{ ...repo, changedFileCount: 0 }],
            }),
        ).toBeUndefined();
    });

    it('describes a single change', () => {
        expect(workingTreeBadge({ isRepository: true, repositories: [repo] })?.description).toBe(
            '1 change',
        );
    });
});
