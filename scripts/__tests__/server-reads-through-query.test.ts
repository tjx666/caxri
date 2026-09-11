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
    it('reports a read resolved into component state', async () => {
        expect(
            await lint(
                'scripts/fixtures/eslint/view-container-reads/component-state-read-fixture.ts',
            ),
        ).toContain(ruleId);
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
});
