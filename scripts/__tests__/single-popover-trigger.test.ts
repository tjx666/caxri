import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/single-popover-trigger';
const fixture = 'scripts/fixtures/eslint/single-popover-trigger/single-popover-trigger-fixture.tsx';

/**
 * Linted through the real flat config so the Renderer file scope is covered too; `ignore: false` bypasses the
 * `globalIgnores` entry for `scripts/fixtures/eslint/**`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages.filter((message) => message.ruleId === ruleId);
}

describe('caxri/single-popover-trigger', () => {
    it('reports a second trigger and a per-item trigger under one Popover', async () => {
        const reported = await lint(fixture);

        expect(reported.map((message) => [message.line, message.messageId])).toEqual([
            [7, 'secondTrigger'],
            [17, 'mappedTrigger'],
        ]);
    });
});
