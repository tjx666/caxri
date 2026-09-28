import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThemeTokens } from '@caxri/protocol';
import { builtinThemes, DEFAULT_SHADOW } from '@caxri/protocol';
import { contrastRatio } from '@caxri/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { draculaTheme, importTheme } from '..';

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
            /**
             * The list state fills walk to VS Code's own registry defaults rather than to `elevated`, which is what a
             * theme declaring them in the TypeScript color registry actually renders. Collapsing all four onto
             * `elevated` is what made hover, keyboard focus, and selection identical. See issue #1006.
             */
            listActiveSelectionBackground: '#04395e',
            listActiveSelectionForeground: '#ffffff',
            listFocusBackground: '#04395e59',
            listHoverBackground: '#2a2d2e',
            listInactiveSelectionBackground: '#37373d',
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

    /**
     * The light half of the same fallback. An imported light theme that leaves its list states to the registry must not
     * be handed the dark fills, and the brightness is read from the resolved canvas rather than the declared `type`.
     */
    it('walks a light theme to the light registry defaults for its list states', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-light-list-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'light.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Bare light',
                type: 'light',
                colors: {
                    'editor.background': '#ffffff',
                    'editor.foreground': '#1f1f1f',
                    'foreground': '#3b3b3b',
                },
            }),
            'utf8',
        );

        const { colors } = await importTheme(path, draculaTheme);

        expect(colors).toMatchObject({
            listActiveSelectionBackground: '#0060c0',
            listActiveSelectionForeground: '#ffffff',
            listFocusBackground: '#0060c059',
            listHoverBackground: '#f0f0f0',
            listInactiveSelectionBackground: '#e4e6f1',
        });
    });

    /**
     * The fallback only fills in what the theme left out. A theme that names its own selection keeps its own color and
     * its own foreground, so the registry blue never overrides an author's palette.
     */
    it('leaves a declared selection color and its foreground fallback alone', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-vscode-own-list-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'dark.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Own selection',
                type: 'dark',
                colors: {
                    'editor.background': '#1e1e1e',
                    'foreground': '#d4d4d4',
                    'list.activeSelectionBackground': '#bbbbbb',
                },
            }),
            'utf8',
        );

        const { colors } = await importTheme(path, draculaTheme);

        expect(colors).toMatchObject({
            listActiveSelectionBackground: '#bbbbbb',
            listActiveSelectionForeground: '#d4d4d4',
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
            listHoverBackground: '#2a2d2e',
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

/**
 * Flattens a `#rrggbbaa` fill over what sits behind it, because a translucent list or tab fill has no contrast of its
 * own — what the reader actually sees is the blend. Opaque values pass straight through.
 */
function flattenedOver(fill: string, backdrop: string): string {
    if (fill.length !== 9) return fill;
    const alpha = Number.parseInt(fill.slice(7, 9), 16) / 255;
    const channel = (hex: string, start: number): number =>
        Number.parseInt(hex.slice(start, start + 2), 16);
    const blended = [1, 3, 5].map((start) =>
        Math.round(channel(fill, start) * alpha + channel(backdrop, start) * (1 - alpha))
            .toString(16)
            .padStart(2, '0'),
    );
    return `#${blended.join('')}`;
}

/**
 * Every label a user reads while working in the focused window, paired with the fill it sits on.
 *
 * `titleBarInactive*` is deliberately absent. It only paints when the whole window is unfocused, which is inactive UI
 * under WCAG 1.4.3 and the one case where the dimming is the message — macOS and VS Code both fade an unfocused title
 * the same way. Every other state here is something the user is looking at right now.
 */
type ColorRole = keyof ThemeTokens['colors'];

const READABLE_STATE_PAIRS: ReadonlyArray<readonly [ColorRole, ColorRole]> = [
    ['tabActiveForeground', 'tabActiveBackground'],
    ['tabInactiveForeground', 'tabInactiveBackground'],
    ['tabHoverForeground', 'tabHoverBackground'],
    ['listHoverForeground', 'listHoverBackground'],
    ['listFocusForeground', 'listFocusBackground'],
    ['listActiveSelectionForeground', 'listActiveSelectionBackground'],
    ['listInactiveSelectionForeground', 'listInactiveSelectionBackground'],
    ['titleBarActiveForeground', 'titleBarActiveBackground'],
];

/**
 * The presets are Caxri's own product, not a mirror of anyone's VS Code theme, so they answer to `DESIGN.md`'s contrast
 * floor before they answer to upstream fidelity — the same reason Dracula's `muted` is an adjusted blue-grey rather
 * than its palette's comment color. Without this, a preset filling these roles from its upstream theme quietly reverts
 * that correction: several upstream themes use their comment color for `tab.inactiveForeground`, which is exactly the
 * substitution `DESIGN.md` forbids. An imported theme is a different contract and keeps its author's values.
 *
 * `theme.test.ts` holds the sibling floor for `muted`, `foreground`, and `merged` on the three chrome surfaces. The two
 * live apart only because that file is within a few lines of the repository's per-file limit; they are one rule.
 */
describe('built-in control state contrast', () => {
    it('keeps every label the focused window shows at WCAG AA', () => {
        for (const theme of builtinThemes) {
            const { colors } = theme;
            for (const [foreground, background] of READABLE_STATE_PAIRS) {
                const fill = flattenedOver(colors[background], colors.background);
                const label = flattenedOver(colors[foreground], fill);
                expect(
                    contrastRatio(label, fill),
                    `${theme.id} ${foreground}`,
                ).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    /**
     * Which tab is open has to be visible without the accent line, because Caxri draws that line only on the focused
     * pane — in a split, the other pane's tab strip has nothing else. Either cue alone is enough, and the two are on
     * different scales, so they are checked separately: Solarized Light carries it entirely on the fill and Oscura
     * Midnight entirely on the label. What this rules out is a theme with neither, which is what happens when a theme
     * paints both tab states the same color and the contrast floor then pulls the two labels together.
     */
    it('leaves the active tab distinguishable from its neighbours in every theme', () => {
        for (const theme of builtinThemes) {
            const { colors } = theme;
            const fill = contrastRatio(colors.tabActiveBackground, colors.tabInactiveBackground);
            const label = contrastRatio(colors.tabActiveForeground, colors.tabInactiveForeground);
            expect(Math.max(fill / 1.05, label / 1.5), theme.id).toBeGreaterThanOrEqual(1);
        }
    });
});
