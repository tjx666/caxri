import { extname } from 'node:path';

/**
 * The theme token shape lives in the IPC contract; importers reuse it instead of redeclaring it.
 */
import type { ThemeTokens } from '@caxri/protocol';
import {
    CaxriError,
    draculaTheme,
    themeImportFormats,
    themeTokensSchema as themeSchema,
    upgradeThemeColors,
} from '@caxri/protocol';
import { parseJsonc } from '@caxri/system';
import { contrastRatio } from '@caxri/utils';
import { parse as parsePlist } from 'plist';
import YAML from 'yaml';

import type { BoundedRegularFileReadOptions } from './bounded-file-reader';
import { readBoundedRegularFileText } from './bounded-file-reader';

export { draculaTheme } from '@caxri/protocol';

type ThemeImportFormat = (typeof themeImportFormats)[number];

/**
 * Ceiling for a theme file selected for import. Theme files (VS Code color themes, iTerm2 plists, Warp YAML, Caxri
 * JSON) are small hand-authored documents; 1 MiB is generous while still bounding the amount of untrusted content
 * handed to the plist/YAML/JSONC parsers, mirroring the size cap other untrusted-file reads apply (see
 * `files/documents.ts` and `MAX_CONFIGURABLE_FILE_BYTES` in `shared/ipc/domain.ts`).
 */
export const MAX_THEME_IMPORT_FILE_BYTES = 1 * 1024 * 1024;
const MIN_MUTED_CONTRAST = 4.5;
const APP_COLOR_SURFACES = ['background', 'surface', 'elevated'] as const;
const APP_COLOR_SURFACE_LABELS = {
    background: 'editor background',
    elevated: 'raised panel background',
    surface: 'sidebar and status bar background',
} satisfies Record<(typeof APP_COLOR_SURFACES)[number], string>;

function normalizedHex(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const candidate = value.startsWith('#') ? value : `#${value}`;
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(candidate))
        return candidate.slice(0, 7).toLowerCase();
    // VS Code themes may use CSS shorthand (`#fff`, `#fff8`); expand it rather than silently dropping the color.
    const shorthand = /^#([0-9a-f]{3,4})$/i.exec(candidate);
    if (!shorthand) return fallback;
    const [red, green, blue] = shorthand[1];
    return `#${red}${red}${green}${green}${blue}${blue}`.toLowerCase();
}

/**
 * First key the VS Code theme actually defines as a usable color, else `fallback`.
 *
 * Several Caxri roles have no single VS Code counterpart and have to walk an ordered preference list (see `border` and
 * `accent` below). Written as a helper rather than nested `normalizedHex` calls so the preference order reads as a list
 * instead of as nesting depth, and so a one-key read looks the same as a three-key one.
 */
function firstHex(
    colors: Record<string, unknown>,
    keys: readonly string[],
    fallback: string,
): string {
    for (const key of keys) {
        const hex = normalizedHex(colors[key], '');
        if (hex) return hex;
    }
    return fallback;
}

function cloneFallback(source: ThemeTokens['source'], name: string): ThemeTokens {
    return structuredClone({
        ...draculaTheme,
        id: `${source}-${Date.now()}`,
        name,
        source,
        warnings: [],
    });
}

/**
 * VS Code's registry defaults for the workbench colors Caxri maps, used exactly as VS Code uses them: when a theme
 * leaves a key unset, this is the color it actually paints. Seeding an unset role from Dracula instead (the previous
 * behavior for every role below) produced imports that mixed two palettes — a light VS Code theme kept Dracula's dark
 * `elevated`, `muted`, and `selection`. Decoration defaults come from the built-in Git extension's `contributes.colors`
 * rather than the core registry.
 */
const VSCODE_DEFAULTS = {
    dark: {
        elevated: '#252526', // editorWidget.background
        muted: '#9d9d9d', // descriptionForeground
        selection: '#264f78', // editor.selectionBackground
        border: '#454545', // contrastBorder-less panel/tab seam
        success: '#89d185', // testing.iconPassed / notebook success
        warning: '#cca700', // editorWarning.foreground
        danger: '#f48771', // editorError.foreground
        badge: '#007acc', // activityBarBadge.background
        gitAdded: '#81b88b',
        gitModified: '#e2c08d',
        gitDeleted: '#c74e39',
        gitUntracked: '#73c991',
        gitConflicting: '#e4676b',
    },
    light: {
        elevated: '#f3f3f3',
        /**
         * VS Code's light `foreground`, not its light `descriptionForeground` (`#717171`): that value lands at 4.4:1 on
         * the light `editorWidget.background` default below, just under the AA floor `assertMutedContrast` holds every
         * import to, so a plain light theme that sets neither key would be rejected outright.
         */
        muted: '#616161',
        selection: '#add6ff',
        border: '#c8c8c8',
        success: '#2d883e',
        warning: '#bf8803',
        danger: '#e51400',
        badge: '#007acc',
        gitAdded: '#587c0c',
        gitModified: '#895503',
        gitDeleted: '#ad0707',
        gitUntracked: '#007100',
        gitConflicting: '#ad0707',
    },
} as const;

