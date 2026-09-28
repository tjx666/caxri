import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('VS Code syntax import', () => {
    it('imports string-scoped syntax colors and terminal selection opacity', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-syntax-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'syntax.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Syntax',
                type: 'light',
                colors: {
                    'editor.background': '#ffffff',
                    'terminal.selectionBackground': '#12345678',
                },
                tokenColors: [
                    { scope: 'comment', settings: { foreground: '#111111' } },
                    { scope: 'keyword', settings: { foreground: '#222222' } },
                    { scope: 'string', settings: { foreground: '#333333' } },
                    { scope: 'constant.numeric', settings: { foreground: '#444444' } },
                ],
                semanticTokenColors: { variable: '#abcdef' },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor).toMatchObject({
            comment: '#111111',
            keyword: '#222222',
            string: '#333333',
            number: '#444444',
        });
        expect(theme.terminal.selectionBackground).toBe('#12345678');
        expect(theme.warnings).toContainEqual({
            id: 'semantic-token-colors',
            message: 'Semantic token colors were not imported.',
        });
    });

    it('imports syntax colors from array and comma-separated scopes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-scope-array-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'array.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Array',
                tokenColors: [
                    {
                        scope: ['entity.name, keyword', 'string'],
                        settings: { foreground: '#abcdef' },
                    },
                    { scope: ['constant.numeric'], settings: { foreground: '#fedcba' } },
                ],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor).toMatchObject({
            keyword: '#abcdef',
            string: '#abcdef',
            number: '#fedcba',
            comment: draculaTheme.editor.comment,
        });
        expect(theme.warnings).toContainEqual({
            id: 'missing-syntax-colors',
            message: 'Syntax colors for comments were not imported.',
        });
        expect(theme.warnings).toContainEqual({
            id: 'other-syntax-colors',
            message: 'Other syntax token colors were not imported.',
        });
    });

    it('reports unmapped syntax without treating it as an effective color hit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-no-scope-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'no-scope.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'No Scope',
                colors: { 'editor.background': '#1e1e1e' },
                tokenColors: [{ settings: { foreground: '#123456' } }],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor).toMatchObject({
            comment: draculaTheme.editor.comment,
            keyword: draculaTheme.editor.keyword,
            string: draculaTheme.editor.string,
            number: draculaTheme.editor.number,
        });
        expect(theme.warnings).toContainEqual({
            id: 'missing-syntax-colors',
            message: 'Syntax colors were not imported.',
        });
        expect(theme.warnings).toContainEqual({
            id: 'other-syntax-colors',
            message: 'Other syntax token colors were not imported.',
        });
    });

    it('reports missing syntax colors when workbench colors still import', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-no-tokens-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'no-tokens.json');
        await writeFile(
            path,
            JSON.stringify({ name: 'No Tokens', colors: { 'editor.background': '#1e1e1e' } }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.source).toBe('vscode');
        expect(theme.editor.comment).toBe(draculaTheme.editor.comment);
        expect(theme.warnings).toContainEqual({
            id: 'missing-syntax-colors',
            message: 'Syntax colors were not imported.',
        });
    });
});
