import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { approvedNativeTitles } from '../eslint-rules/native-title-inventory';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/native-title';

/**
 * Linted through the real flat config so the file-scoped wiring is covered too; `ignore: false` bypasses the
 * `globalIgnores` entry for `scripts/fixtures/eslint/**`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages.filter((message) => message.ruleId === ruleId);
}

describe('caxri/native-title', () => {
    /**
     * A native `title` raised by JSX on a host element, an `element.title` assignment, `setAttribute('title')`, and a
     * generated HTML string are the four ways unique text becomes a mouse-only tooltip.
     */
    it('reports every native title shape outside the approved inventory', async () => {
        const reported = await lint(
            'scripts/fixtures/eslint/native-title/native-title-fixture.jsx',
        );

        expect(reported.map((message) => message.line)).toEqual([9, 13, 17, 21]);
    });

    it('stays silent for document.title and a component prop named title', async () => {
        const reported = await lint(
            'scripts/fixtures/eslint/native-title/native-title-fixture.jsx',
        );

        expect(reported.some((message) => message.line >= 24)).toBe(false);
    });

    it('keeps every inventory entry pointing at an existing file', () => {
        for (const path of Object.keys(approvedNativeTitles)) {
            expect(existsSync(resolve(root, path)), path).toBe(true);
        }
    });
});
