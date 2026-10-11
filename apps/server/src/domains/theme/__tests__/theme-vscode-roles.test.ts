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

/**
 * Which VS Code workbench key each status and data color role reads, and what it falls back to when a theme leaves the
 * key unset.
 */
describe('VS Code theme color role mapping', () => {
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

    it('maps the VS Code chart green onto the chart role and otherwise follows the imported success', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-chart-'));
        temporaryDirectories.push(directory);
        const withChart = join(directory, 'chart.json');
        await writeFile(
            withChart,
            JSON.stringify({
                name: 'Chart',
                colors: { 'charts.green': '#2EA043', 'testing.iconPassed': '#FF0000' },
            }),
            'utf8',
        );
        const charted = (await importTheme(withChart, draculaTheme)).colors;
        expect(charted.chart).toBe('#2ea043');
        expect(charted.success).toBe('#ff0000');

        const without = join(directory, 'plain.json');
        await writeFile(
            without,
            JSON.stringify({ name: 'Plain', colors: { 'testing.iconPassed': '#FF0000' } }),
            'utf8',
        );
        expect((await importTheme(without, draculaTheme)).colors.chart).toBe('#ff0000');
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
});
