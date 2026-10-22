import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

const source = `export function sample(items: number[]): number {
    let pending;
    const empty = [];
    let typed: number[] = [];
    const ready: string | undefined = undefined;
    for (const item of items) typed.push(item);
    for (let index in items) typed.push(Number(index));
    pending = empty.length + typed.length;
    return pending + (ready?.length ?? 0);
}
`;

/**
 * Linted through the real flat config so the upstream-off, local-on wiring is covered too.
 */
async function lint(filePath: string, text = source) {
    const eslint = new ESLint({ cwd: root });
    const [result] = await eslint.lintText(text, { filePath: resolve(root, filePath) });
    expect(result.messages.filter((message) => message.fatal)).toEqual([]);
    return result.messages.filter((message) =>
        message.ruleId?.endsWith('/no-declare-implicit-any-var'),
    );
}

describe('caxri/no-declare-implicit-any-var', () => {
    it('reports untyped declarations without an initializer or with an empty array', async () => {
        const reported = await lint('packages/utils/src/no-declare-implicit-any-var-sample.ts');

        expect(reported.map((message) => [message.ruleId, message.line])).toEqual([
            ['caxri/no-declare-implicit-any-var', 2],
            ['caxri/no-declare-implicit-any-var', 3],
        ]);
    });

    it('ignores JavaScript files', async () => {
        const reported = await lint(
            'scripts/no-declare-implicit-any-var-sample.mjs',
            'let pending;\nconst empty = [];\nexport default [pending, empty];\n',
        );

        expect(reported).toEqual([]);
    });
});
