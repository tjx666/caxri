import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/bounded-external-reads';

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

describe('caxri/bounded-external-reads', () => {
    it('reports readFile and readFileSync through named, default, namespace, and promises imports, not the bounded reader or a justified disable', async () => {
        expect(
            await reportedLines(
                'scripts/fixtures/eslint/bounded-external-reads/bounded-external-reads-fixture.ts',
            ),
        ).toEqual([
            '8:unbounded',
            '9:unbounded',
            '10:unbounded',
            '11:unbounded',
            '12:unbounded',
            '13:unbounded',
        ]);
    });
});
