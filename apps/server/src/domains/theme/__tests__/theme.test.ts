import { constants } from 'node:fs';
import { appendFile, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { builtinThemes, solarizedLightTheme, themeColorCssVariable } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { contrastRatio } from '@caxri/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme, MAX_THEME_IMPORT_FILE_BYTES } from '..';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function completeWithin<T>(promise: Promise<T>, timeoutMs = 750): Promise<T> {
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
            () => reject(new Error(`Theme import did not settle within ${timeoutMs}ms`)),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeout!);
    }
}

async function unblockFifoReader(path: string): Promise<void> {
    try {
        const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
    } catch {
        // The nonblocking reader has already rejected and closed the FIFO.
    }
}

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

    it('maps the VS Code chart purple onto the merged role and keeps the seeded fallback without it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-merged-'));
        temporaryDirectories.push(directory);
        const withPurple = join(directory, 'purple.json');
        await writeFile(
            withPurple,
            JSON.stringify({ name: 'Purple', colors: { 'charts.purple': '#8250DF' } }),
            'utf8',
        );
        expect((await importTheme(withPurple, draculaTheme)).colors.merged).toBe('#8250df');

        const without = join(directory, 'plain.json');
        await writeFile(
            without,
            JSON.stringify({
                name: 'Plain',
                colors: { 'editor.background': '#1e1e1e' },
            }),
            'utf8',
        );
        expect((await importTheme(without, draculaTheme)).colors.merged).toBe(
            draculaTheme.colors.merged,
        );
    });

    /**
     * Regression: a Caxri theme exported before a color role existed must still import as that theme. Validating it
     * before the backfill would make it fail the Caxri shape and fall through to the VS Code mapping, silently
     * importing a mangled theme instead of the user's own.
     */
    it('still recognizes a Caxri theme exported before the merged role existed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-legacy-export-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'exported.json');
        const exported = structuredClone(solarizedLightTheme) as {
            colors: Record<string, string>;
        };
        delete exported.colors.merged;
        await writeFile(path, JSON.stringify(exported), 'utf8');

        const theme = await importTheme(path, draculaTheme);
        expect(theme.source).toBe('custom');
        expect(theme.colors.merged).toBe(solarizedLightTheme.colors.merged);
        expect(theme.colors.background).toBe(solarizedLightTheme.colors.background);
    });

    it('rejects a VS Code theme whose own secondary text misses AA on a mapped surface', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-contrast-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'light.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Light',
                type: 'light',
                colors: {
                    'editor.background': '#ffffff',
                    'sideBar.background': '#ffffff',
                    'editorWidget.background': '#ffffff',
                    'descriptionForeground': '#c8c8c8',
                },
            }),
            'utf8',
        );

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringContaining('editor background') as string,
        } satisfies Partial<CaxriError>);
    });

    /**
     * Regression: `background` and `surface` were swapped, so an import painted the editor in the theme's sidebar color
     * and the sidebar in its activity-bar color. A plain light theme also inherited Dracula's dark `elevated`, `muted`,
     * and `selection`, which then failed the AA gate and rejected the file outright.
     */
    it('maps a VS Code theme onto the matching Caxri surfaces instead of mixing in the active palette', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-surfaces-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'light.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Light',
                type: 'light',
                colors: {
                    'editor.background': '#ffffff',
                    'sideBar.background': '#f0f0f0',
                    'activityBar.background': '#dddddd',
                },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.colors.background).toBe('#ffffff');
        expect(theme.colors.surface).toBe('#f0f0f0');
        for (const role of ['elevated', 'muted', 'selection'] as const)
            expect(theme.colors[role], role).not.toBe(draculaTheme.colors[role]);
    });

    it('keeps a chrome seam when a VS Code theme only sets the editor canvas', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-editor-only-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Editor only',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.colors.background).toBe('#1e1e1e');
        expect(theme.colors.surface).toBe('#252526');
        expect(theme.colors.surface).not.toBe(theme.colors.background);
    });

    it('preserves a VS Code theme that explicitly paints surface and background the same color', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-same-surface-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Same surface',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'sideBar.background': '#1e1e1e',
                },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.colors.background).toBe('#1e1e1e');
        expect(theme.colors.surface).toBe('#1e1e1e');
    });

    it('maps string-scoped tokenColors and terminal.selectionBackground', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-token-string-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'light.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Syntax string scopes',
                type: 'light',
                colors: {
                    'editor.background': '#fdf6e3',
                    'terminal.selectionBackground': '#eee8d5',
                },
                tokenColors: [
                    { scope: 'comment', settings: { foreground: '#93a1a1' } },
                    { scope: 'keyword', settings: { foreground: '#859900' } },
                    { scope: 'string', settings: { foreground: '#2aa198' } },
                    { scope: 'constant.numeric', settings: { foreground: '#d33682' } },
                ],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor).toMatchObject({
            comment: '#93a1a1',
            keyword: '#859900',
            string: '#2aa198',
            number: '#d33682',
        });
        expect(theme.terminal.selectionBackground).toBe('#eee8d5');
        expect(
            theme.warnings.filter((warning) => warning.message.startsWith('Syntax colors')),
        ).toEqual([]);
        expect(theme.editor.comment).not.toBe(draculaTheme.editor.comment);
    });

    it('preserves 8-digit and shorthand alpha on terminal.selectionBackground', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-selection-alpha-'));
        temporaryDirectories.push(directory);
        const write = async (name: string, colors: Record<string, string>) => {
            const path = join(directory, name);
            await writeFile(path, JSON.stringify({ name, colors }), 'utf8');
            return importTheme(path, draculaTheme);
        };
        const dark = await write('dark.json', {
            'editor.background': '#1e1e1e',
            'editor.selectionBackground': '#3994BC33',
            'terminal.selectionBackground': '#3994BC33',
        });
        expect(dark.terminal.selectionBackground).toBe('#3994bc33');
        expect(dark.editor.selection).toBe('#3994bc');
        expect(
            (await write('light.json', { 'terminal.selectionBackground': '#06c2' })).terminal
                .selectionBackground,
        ).toBe('#0066cc22');
    });

    it('maps array-scoped tokenColors onto the matching editor syntax role', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-token-array-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Syntax array scopes',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
                tokenColors: [
                    {
                        scope: ['keyword', 'storage.type'],
                        settings: { foreground: '#569cd6' },
                    },
                ],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor.keyword).toBe('#569cd6');
        expect(theme.editor.comment).toBe(draculaTheme.editor.comment);
        expect(theme.warnings).toContainEqual({
            id: 'missing-syntax-colors',
            message: 'Syntax colors for comments, strings, numbers were not imported.',
        });
    });

    it('does not let a descendant scope overwrite an exact syntax role', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-token-descendant-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Descendant scopes',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
                tokenColors: [
                    { scope: 'keyword', settings: { foreground: '#569cd6' } },
                    { scope: 'keyword.operator', settings: { foreground: '#d4d4d4' } },
                    {
                        scope: 'comment, punctuation.definition.comment',
                        settings: { foreground: '#6a9955' },
                    },
                ],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor.keyword).toBe('#569cd6');
        expect(theme.editor.comment).toBe('#6a9955');
    });

    it('skips a tokenColors entry with no scope and still maps later rules', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-token-missing-scope-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Missing scope',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
                tokenColors: [
                    { settings: { foreground: '#ff0000' } },
                    { scope: 'comment', settings: { foreground: '#6a9955' } },
                ],
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor.comment).toBe('#6a9955');
        expect(theme.editor.keyword).toBe(draculaTheme.editor.keyword);
    });

    it('imports a VS Code theme without tokenColors and warns that syntax colors were skipped', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-no-token-colors-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'No tokenColors',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.editor.comment).toBe(draculaTheme.editor.comment);
        expect(theme.warnings).toContainEqual({
            id: 'missing-syntax-colors',
            message: 'Syntax colors were not imported.',
        });
        expect(
            theme.warnings.some((warning) =>
                warning.message.includes('Unsupported VS Code tokens'),
            ),
        ).toBe(false);
    });

    it('warns that semantic token colors were not imported', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-semantic-tokens-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Semantic tokens',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
                semanticTokenColors: { comment: '#6a9955' },
            }),
            'utf8',
        );

        expect((await importTheme(path, draculaTheme)).warnings).toContainEqual({
            id: 'semantic-token-colors',
            message: 'Semantic token colors were not imported.',
        });
    });

    /**
     * `testing.iconPassed` is the workbench's own passed-state green, which a theme tunes for a success glyph;
     * `charts.green` is a data-series color several themes leave at a saturated default. Preferring the semantic key
     * was decided in #852 and is the reason this reads the theme's value rather than the built-in dark default.
     */
    it('prefers the semantic passed-state green over the chart palette', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-success-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Passed green',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'testing.iconPassed': '#73c991',
                    'charts.green': '#00ff00',
                },
            }),
            'utf8',
        );

        expect((await importTheme(path, draculaTheme)).colors.success).toBe('#73c991');
    });

    it('falls back to the chart palette when the passed-state green is absent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-chart-green-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Chart green',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e', 'charts.green': '#00ff00' },
            }),
            'utf8',
        );

        expect((await importTheme(path, draculaTheme)).colors.success).toBe('#00ff00');
    });

    it('prefers the pull-request merged color over the chart palette', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-merged-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Merged',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'pullRequests.merged': '#8957e5',
                    'charts.purple': '#ff00ff',
                },
            }),
            'utf8',
        );

        const imported = await importTheme(path, draculaTheme);

        expect(imported.colors.merged).toBe('#8957e5');
    });

    it('reads badge and Git decoration colors from their VS Code keys', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-decorations-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Dark',
                type: 'dark',
                colors: {
                    'editor.background': '#101010',
                    'activityBarBadge.background': '#ff79c6',
                    'gitDecoration.modifiedResourceForeground': '#8be9fd',
                    // Shorthand hex is legal in a VS Code theme and must not be dropped.
                    'gitDecoration.deletedResourceForeground': '#f55',
                },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);
        expect(theme.colors.badge).toBe('#ff79c6');
        expect(theme.colors.gitModified).toBe('#8be9fd');
        expect(theme.colors.gitDeleted).toBe('#ff5555');
        // Unset decorations fall back to what VS Code's built-in Git extension would paint, not to the active theme.
        expect(theme.colors.gitUntracked).toBe('#73c991');
    });

    it('takes the accent from the theme active-tab edge rather than its focus border', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-accent-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Dark',
                type: 'dark',
                colors: {
                    'editor.background': '#101010',
                    // Dracula's real values: a near-invisible focus border beside a saturated active edge.
                    'focusBorder': '#6272a4',
                    'tab.activeBorderTop': '#ff79c6cc',
                },
            }),
            'utf8',
        );

        expect((await importTheme(path, draculaTheme)).colors.accent).toBe('#ff79c6');
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

    it('rejects an oversized theme file through a symlink before parsing', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-oversized-'));
        temporaryDirectories.push(directory);
        const target = join(directory, 'huge.json');
        const path = join(directory, 'linked-huge.json');
        const oversizedPayload = `{"padding":"${'a'.repeat(MAX_THEME_IMPORT_FILE_BYTES)}"}`;
        await writeFile(target, oversizedPayload, 'utf8');
        await symlink(target, path);

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'CAPACITY',
        } satisfies Partial<CaxriError>);
    });

    it('imports a normal theme file through a symlink', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-symlink-'));
        temporaryDirectories.push(directory);
        const target = join(directory, 'managed-theme.json');
        const path = join(directory, 'theme.json');
        await writeFile(
            target,
            JSON.stringify({ name: 'Linked Theme', colors: { 'editor.background': '#101112' } }),
            'utf8',
        );
        await symlink(target, path);

        await expect(importTheme(path, draculaTheme)).resolves.toMatchObject({
            editor: { background: '#101112' },
            source: 'vscode',
        });
    });

    it('accepts a theme file exactly at the import size limit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-at-limit-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'at-limit.json');
        const prefix = '{"name":"At limit","colors":{"editor.background":"#123456"},"padding":"';
        const suffix = '"}';
        await writeFile(
            path,
            `${prefix}${'a'.repeat(MAX_THEME_IMPORT_FILE_BYTES - prefix.length - suffix.length)}${suffix}`,
            'utf8',
        );

        await expect(importTheme(path, draculaTheme)).resolves.toMatchObject({
            source: 'vscode',
        });
    });

    it('bounds an opened theme file when it grows before parsing', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-growth-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'theme.json');
        await writeFile(path, '{"name":"Before growth"}', 'utf8');

        await expect(
            importTheme(path, draculaTheme, {
                beforeRead: async () => {
                    await appendFile(path, 'x'.repeat(MAX_THEME_IMPORT_FILE_BYTES), 'utf8');
                },
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' } satisfies Partial<CaxriError>);
    });

    it('rejects a non-regular theme import source', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-directory-'));
        temporaryDirectories.push(directory);

        await expect(importTheme(directory, draculaTheme)).rejects.toMatchObject({
            code: 'IO',
        } satisfies Partial<CaxriError>);
    });

    it('quickly rejects a FIFO without waiting for a writer', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-fifo-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'theme.fifo');
        await execFileAsync('mkfifo', [path]);

        const attempt = importTheme(path, draculaTheme);
        try {
            await expect(completeWithin(attempt)).rejects.toMatchObject({
                code: 'IO',
            } satisfies Partial<CaxriError>);
        } finally {
            await unblockFifoReader(path);
        }
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

    it('accepts a full Caxri theme whose muted color clears the AA boundary', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-contrast-valid-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'valid.json');
        const theme = structuredClone(draculaTheme);
        theme.colors = {
            ...theme.colors,
            background: '#ffffff',
            surface: '#ffffff',
            elevated: '#ffffff',
            muted: '#767676',
        };
        await writeFile(path, JSON.stringify(theme), 'utf8');

        await expect(importTheme(path, draculaTheme)).resolves.toMatchObject({
            colors: { muted: '#767676' },
            source: 'custom',
        });

        const belowBoundaryPath = join(directory, 'below-boundary.json');
        theme.colors.muted = '#777777';
        await writeFile(belowBoundaryPath, JSON.stringify(theme), 'utf8');
        await expect(importTheme(belowBoundaryPath, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringContaining('editor background') as string,
        } satisfies Partial<CaxriError>);

        const opaqueAlphaPath = join(directory, 'opaque-alpha.json');
        theme.colors.muted = '#767676FF';
        theme.colors.background = '#ffffffFF';
        await writeFile(opaqueAlphaPath, JSON.stringify(theme), 'utf8');
        await expect(importTheme(opaqueAlphaPath, draculaTheme)).resolves.toMatchObject({
            colors: { background: '#ffffffFF', muted: '#767676FF' },
        });
    });

    it('rejects translucent app text whose opaque RGB would appear to pass', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-contrast-alpha-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'translucent.json');
        const theme = structuredClone(draculaTheme);
        theme.colors = {
            ...theme.colors,
            background: '#000000',
            surface: '#000000',
            elevated: '#000000',
            muted: '#ffffff80',
        };
        await writeFile(path, JSON.stringify(theme), 'utf8');

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringContaining('editor background') as string,
        } satisfies Partial<CaxriError>);
    });
});

