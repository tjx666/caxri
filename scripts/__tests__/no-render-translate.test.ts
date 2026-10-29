import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/no-render-translate';
const fixture = 'scripts/fixtures/eslint/no-render-translate/no-render-translate-fixture.tsx';

/**
 * Linted through the real flat config so the file-scoped wiring is covered too; `ignore: false` bypasses the
 * `globalIgnores` entry for `scripts/fixtures/eslint/**`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages.filter((message) => message.ruleId === ruleId);
}

describe('caxri/no-render-translate', () => {
    /**
     * A direct call, passing `translate` as an argument, a synchronous array callback, and a `useMemo` callback all run
     * while the component or hook renders, where React Compiler would cache the stale language.
     */
    it('reports module-level translate used while a component or hook renders', async () => {
        const reported = await lint(fixture);

        expect(reported.map((message) => message.line)).toEqual([10, 14, 18, 22]);
    });

    it('stays silent for event handlers, the hook-provided t, and plain helpers', async () => {
        const reported = await lint(fixture);

        expect(reported.some((message) => message.line >= 25)).toBe(false);
    });
});
