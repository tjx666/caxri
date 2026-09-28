import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
    draculaTheme,
    importTheme,
    MAX_THEME_IMPORT_FILE_BYTES,
    parseCaxriTheme,
    serializeTheme,
} from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('theme import include, zero-hit, and vsix', () => {
    it('separates the fallback surface when it matches the editor canvas', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-fallback-seam-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'light.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Fallback seam',
                type: 'light',
                colors: { 'editor.background': '#f3f3f3' },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.colors.background).toBe('#f3f3f3');
        expect(theme.colors.surface).not.toBe(theme.colors.background);
    });

    it('merges a same-directory include parent under the child theme', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-include-'));
        temporaryDirectories.push(directory);
        await writeFile(
            join(directory, 'dark_vs.json'),
            JSON.stringify({
                name: 'Dark VS',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'sideBar.background': '#252526',
                },
                tokenColors: [{ scope: 'keyword', settings: { foreground: '#569cd6' } }],
            }),
            'utf8',
        );
        const path = join(directory, 'dark_plus.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Dark+',
                include: './dark_vs.json',
                colors: {},
                tokenColors: [{ scope: 'comment', settings: { foreground: '#6a9955' } }],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.colors.background).toBe('#1e1e1e');
        expect(theme.colors.surface).toBe('#252526');
        expect(theme.editor.keyword).toBe('#569cd6');
        expect(theme.editor.comment).toBe('#6a9955');
    });

    it('rejects an include that leaves the selected file directory', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-include-escape-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'child.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Escape',
                include: '../outside.json',
                colors: {},
            }),
            'utf8',
        );

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: 'Theme include must be a file in the same directory.',
        } satisfies Partial<CaxriError>);
    });

    it('does not follow include on a Caxri-shaped theme document', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-caxri-include-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'caxri.json');
        await writeFile(
            path,
            JSON.stringify({ ...draculaTheme, include: './missing.json' }),
            'utf8',
        );

        await expect(importTheme(path, draculaTheme)).resolves.toMatchObject({
            colors: { background: draculaTheme.colors.background },
            source: 'custom',
        });
    });

    it('rejects a VS Code theme with no importable colors', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-zero-hit-'));
        temporaryDirectories.push(directory);
        const emptyColors = join(directory, 'empty-colors.json');
        await writeFile(emptyColors, JSON.stringify({ name: 'Empty colors', colors: {} }), 'utf8');
        const tokenOnly = join(directory, 'token-only.json');
        await writeFile(
            tokenOnly,
            JSON.stringify({
                name: 'Token only',
                tokenColors: [{ scope: 'comment', settings: { foreground: '#6a9955' } }],
            }),
            'utf8',
        );
        const semanticOnly = join(directory, 'semantic-only.json');
        await writeFile(
            semanticOnly,
            JSON.stringify({
                name: 'Semantic only',
                semanticTokenColors: { comment: '#6a9955' },
            }),
            'utf8',
        );

        await expect(importTheme(emptyColors, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringContaining(
                'does not define any colors Caxri can import',
            ) as string,
        } satisfies Partial<CaxriError>);
        await expect(importTheme(semanticOnly, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringContaining(
                'does not define any colors Caxri can import',
            ) as string,
        } satisfies Partial<CaxriError>);
        await expect(importTheme(tokenOnly, draculaTheme)).resolves.toMatchObject({
            editor: { comment: '#6a9955' },
        });
    });

    it('rejects a .vsix package without unpacking it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vsix-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'theme.vsix');
        await writeFile(path, 'pk\u{3}\u{4}not-a-theme', 'utf8');

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message:
                'Caxri cannot read a .vsix package yet. Unzip it and pick the theme JSON under themes/.',
        } satisfies Partial<CaxriError>);
    });

    it('rejects an oversized .vsix with the unzip hint instead of the size cap', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vsix-oversize-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'theme.vsix');
        await writeFile(path, 'x'.repeat(MAX_THEME_IMPORT_FILE_BYTES + 1), 'utf8');

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message:
                'Caxri cannot read a .vsix package yet. Unzip it and pick the theme JSON under themes/.',
        } satisfies Partial<CaxriError>);
    });

    it('omits warnings from the persisted theme document', () => {
        const serialized = serializeTheme(
            parseCaxriTheme(JSON.stringify({ ...draculaTheme, warnings: ['legacy warning'] })),
        );
        expect(JSON.parse(serialized)).not.toHaveProperty('warnings');
        expect(serialized).not.toContain('legacy warning');
    });
});
