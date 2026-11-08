import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/no-raw-error-text-in-logs';

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

describe('caxri/no-raw-error-text-in-logs', () => {
    it('reports raw error and stderr text in log fields and nothing else', async () => {
        expect(
            await reportedLines(
                'scripts/fixtures/eslint/no-raw-error-text-in-logs/no-raw-error-text-in-logs-fixture.ts',
            ),
        ).toEqual([
            '8:rawText',
            '9:rawText',
            '11:rawText',
            '13:rawText',
            '14:rawText',
            '15:rawText',
            '22:rawText',
            '24:rawText',
            '27:rawText',
        ]);
    });
});