/**
 * `type` is the theme author's own declaration; `uiTheme` is the older manifest field carrying the same information.
 * Falling back to the editor background's luminance covers a file that declares neither.
 */
function isLightVsCodeTheme(value: Record<string, unknown>, editorBackground: string): boolean {
    const declared = value.type ?? value.uiTheme;
    if (declared === 'light' || declared === 'vs') return true;
    if (declared === 'dark' || declared === 'vs-dark') return false;
    return contrastRatio(editorBackground, '#000000') > contrastRatio(editorBackground, '#ffffff');
}

function parseVsCode(value: Record<string, unknown>, name: string): ThemeTokens {
    const theme = cloneFallback('vscode', name);
    const colors = (value.colors ?? {}) as Record<string, unknown>;
    /**
     * `--background` is the editor/Terminal canvas and `--surface` is the chrome around it, which is exactly VS Code's
     * `editor.background` / `sideBar.background` split. These two were previously swapped — `background` read
     * `sideBar.background` and `surface` read `activityBar.background` — so an imported theme painted the editor in its
     * sidebar color and the sidebar in its activity-bar color.
     */
    theme.colors.background = firstHex(colors, ['editor.background'], theme.colors.background);
    theme.colors.surface = firstHex(
        colors,
        ['sideBar.background', 'activityBar.background'],
        theme.colors.background,
    );
    const defaults = isLightVsCodeTheme(value, theme.colors.background)
        ? VSCODE_DEFAULTS.light
        : VSCODE_DEFAULTS.dark;
    theme.colors.elevated = firstHex(colors, ['editorWidget.background'], defaults.elevated);
    theme.colors.foreground = firstHex(
        colors,
        ['foreground', 'editor.foreground'],
        theme.colors.foreground,
    );
    theme.colors.muted = firstHex(colors, ['descriptionForeground'], defaults.muted);
    theme.colors.selection = firstHex(colors, ['editor.selectionBackground'], defaults.selection);
    /**
     * `panel.border` is the first choice because it is the seam Caxri's hairline plays, but several popular themes
     * (Dracula among them) set it to a saturated palette color that would draw a grid around every region. Prefer the
     * quieter `sideBar.border` / `tab.border` when the theme provides one.
     */
    theme.colors.border = firstHex(
        colors,
        ['sideBar.border', 'tab.border', 'panel.border'],
        defaults.border,
    );
    /**
     * VS Code has no single accent. Caxri's `accent` marks the active tab's top edge and the focused pane, so the
     * theme's own "this one is active" edge is the faithful source; `focusBorder` (the previous and only source) is
     * frequently a near-invisible grey and left every import without a usable focus ring.
     */
    theme.colors.accent = firstHex(
        colors,
        [
            'tab.activeBorderTop',
            'activityBar.activeBorder',
            'progressBar.background',
            'focusBorder',
        ],
        theme.colors.accent,
    );
    theme.colors.success = firstHex(colors, ['charts.green'], defaults.success);
    theme.colors.warning = firstHex(colors, ['editorWarning.foreground'], defaults.warning);
    theme.colors.danger = firstHex(colors, ['editorError.foreground'], defaults.danger);
    /**
     * `activityBarBadge.background` rather than `badge.background`: Caxri's numeric badge sits on a view-container tab,
     * which is the control VS Code styles with the activity-bar key.
     */
    theme.colors.badge = firstHex(colors, ['activityBarBadge.background'], defaults.badge);
    theme.colors.gitAdded = firstHex(
        colors,
        ['gitDecoration.addedResourceForeground'],
        defaults.gitAdded,
    );
    theme.colors.gitModified = firstHex(
        colors,
        ['gitDecoration.modifiedResourceForeground'],
        defaults.gitModified,
    );
    theme.colors.gitDeleted = firstHex(
        colors,
        ['gitDecoration.deletedResourceForeground'],
        defaults.gitDeleted,
    );
    theme.colors.gitUntracked = firstHex(
        colors,
        ['gitDecoration.untrackedResourceForeground'],
        defaults.gitUntracked,
    );
    theme.colors.gitConflicting = firstHex(
        colors,
        ['gitDecoration.conflictingResourceForeground'],
        defaults.gitConflicting,
    );
    /**
     * VS Code has no merged-pull-request color of its own — that lives in the GitHub PR extension — so the chart
     * palette's purple is the closest workbench-native source. Absent it the value stays whatever `cloneFallback`
     * seeded, i.e. Dracula's, which is the same fallback every unmapped app color here already uses.
     */
    theme.colors.merged = firstHex(colors, ['charts.purple'], theme.colors.merged);
    theme.editor.background = firstHex(colors, ['editor.background'], theme.editor.background);
    theme.editor.foreground = firstHex(colors, ['editor.foreground'], theme.editor.foreground);
    theme.editor.lineHighlight = firstHex(
        colors,
        ['editor.lineHighlightBackground'],
        theme.editor.lineHighlight,
    );
    theme.editor.selection = firstHex(
        colors,
        ['editor.selectionBackground'],
        theme.editor.selection,
    );
    theme.terminal.background = firstHex(colors, ['terminal.background'], theme.editor.background);
    theme.terminal.foreground = firstHex(colors, ['terminal.foreground'], theme.editor.foreground);
    theme.terminal.cursor = firstHex(colors, ['terminalCursor.foreground'], theme.terminal.cursor);
    const ansiMap: Array<[keyof ThemeTokens['terminal'], string]> = [
        ['black', 'terminal.ansiBlack'],
        ['red', 'terminal.ansiRed'],
        ['green', 'terminal.ansiGreen'],
        ['yellow', 'terminal.ansiYellow'],
        ['blue', 'terminal.ansiBlue'],
        ['magenta', 'terminal.ansiMagenta'],
        ['cyan', 'terminal.ansiCyan'],
        ['white', 'terminal.ansiWhite'],
        ['brightBlack', 'terminal.ansiBrightBlack'],
        ['brightRed', 'terminal.ansiBrightRed'],
        ['brightGreen', 'terminal.ansiBrightGreen'],
        ['brightYellow', 'terminal.ansiBrightYellow'],
        ['brightBlue', 'terminal.ansiBrightBlue'],
        ['brightMagenta', 'terminal.ansiBrightMagenta'],
        ['brightCyan', 'terminal.ansiBrightCyan'],
        ['brightWhite', 'terminal.ansiBrightWhite'],
    ];
    for (const [target, source] of ansiMap)
        theme.terminal[target] = firstHex(colors, [source], theme.terminal[target]);
    theme.warnings.push('Unsupported VS Code tokens and extension metadata were ignored.');
    return theme;
}

