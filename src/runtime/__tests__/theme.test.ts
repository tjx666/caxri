import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/** WCAG 2.1 relative luminance of an `#rrggbb` color. */
function relativeLuminance(hex: string): number {
    const channels = [1, 3, 5].map((offset) => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
    const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
        (a, b) => b - a,
    );
    return (lighter + 0.05) / (darker + 0.05);
}

describe('built-in theme contrast', () => {
    /**
     * `muted` is the UI's secondary-text role, not a syntax color, so it must stay readable on every
     * chrome surface. Imported themes clone this palette and never override `muted`, which makes
     * this single constant the contrast floor for all 133 `text-muted` call sites in the Renderer.
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
     * `styles/theme.css` hardcodes the same palette as the pre-Runtime fallback that paints the
     * first frame before `applyCssTheme` runs. Drift between the two shows up as a color flash, so
     * the stylesheet is asserted against the source of truth rather than eyeballed.
     */
    it('mirrors the built-in palette in the Renderer stylesheet fallback', async () => {
        const stylesheet = await readFile(
            new URL('../../renderer/src/styles/theme.css', import.meta.url),
            'utf8',
        );
        for (const [token, value] of Object.entries(draculaTheme.colors)) {
            if (token === 'selection') continue;
            expect(stylesheet).toContain(`--${token}: ${value};`);
        }
    });
});
