import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/relative-import-extension';

/**
 * Lints the fixture through the real flat config with `ignore: false`, which bypasses the `globalIgnores` entry for
 * `scripts/fixtures/eslint/**`, matching `scripts/__tests__/no-schema-version-offset.test.ts`.
 */
async function reportedLines(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages
        .filter((message) => message.ruleId === ruleId)
        .map((message) => `${message.line}:${message.messageId}`);
}

describe('caxri/relative-import-extension', () => {
    it('reports extensionless relative imports, re-exports, and dynamic imports only', async () => {
        expect(
            await reportedLines(
                'scripts/fixtures/eslint/relative-import-extension/relative-import-extension-fixture.ts',
            ),
        ).toEqual([
            '1:missingExtension',
            '2:missingExtension',
            '3:missingExtension',
            '4:missingExtension',
            '5:missingExtension',
        ]);
    });

    it('reports bare directory specifiers, which Node ESM never resolves to an index', async () => {
        const eslint = new ESLint({ cwd: root, ignore: false });
        const [result] = await eslint.lintText("export * from '.';\nexport * from '..';\n", {
            filePath:
                'scripts/fixtures/eslint/relative-import-extension/relative-import-extension-fixture.ts',
        });
        expect(
            result.messages.filter((message) => message.ruleId === ruleId).map(({ line }) => line),
        ).toEqual([1, 2]);
    });

    it('applies to the production sources of every package that emits a Node dist', async () => {
        const eslint = new ESLint({ cwd: root });
        const config = (await eslint.calculateConfigForFile(
            'packages/system/src/filesystem/bounded-file-reader.ts',
        )) as { rules?: Record<string, unknown> };
        expect(config.rules?.[ruleId]).toEqual([2]);
    });
});
