import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SHADOW } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme } from '../theme';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The tab, list, and title-bar state roles, plus the popup shadow. Kept apart from `theme.test.ts` because these
 * nineteen roles share one rule the rest of the import does not: each falls back to another role resolved in the same
 * import rather than to a per-brightness default, so every case here is about that chain.
 */
describe('VS Code control state colors', () => {
    it('keeps the surface fallback when only tab and title-bar fills are supplied', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-tab-surface-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Tab surface',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'tab.activeBackground': '#2d2d30',
                    'titleBar.activeBackground': '#252530',
                },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);

        expect(theme.colors.surface).toBe('#252526');
        // The fills still land — on their own roles, which is the point of adding them.
        expect(theme.colors.tabActiveBackground).toBe('#2d2d30');
        expect(theme.colors.titleBarActiveBackground).toBe('#252530');
    });

    /**
     * Rule 4 of #852's decision. A theme painting its active tab the editor color is stating a preference, so the
     * import must not read a lower-priority key, nudge the lightness, or drop to the fallback to manufacture contrast.
     */
    it('keeps an explicit tab fill that happens to equal the editor background', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-tab-same-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Flat tabs',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e', 'tab.activeBackground': '#1e1e1e' },
            }),
            'utf8',
        );

        const theme = await importTheme(path, draculaTheme);

        expect(theme.colors.tabActiveBackground).toBe('#1e1e1e');
        expect(theme.colors.background).toBe('#1e1e1e');
    });

    it('reads every tab, list, and title-bar state a theme supplies, alpha intact', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-controls-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Full controls',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'tab.activeBackground': '#111111',
                    'tab.activeForeground': '#222222',
                    'tab.inactiveBackground': '#333333',
                    'tab.inactiveForeground': '#444444',
                    'tab.hoverBackground': '#555555',
                    'tab.hoverForeground': '#666666',
                    // A translucent wash, which is what most themes use here; flattening it would band the row.
                    'list.hoverBackground': '#77777780',
                    'list.hoverForeground': '#888888',
                    'list.focusBackground': '#999999',
                    'list.focusForeground': '#aaaaaa',
                    'list.activeSelectionBackground': '#bbbbbb',
                    'list.activeSelectionForeground': '#cccccc',
                    'list.inactiveSelectionBackground': '#dddddd',
                    'list.inactiveSelectionForeground': '#eeeeee',
                    'titleBar.activeBackground': '#010101',
                    'titleBar.activeForeground': '#020202',
                    'titleBar.inactiveBackground': '#030303',
                    'titleBar.inactiveForeground': '#040404',
                    'widget.shadow': '#0000008c',
                },
            }),
            'utf8',
        );

        const { colors } = await importTheme(path, draculaTheme);

        expect(colors).toMatchObject({
            tabActiveBackground: '#111111',
            tabActiveForeground: '#222222',
            tabInactiveBackground: '#333333',
            tabInactiveForeground: '#444444',
            tabHoverBackground: '#555555',
            tabHoverForeground: '#666666',
            listHoverBackground: '#77777780',
            listHoverForeground: '#888888',
            listFocusBackground: '#999999',
            listFocusForeground: '#aaaaaa',
            listActiveSelectionBackground: '#bbbbbb',
            listActiveSelectionForeground: '#cccccc',
            listInactiveSelectionBackground: '#dddddd',
            listInactiveSelectionForeground: '#eeeeee',
            titleBarActiveBackground: '#010101',
            titleBarActiveForeground: '#020202',
            titleBarInactiveBackground: '#030303',
            titleBarInactiveForeground: '#040404',
            shadow: '#0000008c',
        });
    });

    it('walks each state role to its own fallback when the theme supplies none of them', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-no-controls-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Bare',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'sideBar.background': '#252526',
                    'editorWidget.background': '#2d2d30',
                    'foreground': '#d4d4d4',
                    'descriptionForeground': '#9d9d9d',
                },
            }),
            'utf8',
        );

        const { colors } = await importTheme(path, draculaTheme);

        expect(colors).toMatchObject({
            background: '#1e1e1e',
            elevated: '#2d2d30',
            listActiveSelectionBackground: '#2d2d30',
            listHoverBackground: '#2d2d30',
            listInactiveSelectionBackground: '#2d2d30',
            shadow: DEFAULT_SHADOW,
            // Nothing walks back the other way: the three surfaces keep the values their own keys gave them.
            surface: '#252526',
            tabActiveBackground: '#1e1e1e',
            tabHoverBackground: '#2d2d30',
            tabInactiveBackground: '#252526',
            tabInactiveForeground: '#9d9d9d',
            titleBarActiveBackground: '#252526',
            titleBarInactiveBackground: '#252526',
        });
    });

    /**
     * VS Code's own inheritance: a theme that styles only the focused state means the unfocused one to match it, not to
     * drop to a generic surface.
     */
    it('inherits the inactive list and title-bar states from the active ones', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-inactive-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Active only',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'list.activeSelectionBackground': '#bbbbbb',
                    'list.activeSelectionForeground': '#cccccc',
                    'titleBar.activeBackground': '#010101',
                    'titleBar.activeForeground': '#020202',
                },
            }),
            'utf8',
        );

        const { colors } = await importTheme(path, draculaTheme);

        expect(colors).toMatchObject({
            listInactiveSelectionBackground: '#bbbbbb',
            listInactiveSelectionForeground: '#cccccc',
            titleBarInactiveBackground: '#010101',
            titleBarInactiveForeground: '#020202',
        });
    });

    it('ignores an unusable state color instead of persisting it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-bad-state-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Broken states',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'editorWidget.background': '#2d2d30',
                    'tab.activeBackground': 'rebeccapurple',
                    'list.hoverBackground': null,
                    'titleBar.activeBackground': 42,
                    // Shorthand with alpha is legal and must expand rather than be dropped.
                    'widget.shadow': '#0008',
                },
            }),
            'utf8',
        );

        const { colors } = await importTheme(path, draculaTheme);

        expect(colors).toMatchObject({
            listHoverBackground: '#2d2d30',
            shadow: '#00000088',
            tabActiveBackground: '#1e1e1e',
        });
        expect(colors.titleBarActiveBackground).toBe(colors.surface);
    });

    /**
     * A theme setting the shadow fully transparent is turning widget shadows off. Substituting the opaque default would
     * put a shadow under every popup the author deliberately left flat.
     */
    it('honors a fully transparent widget shadow rather than replacing it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-no-shadow-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Flat',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e', 'widget.shadow': '#ffffff00' },
            }),
            'utf8',
        );

        expect((await importTheme(path, draculaTheme)).colors.shadow).toBe('#ffffff00');
    });

    it('keeps the elevated fallback when only list fills are supplied', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-list-elevated-'));
        temporaryDirectories.push(directory);
        const hover = join(directory, 'hover.json');
        await writeFile(
            hover,
            JSON.stringify({
                name: 'List hover',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'list.hoverBackground': '#2a2d2e',
                    'list.activeSelectionBackground': '#2c2c32',
                },
            }),
            'utf8',
        );
        expect((await importTheme(hover, draculaTheme)).colors.elevated).toBe('#252526');

        const selection = join(directory, 'selection.json');
        await writeFile(
            selection,
            JSON.stringify({
                name: 'List selection',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'list.activeSelectionBackground': '#2c2c32',
                },
            }),
            'utf8',
        );
        expect((await importTheme(selection, draculaTheme)).colors.elevated).toBe('#252526');
    });
});
