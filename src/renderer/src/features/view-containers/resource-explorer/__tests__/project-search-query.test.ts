import { describe, expect, it } from 'vitest';

import { projectSearchQueryKey } from '../project-search-query';

describe('projectSearchQueryKey', () => {
    it('keeps the Workbench Root in the cache scope', () => {
        expect(
            projectSearchQueryKey(
                'publisher.files.explorer',
                { mode: 'name', query: 'README' },
                'session-1:project-a',
            ),
        ).toEqual([
            'viewContainers.viewOperation',
            {
                viewId: 'publisher.files.explorer',
                operation: 'files.search',
                arguments: { mode: 'name', query: 'README' },
                contextKey: 'session-1:project-a',
            },
        ]);
    });
});
