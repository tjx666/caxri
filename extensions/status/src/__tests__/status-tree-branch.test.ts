import { describe, expect, it } from 'vitest';

import { buildRepoNode } from '../status-tree';

/**
 * Split out of `status-tree.test.ts` (`source-layout`'s per-topic split, already used by
 * `status-tree-acceptance.test.ts`) so branch-row coverage keeps growing without pushing the shared file over the
 * `max-lines` budget.
 */
describe('Status extension branch row', () => {
    // A known PR lifecycle would otherwise win the branch icon; the in-flight probe must override it so
    // "Checking origin…" is never paired with a static glyph that looks finished.
    it('wears the pending spinner while checking, even over a known PR lifecycle', () => {
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'feature/status',
            acceptances: [],
            linearIssues: [],
            errors: [],
            pullRequest: {
                number: 9,
                title: 'PR',
                url: 'https://github.com/a/b/pull/9',
                lifecycle: 'open',
                state: 'success',
                hiddenCheckCount: 0,
                checks: [],
            },
            publication: { state: 'checking' },
        });
        const branch = root.children!.find((node) => node.item.id?.endsWith(':branch'))!;
        expect(branch.item.iconPath?.id).toBe('loading');
    });
});
