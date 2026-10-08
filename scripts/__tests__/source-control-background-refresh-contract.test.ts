import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

const sourceControlRoot = join(
    process.cwd(),
    'apps/desktop/src/renderer/src/features/view-containers/source-control',
);

/**
 * `NAVIGABLE_TREE_ITEM_SELECTOR` excludes both `[disabled]` and `[aria-disabled="true"]`, so a row that marks itself
 * unavailable leaves the arrow-key walk, `resolveActiveTreeRowId` falls back to the first row, and a keyboard user
 * loses their place in the tree. That is the right outcome for a row that is permanently not a target, and the wrong
 * one for a row waiting out a Git refresh, a state that arrives and leaves several times a minute, usually while the
 * keyboard is sitting on `Load more`.
 *
 * DESIGN.md's `Background refresh` rule settles it: an action bound to a revision the refresh may invalidate is refused
 * at execution time with a readable reason, never disabled in advance. Nothing in the pure focus helpers can see the
 * rule being broken, because the breakage is a JSX attribute, so it is asserted against the source that has to honour
 * it, the same way this directory's other Renderer contracts are.
 */
describe('Source Control background refresh', () => {
    it('never binds a row `disabled` to a transient refresh state', async () => {
        const source = await readFile(
            join(sourceControlRoot, 'source-control-history.tsx'),
            'utf8',
        );
        const disabledBindings = source.match(/disabled=\{[^}]*\}/g) ?? [];
        expect(disabledBindings.length).toBeGreaterThan(0);
        for (const binding of disabledBindings)
            for (const transient of ['areActionsCurrent', 'loading', 'debouncedPath'])
                expect(binding, `a disabled binding reads ${transient}`).not.toContain(transient);
    });
});
