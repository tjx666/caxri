import { constants } from 'node:fs';
import { appendFile, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CaxriError } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { contrastRatio } from '@caxri/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme, MAX_THEME_IMPORT_FILE_BYTES } from '../theme';

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

    it('rejects a VS Code theme when mapped app surfaces make the fallback muted color miss AA', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-contrast-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'light.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Light',
                colors: {
                    'activityBar.background': '#ffffff',
                    'editor.background': '#ffffff',
                    'sideBar.background': '#ffffff',
                },
            }),
            'utf8',
        );

        await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
            code: 'VALIDATION',
            message: expect.stringContaining('editor background') as string,
        } satisfies Partial<CaxriError>);
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
        const prefix = '{"name":"At limit","padding":"';
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

    it('rejects a full Caxri theme when muted misses AA on any app surface', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-contrast-'));
        temporaryDirectories.push(directory);
        const surfaceLabels = {
            background: 'editor background',
            elevated: 'raised panel background',
            surface: 'sidebar and status bar background',
        } as const;
        await Promise.all(
            (['background', 'surface', 'elevated'] as const).map(async (surface) => {
                const path = join(directory, `${surface}.json`);
                const theme = structuredClone(draculaTheme);
                theme.colors[surface] = theme.colors.muted;
                await writeFile(path, JSON.stringify(theme), 'utf8');
                await expect(importTheme(path, draculaTheme)).rejects.toMatchObject({
                    code: 'VALIDATION',
                    message: `Secondary text in the imported theme must have at least 4.5:1 contrast against the ${surfaceLabels[surface]}. Choose a lighter or darker secondary text color and try again.`,
                } satisfies Partial<CaxriError>);
            }),
        );
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

describe('built-in theme contrast', () => {
    /**
     * `muted` is the UI's secondary-text role, not a syntax color, so it must stay readable on every chrome surface.
     * This built-in value also remains the fallback for terminal-only imports; full app-theme imports enforce the same
     * floor before activation.
     */
    it('keeps muted secondary text at WCAG AA on every chrome surface', () => {
        const { muted, background, surface, elevated } = draculaTheme.colors;
        for (const backdrop of [background, surface, elevated])
            expect(contrastRatio(muted, backdrop)).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps primary foreground text well clear of AA on every chrome surface', () => {
        const { foreground, background, surface, elevated } = draculaTheme.colors;
        for (const backdrop of [background, surface, elevated])
            expect(contrastRatio(foreground, backdrop)).toBeGreaterThanOrEqual(7);
    });

    /**
     * `styles/theme.css` hardcodes the same palette as the pre-Runtime fallback that paints the first frame before
     * `applyCssTheme` runs. Drift between the two shows up as a color flash, so the stylesheet is asserted against the
     * source of truth rather than eyeballed.
     */
    it('mirrors the built-in palette in the Renderer stylesheet fallback', async () => {
        const stylesheet = await readFile(
            new URL('../../../../desktop/src/renderer/src/styles/theme.css', import.meta.url),
            'utf8',
        );
        for (const [token, value] of Object.entries(draculaTheme.colors)) {
            if (token === 'selection') continue;
            expect(stylesheet).toContain(`--${token}: ${value};`);
        }
    });
});