/**
 * Shortest angular distance between two hex colors on the HSL hue wheel, in degrees. Local to this file because hue is
 * only ever asserted here; every other color rule in the app is a contrast ratio.
 */
function hueDistance(left: string, right: string): number {
    const hue = (hex: string): number => {
        const [red, green, blue] = [1, 3, 5].map((index) =>
            Number.parseInt(hex.slice(index, index + 2), 16),
        );
        const max = Math.max(red, green, blue);
        const chroma = max - Math.min(red, green, blue);
        if (chroma === 0) return 0;
        const sector =
            max === red
                ? ((green - blue) / chroma) % 6
                : max === green
                  ? (blue - red) / chroma + 2
                  : (red - green) / chroma + 4;
        return (sector * 60 + 360) % 360;
    };
    const delta = Math.abs(hue(left) - hue(right));
    return Math.min(delta, 360 - delta);
}

describe('built-in theme contrast', () => {
    /**
     * `muted` is the UI's secondary-text role, not a syntax color, so it must stay readable on every chrome surface.
     * This built-in value also remains the fallback for terminal-only imports; full app-theme imports enforce the same
     * floor before activation.
     */
    it('keeps muted secondary text at WCAG AA on every chrome surface', () => {
        for (const theme of builtinThemes) {
            const { muted, background, surface, elevated } = theme.colors;
            for (const backdrop of [background, surface, elevated])
                expect(contrastRatio(muted, backdrop), theme.id).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('keeps primary foreground text at WCAG AA on every chrome surface', () => {
        for (const theme of builtinThemes) {
            const { foreground, background, surface, elevated } = theme.colors;
            for (const backdrop of [background, surface, elevated])
                expect(contrastRatio(foreground, backdrop), theme.id).toBeGreaterThanOrEqual(4.5);
        }
    });

    /**
     * `merged` paints a 13px glyph rather than text, so WCAG's 3:1 non-text floor applies. Its whole reason for
     * existing is that a merged pull request must not read as `success` (an open PR whose checks passed), and hue is
     * what carries that at glyph size — a violet that drifted green in one theme would silently restore the original
     * bug while still passing a contrast check.
     */
    it('keeps the merged glyph readable and hue-separated from success on every theme', () => {
        for (const theme of builtinThemes) {
            const { merged, success, background, surface, elevated } = theme.colors;
            for (const backdrop of [background, surface, elevated])
                expect(contrastRatio(merged, backdrop), theme.id).toBeGreaterThanOrEqual(3);
            expect(hueDistance(merged, success), theme.id).toBeGreaterThanOrEqual(60);
        }
    });

    /**
     * `styles/theme.css` hardcodes the same palette as the pre-Server fallback that paints the first frame before
     * `applyCssTheme` runs. Drift between the two shows up as a color flash, so the stylesheet is asserted against the
     * source of truth rather than eyeballed.
     */
    it('mirrors the built-in palette in the Renderer stylesheet fallback', async () => {
        const stylesheet = await readFile(
            new URL('../../../../../desktop/src/renderer/src/styles/theme.css', import.meta.url),
            'utf8',
        );
        for (const [token, value] of Object.entries(draculaTheme.colors)) {
            if (token === 'selection') continue;
            expect(stylesheet).toContain(`${themeColorCssVariable(token)}: ${value};`);
        }
    });
});
