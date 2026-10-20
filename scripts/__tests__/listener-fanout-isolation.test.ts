import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/listener-fanout-isolation';

/**
 * `scripts/fixtures/eslint/**` is excluded from the repository's own lint gate via `globalIgnores` (see
 * `eslint.config.ts`); `ignore: false` bypasses that here so the fixtures are linted through the real flat config
 * rather than an isolated `RuleTester`, matching `scripts/__tests__/server-reads-through-query.test.ts`.
 */
async function reportedLines(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages
        .filter((message) => message.ruleId === ruleId)
        .map((message) => `${message.line}:${message.messageId}`);
}

describe('caxri/listener-fanout-isolation', () => {
    it('reports bare value and cleanup fan-outs, including optional calls', async () => {
        expect(
            await reportedLines('scripts/fixtures/eslint/listener-fanout/bare-fanout-fixture.ts'),
        ).toEqual([
            '9:fanout',
            '10:fanout',
            '13:fanout',
            '14:cleanup',
            '15:cleanup',
            '18:cleanup',
            '19:cleanup',
            '20:cleanup',
            '21:cleanup',
        ]);
    });

    it('stays silent for isolated fan-outs, single dispose calls, and multi-statement bodies', async () => {
        expect(
            await reportedLines(
                'scripts/fixtures/eslint/listener-fanout/isolated-fanout-fixture.ts',
            ),
        ).toEqual([]);
    });
});
