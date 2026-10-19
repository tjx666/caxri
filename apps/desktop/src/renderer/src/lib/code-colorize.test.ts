import { describe, expect, it, vi } from 'vitest';

import { codeLanguageName, colorizeCode } from './code-colorize';

const colorize = vi.fn<(code: string, languageId: string) => Promise<string>>((code) =>
    Promise.resolve(`<div><span class="mtk1">${code}</span></div>`),
);

vi.mock('./monaco', () => ({
    monaco: {
        editor: { colorize: (code: string, languageId: string) => colorize(code, languageId) },
        languages: {
            getLanguages: () => [
                { id: 'json', aliases: ['JSON', 'json'], extensions: ['.json'] },
                { id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts'] },
            ],
        },
    },
}));

vi.mock('./editor-theme', () => ({
    appliedEditorThemeKey: () => 'dark',
    applyEditorTheme: vi.fn(),
}));

describe('code fence colorizing', () => {
    it.each(['jsonc', 'JSON5'])('paints a %s fence with the JSON tokenizer', async (fence) => {
        const code = `{ /* ${fence} */ "a": 1 }`;
        await expect(colorizeCode(code, fence, undefined)).resolves.toContain('mtk1');
        expect(colorize).toHaveBeenLastCalledWith(code, 'json');
    });

    it('labels a JSON dialect by its own name, not as plain JSON', async () => {
        await expect(codeLanguageName('jsonc')).resolves.toBe('JSONC');
        await expect(codeLanguageName('json')).resolves.toBe('JSON');
    });

    it('leaves an unknown fence and an inherited object key uncolored', async () => {
        await expect(colorizeCode('x', 'constructor', undefined)).resolves.toBeUndefined();
        await expect(codeLanguageName('constructor')).resolves.toBeUndefined();
    });
});
