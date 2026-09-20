import { describe, expect, it } from 'vitest';

import { projectSearchQueryKey } from '../project-search-query';

describe('projectSearchQueryKey', () => {
    it('keeps the Workbench Root in the cache scope', () => {
        expect(
            projectSearchQueryKey('session-1:project-a', { mode: 'name', query: 'README' }),
        ).toEqual(['files.search', 'session-1:project-a', { mode: 'name', query: 'README' }]);
    });

    it('separates two Workbench Roots of one Session, whose authorized roots differ', () => {
        const options = { mode: 'content', query: 'TODO' };

        expect(projectSearchQueryKey('session-1:project-a', options)).not.toEqual(
            projectSearchQueryKey('session-1:project-b', options),
        );
    });
});
