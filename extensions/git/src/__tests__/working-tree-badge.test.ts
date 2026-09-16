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

    /**
     * The panel drops a gitlink row whose submodule has a section of its own, so a badge that still counted it would
     * read 3 above a list showing 2.
     */
    it('subtracts the gitlink rows the panel hides', () => {
        expect(
            workingTreeBadge({
                isRepository: true,
                repositories: [
                    {
                        ...repo,
                        changedFileCount: 3,
                        files: [
                            ...repo.files,
                            {
                                path: 'vendor/library',
                                index: 'M',
                                workingTree: ' ',
                                kind: 'modified' as const,
                            },
                            {
                                path: 'README.md',
                                index: ' ',
                                workingTree: 'M',
                                kind: 'modified' as const,
                            },
                        ],
                    },
                    {
                        ...repo,
                        id: 'submodule',
                        kind: 'submodule' as const,
                        rootPath: '/authorized/project/vendor/library',
                        changedFileCount: 0,
                        files: [],
                    },
                ],
            }),
        ).toEqual({ kind: 'count', count: 2, description: '2 changes' });
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