interface PlistColor {
    'Red Component'?: number;
    'Green Component'?: number;
    'Blue Component'?: number;
}

function plistColor(value: unknown, fallback: string): string {
    if (!value || typeof value !== 'object') return fallback;
    const color = value as PlistColor;
    if (
        [color['Red Component'], color['Green Component'], color['Blue Component']].some(
            (part) => typeof part !== 'number',
        )
    )
        return fallback;
    return `#${[color['Red Component'], color['Green Component'], color['Blue Component']]
        .map((part) =>
            Math.round((part ?? 0) * 255)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;
}

function parseIterm(source: string, name: string): ThemeTokens {
    const value = parsePlist(source) as Record<string, unknown>;
    const theme = cloneFallback('iterm2', name);
    theme.terminal.background = plistColor(value['Background Color'], theme.terminal.background);
    theme.terminal.foreground = plistColor(value['Foreground Color'], theme.terminal.foreground);
    theme.terminal.cursor = plistColor(value['Cursor Color'], theme.terminal.cursor);
    theme.terminal.selectionBackground = plistColor(
        value['Selection Color'],
        theme.terminal.selectionBackground,
    );
    const targets: Array<keyof ThemeTokens['terminal']> = [
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite',
    ];
    targets.forEach((target, index) => {
        theme.terminal[target] = plistColor(value[`Ansi ${index} Color`], theme.terminal[target]);
    });
    theme.warnings.push(
        'iTerm2 is terminal-only; app and editor colors inherit from the active theme.',
    );
    return theme;
}

function parseWarp(source: string, name: string): ThemeTokens {
    const value = YAML.parse(source) as Record<string, unknown>;
    const theme = cloneFallback('warp', typeof value.name === 'string' ? value.name : name);
    theme.colors.accent = normalizedHex(value.accent, theme.colors.accent);
    theme.terminal.background = normalizedHex(value.background, theme.terminal.background);
    theme.terminal.foreground = normalizedHex(value.foreground, theme.terminal.foreground);
    theme.terminal.cursor = normalizedHex(value.cursor, theme.colors.accent);
    const terminalColors = (value.terminal_colors ?? {}) as Record<string, unknown>;
    const normal = (terminalColors.normal ?? {}) as Record<string, unknown>;
    const bright = (terminalColors.bright ?? {}) as Record<string, unknown>;
    for (const key of [
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
    ] as const) {
        theme.terminal[key] = normalizedHex(normal[key], theme.terminal[key]);
        const brightKey =
            `bright${key[0].toUpperCase()}${key.slice(1)}` as keyof ThemeTokens['terminal'];
        theme.terminal[brightKey] = normalizedHex(bright[key], theme.terminal[brightKey]);
    }
    theme.warnings.push('Warp gradients and background images were ignored.');
    return theme;
}

export function parseCaxriTheme(source: string): ThemeTokens {
    return themeSchema.parse(upgradeThemeColors(parseJsonc(source)));
}

function opaqueColor(value: string): string | undefined {
    if (value.length === 7) return value;
    return value.toLowerCase().endsWith('ff') ? value.slice(0, 7) : undefined;
}

function assertImportedThemeContrast(theme: ThemeTokens): void {
    const muted = opaqueColor(theme.colors.muted);
    for (const surface of APP_COLOR_SURFACES) {
        const backdrop = opaqueColor(theme.colors[surface]);
        if (muted && backdrop && contrastRatio(muted, backdrop) >= MIN_MUTED_CONTRAST) continue;
        throw new CaxriError(
            'VALIDATION',
            `Secondary text in the imported theme must have at least ${MIN_MUTED_CONTRAST}:1 contrast against the ${APP_COLOR_SURFACE_LABELS[surface]}. Choose a lighter or darker secondary text color and try again.`,
        );
    }
}

/**
 * VS Code files aren't distinguished by content sniffing: a full Caxri theme export and a VS Code color theme are both
 * plain JSON. Try parsing as a Caxri theme first, and only fall back to the VS Code token mapping when that validation
 * fails.
 */
function parseVsCodeOrCustom(source: string, name: string): ThemeTokens {
    const value = parseJsonc(source);
    // Upgrade first: a Caxri theme exported before a color role existed must still be recognized as one here, or it
    // would fall through to the VS Code mapping and import as a mangled theme rather than the one the user exported.
    const parsed = themeSchema.safeParse(upgradeThemeColors(value));
    if (!parsed.success) {
        const theme = parseVsCode(value as Record<string, unknown>, name);
        assertImportedThemeContrast(theme);
        return theme;
    }
    assertImportedThemeContrast(parsed.data);
    return { ...parsed.data, source: 'custom' };
}

/**
 * Format id -> parser, keyed by `themeImportFormats[number]['id']` from the shared registry.
 */
const parsersByFormatId: Record<
    ThemeImportFormat['id'],
    (source: string, name: string) => ThemeTokens
> = {
    iterm2: parseIterm,
    warp: parseWarp,
    vscode: parseVsCodeOrCustom,
};

function findFormatByExtension(extension: string): ThemeImportFormat | undefined {
    const bareExtension = extension.replace(/^\./, '');
    return themeImportFormats.find((format) =>
        (format.extensions as readonly string[]).includes(bareExtension),
    );
}

function findFormatById(id: ThemeImportFormat['id']): ThemeImportFormat {
    // Every id referenced below is a literal from themeImportFormats, so this always resolves.
    return themeImportFormats.find((format) => format.id === id)!;
}

/**
 * Picks the import format for a file. The `<plist` content sniff takes priority over the extension so extensionless or
 * misnamed iTerm2 exports still parse correctly; any extension that isn't declared in `themeImportFormats` falls back
 * to the VS Code/Caxri JSON path.
 */
function resolveThemeImportFormat(extension: string, source: string): ThemeImportFormat {
    if (source.includes('<plist')) return findFormatById('iterm2');
    return findFormatByExtension(extension) ?? findFormatById('vscode');
}

/**
 * Test-only seam that makes an opened-file mutation deterministic without widening parser APIs.
 */
interface ThemeImportTestSeam {
    beforeRead?: BoundedRegularFileReadOptions['beforeRead'];
}

export async function importTheme(
    path: string,
    current: ThemeTokens,
    testSeam?: ThemeImportTestSeam,
): Promise<ThemeTokens> {
    const source = await readBoundedRegularFileText(path, MAX_THEME_IMPORT_FILE_BYTES, {
        beforeRead: testSeam?.beforeRead,
        capacityMessage: `Theme file exceeds the ${MAX_THEME_IMPORT_FILE_BYTES} byte import limit`,
    });
    const name =
        path
            .split('/')
            .at(-1)
            ?.replace(/\.[^.]+$/, '') ?? 'Imported Theme';
    const extension = extname(path).toLowerCase();
    const format = resolveThemeImportFormat(extension, source);
    const theme = parsersByFormatId[format.id](source, name);

    if (format.terminalOnly) {
        theme.colors = structuredClone(current.colors);
        theme.editor = structuredClone(current.editor);
    }
    return themeSchema.parse(theme);
}

export function serializeTheme(theme: ThemeTokens): string {
    return `${JSON.stringify(theme, null, 2)}\n`;
}
