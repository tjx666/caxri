import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CaxriError } from '../../shared/ipc/errors';
import { draculaTheme, importTheme, MAX_THEME_IMPORT_FILE_BYTES } from '../theme';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('theme import mapping', () => {
    it('maps supported VS Code tokens and preserves normalized fallbacks', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'sample.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Sample',
                colors: {
                    'editor.background': '#010203',
                    'editor.foreground': '#fefefe',
                    'terminal.ansiRed': '#aa0000',
                },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme).toMatchObject({
            source: 'vscode',
            editor: { background: '#010203', foreground: '#fefefe' },
            terminal: { red: '#aa0000' },
        });
        expect(theme.colors.accent).toBe(draculaTheme.colors.accent);
        expect(theme.warnings).not.toHaveLength(0);
    });

    it('uses the active app and editor tokens for a terminal-only Warp theme', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-warp-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'sample.yaml');
        await writeFile(
            path,
            'name: Sample Warp\nbackground: "#101010"\nterminal_colors:\n  normal:\n    green: "#00aa00"\n',
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.source).toBe('warp');
        expect(theme.terminal).toMatchObject({ background: '#101010', green: '#00aa00' });
        expect(theme.colors).toEqual(draculaTheme.colors);
        expect(theme.editor).toEqual(draculaTheme.editor);
    });

    it('rejects a theme file larger than the import size limit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-oversized-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'huge.json');
        const oversizedPayload = `{"padding":"${'a'.repeat(MAX_THEME_IMPORT_FILE_BYTES)}"}`;
        await writeFile(path, oversizedPayload, 'utf8');

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'CAPACITY',
        } satisfies Partial<CaxriError>);
    });

    it('still imports a normal, small theme file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-small-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'small.json');
        await writeFile(
            path,
            JSON.stringify({ name: 'Small', colors: { 'editor.background': '#123456' } }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.source).toBe('vscode');
        expect(theme.editor.background).toBe('#123456');
    });
});
