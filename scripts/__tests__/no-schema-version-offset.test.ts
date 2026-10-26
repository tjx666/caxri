import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/no-schema-version-offset';

/**
 * Lints the fixture through the real flat config with `ignore: false`, which bypasses the `globalIgnores` entry for
 * `scripts/fixtures/eslint/**`, matching `scripts/__tests__/listener-fanout-isolation.test.ts`.
 */
async function reportedLines(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages
        .filter((message) => message.ruleId === ruleId)
        .map((message) => `${message.line}:${message.messageId}`);
}

describe('caxri/no-schema-version-offset', () => {
    it('reports offsets below CURRENT_SCHEMA_VERSION and nothing else', async () => {
        expect(
            await reportedLines(
                'scripts/fixtures/eslint/schema-version-offset/schema-version-offset-fixture.ts',
            ),
        ).toEqual(['6:offset', '7:offset', '8:offset']);
    });
});
