import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { splitGrantableProjects, summarizeProjectAccess } from '../mobile-access-summary';

describe('summarizeProjectAccess', () => {
    it('joins every resolved title when none are unavailable', () => {
        expect(summarizeProjectAccess(translate, ['Caxri', 'Website'])).toBe('Caxri, Website');
    });

    it('collapses repeated unresolved grants into one trailing count', () => {
        expect(summarizeProjectAccess(translate, ['Caxri', undefined, undefined])).toBe(
            'Caxri · +2 unavailable',
        );
    });

    it('reports only the count when every grant is unresolved', () => {
        expect(summarizeProjectAccess(translate, [undefined, undefined, undefined])).toBe(
            '+3 unavailable',
        );
    });

    it('reads as empty when the device has no grants at all', () => {
        expect(summarizeProjectAccess(translate, [])).toBe('');
    });
});

describe('splitGrantableProjects', () => {
    it('offers only top-level Projects and remembers the worktree Project ids', () => {
        const result = splitGrantableProjects({
            view: 'desktop',
            projects: [
                { id: 'project-1', displayTitle: 'Caxri', rootPath: '$HOME/caxri' },
                {
                    id: 'project-2',
                    displayTitle: 'feature',
                    rootPath: '$HOME/caxri-worktrees/feature',
                    ownerProjectId: 'project-1',
                },
            ],
        });
        expect(result.projects.map(({ id }) => id)).toEqual(['project-1']);
        expect([...result.worktreeProjectIds]).toEqual(['project-2']);
    });
});
