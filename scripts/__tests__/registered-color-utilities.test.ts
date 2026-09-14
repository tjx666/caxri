import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/registered-color-utilities';

/**
 * Linted through the real flat config rather than a `RuleTester` so the rule's `theme.css` lookup runs against the
 * repository's actual bridge; `ignore: false` bypasses the `globalIgnores` entry for `scripts/fixtures/eslint/**`.
 */
async function lint(path: string) {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([path]);
    return result.messages.filter((message) => message.ruleId === ruleId);
}

const fixture = 'scripts/fixtures/eslint/color-utilities/unregistered-color-fixture.ts';

describe('caxri/registered-color-utilities', () => {
    /**
     * The three shapes that reach the DOM and style nothing: a bare palette name, a shaded one, and a raw theme color
     * used as if it were a semantic role. The variant chain (`hover:`) and the opacity modifier (`/60`) must not hide
     * any of them.
     */
    it('reports every color utility whose token is not registered', async () => {
        const reported = await lint(fixture);

        expect(
            reported.map((message) => message.messageId).toSorted((a, b) => a!.localeCompare(b!)),
        ).toEqual([
            'rawThemeColor',
            'unregisteredPalette',
            'unregisteredPalette',
            'unregisteredPalette',
        ]);
    });

    it('names the arbitrary-value form a raw theme color must use instead', async () => {
        const reported = await lint(fixture);

        expect(
            reported.find((message) => message.messageId === 'rawThemeColor')?.message,
        ).toContain('[var(--selection)]');
    });

    /**
     * `border-border`, `bg-elevated`, and `text-git-added` are bridge roles; `bg-[var(--selection)]` is the sanctioned
     * raw-color form and `text-[12px]` is not a color at all. A rule that rejected whatever it failed to recognize
     * would report all five.
     */
    it('stays silent for a semantic role and for the arbitrary-value escape hatch', async () => {
        const reported = await lint(fixture);

        expect(
            reported
                .map((message) => /`([^`]+)`/.exec(message.message)?.[1])
                .toSorted((a, b) => a!.localeCompare(b!)),
        ).toEqual(['bg-white', 'hover:bg-selection', 'text-black/60', 'text-blue-500']);
    });
});
