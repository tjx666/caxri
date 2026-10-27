import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const ruleId = 'caxri/jsdoc-format';
const filePath = resolve(root, 'scripts/fixtures/eslint/jsdoc-format.ts');

/**
 * Lints through the real flat config so the rule runs with the repository's parser and `cwd`, but with every other rule
 * filtered out so a fix from another rule cannot leak into the asserted output.
 */
async function fix(source: string): Promise<string> {
    const eslint = new ESLint({
        cwd: root,
        fix: true,
        ignore: false,
        ruleFilter: (rule) => rule.ruleId === ruleId,
    });
    const [result] = await eslint.lintText(source, { filePath });
    return result.output ?? source;
}

async function messageIds(source: string): Promise<string[]> {
    const eslint = new ESLint({
        cwd: root,
        ignore: false,
        ruleFilter: (rule) => rule.ruleId === ruleId,
    });
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages.map((message) => message.messageId ?? '');
}

describe('caxri/jsdoc-format', () => {
    it('leaves an already formatted comment alone', async () => {
        const source = [
            '/**',
            ' * Already formatted.',
            ' *',
            ' * @param value The value.',
            ' */',
            'export function f(value: string): void {}',
            '',
        ].join('\n');

        expect(await messageIds(source)).toEqual([]);
    });

    it('capitalizes the description and collapses its whitespace', async () => {
        expect(
            await fix(
                '/**\n * loads   the   config\n *   from disk.\n */\nexport function load(): void {}\n',
            ),
        ).toBe('/**\n * Loads the config from disk.\n */\nexport function load(): void {}\n');
    });

    it('wraps at 120 columns including the comment indentation', async () => {
        const words = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');

        expect(
            await fix(`class A {\n    /**\n     * ${words}\n     */\n    m(): void {}\n}\n`),
        ).toBe(
            [
                'class A {',
                '    /**',
                '     * Word0 word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16',
                '     * word17 word18 word19 word20 word21 word22 word23 word24 word25 word26 word27 word28 word29',
                '     */',
                '    m(): void {}',
                '}',
                '',
            ].join('\n'),
        );
    });

    it('renames tag synonyms, orders tags, and separates them from the description', async () => {
        expect(
            await fix(
                [
                    '/**',
                    ' * Adds.',
                    ' * @return the sum',
                    ' * @param a first',
                    ' */',
                    'export function add(a: number): number { return a; }',
                    '',
                ].join('\n'),
            ),
        ).toBe(
            [
                '/**',
                ' * Adds.',
                ' *',
                ' * @param a First',
                ' * @returns The sum',
                ' */',
                'export function add(a: number): number { return a; }',
                '',
            ].join('\n'),
        );
    });

    it('wraps a long tag description with a two-space hanging indent', async () => {
        const description = Array.from({ length: 24 }, (_, index) => `part${index}`).join(' ');

        expect(
            await fix(
                `/**\n * @param value ${description}\n */\nexport function f(value: string): void {}\n`,
            ),
        ).toBe(
            [
                '/**',
                ' * @param value Part0 part1 part2 part3 part4 part5 part6 part7 part8 part9 part10 part11 part12 part13 part14 part15',
                ' *   part16 part17 part18 part19 part20 part21 part22 part23',
                ' */',
                'export function f(value: string): void {}',
                '',
            ].join('\n'),
        );
    });

    it('keeps Markdown lists and capitalizes each item', async () => {
        expect(
            await fix(
                '/**\n * Steps:\n *\n * - first step\n * - second step\n */\nexport const s = 1;\n',
            ),
        ).toBe('/**\n * Steps:\n *\n * - First step\n * - Second step\n */\nexport const s = 1;\n');
    });

    it('formats fenced example code with the repository formatter', async () => {
        expect(
            await fix(
                [
                    '/**',
                    ' * Demo.',
                    ' *',
                    ' * @example',
                    ' * ```ts',
                    ' * const  x={a:1}',
                    ' * ```',
                    ' */',
                    'export const d = 1;',
                    '',
                ].join('\n'),
            ),
        ).toMatchInlineSnapshot(`
          "/**
           * Demo.
           *
           * @example
           *
           * \`\`\`ts
           * const x = { a: 1 };
           * \`\`\`
           */
          export const d = 1;
          "
        `);
    });

    it('keeps a short single-line comment on one line and expands one that is too long', async () => {
        const long = 'long '.repeat(30);

        expect(
            await fix(
                `/** keeps a single line. */\nexport const a = 1;\n/** ${long}*/\nexport const b = 1;\n`,
            ),
        ).toBe(
            [
                '/** Keeps a single line. */',
                'export const a = 1;',
                '/**',
                ' * Long long long long long long long long long long long long long long long long long long long long long long long',
                ' * long long long long long long long',
                ' */',
                'export const b = 1;',
                '',
            ].join('\n'),
        );
    });

    it('removes an empty JSDoc comment together with its line', async () => {
        expect(await messageIds('const x = 1;\n/** */\nexport const y = x;\n')).toEqual(['empty']);
        expect(await fix('const x = 1;\n/** */\nexport const y = x;\n')).toBe(
            'const x = 1;\nexport const y = x;\n',
        );
    });

    it('keeps the formatter indentation of a comment that follows code on its line', async () => {
        const source = [
            'export const handler = enabled',
            '    ? 1',
            '    : /**',
            '       * Falls back to the default handler.',
            '       */',
            '      2;',
            '',
        ].join('\n');

        expect(await messageIds(source)).toEqual([]);
    });

    it('ignores ordinary block comments', async () => {
        expect(await messageIds('/* not   jsdoc */\nexport const a = 1;\n')).toEqual([]);
    });
});
