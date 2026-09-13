import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/server-reads-through-query';

/**
 * `scripts/fixtures/eslint/**` is excluded from the repository's own lint gate via `globalIgnores` (see
 * `eslint.config.ts`); `ignore: false` bypasses that here so the fixtures are linted through the real flat config
 * rather than an isolated `RuleTester`, matching `scripts/__tests__/filename-export-mapping.test.ts`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages.map((message) => message.ruleId);
}

describe('caxri/server-reads-through-query', () => {
    /**
     * Both bridge methods count: the fixture holds one `caxri.request` read and one `caxri.requestWithSignal` read, and
     * cancelling on unmount does not save the state the abortable one already resolved into.
     */
    it('reports every read resolved into component state', async () => {
        const reported = await lint(
            'scripts/fixtures/eslint/view-container-reads/component-state-read-fixture.ts',
        );

        expect(reported.filter((id) => id === ruleId)).toHaveLength(2);
    });

    it('stays silent for a read issued from a queryFn', async () => {
        expect(
            await lint(
                'scripts/fixtures/eslint/view-container-reads/query-function-read-fixture.ts',
            ),
        ).not.toContain(ruleId);
    });

    it('stays silent for a *-client.ts module that owns the RPC for the cache layer', async () => {
        expect(
            await lint('scripts/fixtures/eslint/view-container-reads/tree-branch-client.ts'),
        ).not.toContain(ruleId);
    });

    it('stays silent for a *-commands.ts module that owns the RPC for a feature', async () => {
        expect(
            await lint('scripts/fixtures/eslint/view-container-reads/tree-branch-commands.ts'),
        ).not.toContain(ruleId);
    });

    /**
     * The exemption is the two names the convention picked, not "any suffixed module". `*-actions.ts` is the Renderer's
     * UI-action layer and coexists with `*-commands.ts` in the same feature directories, so a request moved there is
     * still a request outside the data layer.
     */
    it('still reports a read moved into a *-actions.ts module', async () => {
        expect(
            await lint('scripts/fixtures/eslint/view-container-reads/tree-branch-actions.ts'),
        ).toContain(ruleId);
    });
});
