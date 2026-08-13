import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { parse as parsePlist } from 'plist';
import YAML from 'yaml';

/** The theme token shape lives in the IPC contract; importers reuse it instead of redeclaring it. */
import { themeTokensSchema as themeSchema } from '../shared/ipc/domain';
import { CaxriError } from '../shared/ipc/errors';
import { parseJsonc } from '../shared/node/jsonc';
import { themeImportFormats } from '../shared/theme-import';
import type { ThemeTokens } from '../shared/types';

type ThemeImportFormat = (typeof themeImportFormats)[number];

/**
 * Ceiling for a theme file selected for import. Theme files (VS Code color themes, iTerm2
 * plists, Warp YAML, Caxri JSON) are small hand-authored documents; 1 MiB is generous while still
 * bounding the amount of untrusted content handed to the plist/YAML/JSONC parsers, mirroring the
 * size cap other untrusted-file reads apply (see `files/documents.ts` and
 * `MAX_CONFIGURABLE_FILE_BYTES` in `shared/ipc/domain.ts`).
 */
export const MAX_THEME_IMPORT_FILE_BYTES = 1 * 1024 * 1024;

/** Official Dracula OSS palette, normalized once for app, terminal, and Monaco consumers. */
export const draculaTheme: ThemeTokens = {
    id: 'dracula',
    name: 'Dracula',
    source: 'builtin',
    colors: {
        background: '#282a36',
        surface: '#21222c',
        elevated: '#343746',
        foreground: '#f8f8f2',
        /**
         * Deliberately NOT Dracula's `#6272a4`. That value is the palette's *comment* color, tuned
         * for syntax that is meant to recede behind code; `--muted` is the UI's secondary-text role
         * (133 of its 135 uses in the Renderer are `text-muted`), so it has to stay readable. On the
         * lightest chrome surface (`elevated` `#343746`) `#6272a4` measures 3.35:1 against
         * `surface` and only 2.50:1 against `elevated`, both below the WCAG AA 4.5:1 floor for body
         * text. This value keeps the same blue-grey hue and stays clearly subordinate to
         * `foreground`, while clearing AA on every chrome surface (4.81:1 on `elevated`). The
         * comment color itself is unchanged below, where it is still correct.
         */
        muted: '#9aa5c4',
        border: '#44475a',
        selection: '#44475a',
        accent: '#bd93f9',
        success: '#50fa7b',
        warning: '#f1fa8c',
        danger: '#ff5555',
    },
    terminal: {
        background: '#282a36',
        foreground: '#f8f8f2',
        cursor: '#f8f8f2',
        selectionBackground: '#44475a',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#6272a4',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
    },
    editor: {
        background: '#282a36',
        foreground: '#f8f8f2',
        lineHighlight: '#44475a',
        selection: '#44475a',
        comment: '#6272a4',
        keyword: '#ff79c6',
        string: '#f1fa8c',
        number: '#bd93f9',
    },
    warnings: [],
};

function normalizedHex(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const candidate = value.startsWith('#') ? value : `#${value}`;
    if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(candidate))
        return candidate.slice(0, 7).toLowerCase();
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

function parseVsCode(value: Record<string, unknown>, name: string): ThemeTokens {
    const theme = cloneFallback('vscode', name);
    const colors = (value.colors ?? {}) as Record<string, unknown>;
    theme.colors.background = normalizedHex(
        colors['sideBar.background'],
        normalizedHex(colors['editor.background'], theme.colors.background),
    );
    theme.colors.surface = normalizedHex(colors['activityBar.background'], theme.colors.surface);
    theme.colors.foreground = normalizedHex(
        colors.foreground,
        normalizedHex(colors['editor.foreground'], theme.colors.foreground),
    );
    theme.colors.border = normalizedHex(colors['panel.border'], theme.colors.border);
    theme.colors.accent = normalizedHex(colors.focusBorder, theme.colors.accent);
    theme.editor.background = normalizedHex(colors['editor.background'], theme.editor.background);
    theme.editor.foreground = normalizedHex(colors['editor.foreground'], theme.editor.foreground);
    theme.editor.lineHighlight = normalizedHex(
        colors['editor.lineHighlightBackground'],
        theme.editor.lineHighlight,
    );
    theme.editor.selection = normalizedHex(
        colors['editor.selectionBackground'],
        theme.editor.selection,
    );
    theme.terminal.background = normalizedHex(
        colors['terminal.background'],
        theme.editor.background,
    );
    theme.terminal.foreground = normalizedHex(
        colors['terminal.foreground'],
        theme.editor.foreground,
    );
    theme.terminal.cursor = normalizedHex(
        colors['terminalCursor.foreground'],
        theme.terminal.cursor,
    );
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
        theme.terminal[target] = normalizedHex(colors[source], theme.terminal[target]);
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
    return themeSchema.parse(parseJsonc(source));
}

/**
 * VS Code files aren't distinguished by content sniffing: a full Caxri theme export and a VS
 * Code color theme are both plain JSON. Try parsing as a Caxri theme first, and only fall back
 * to the VS Code token mapping when that validation fails.
 */
function parseVsCodeOrCustom(source: string, name: string): ThemeTokens {
    const value = parseJsonc(source);
    const parsed = themeSchema.safeParse(value);
    return parsed.success
        ? { ...parsed.data, source: 'custom' }
        : parseVsCode(value as Record<string, unknown>, name);
}

/** Format id -> parser, keyed by `themeImportFormats[number]['id']` from the shared registry. */
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
 * Picks the import format for a file. The `<plist` content sniff takes priority over the
 * extension so extensionless or misnamed iTerm2 exports still parse correctly; any extension
 * that isn't declared in `themeImportFormats` falls back to the VS Code/Caxri JSON path.
 */
function resolveThemeImportFormat(extension: string, source: string): ThemeImportFormat {
    if (source.includes('<plist')) return findFormatById('iterm2');
    return findFormatByExtension(extension) ?? findFormatById('vscode');
}

export async function importTheme(path: string, current: ThemeTokens): Promise<ThemeTokens> {
    const { size } = await stat(path);
    if (size > MAX_THEME_IMPORT_FILE_BYTES)
        throw new CaxriError(
            'CAPACITY',
            `Theme file exceeds the ${MAX_THEME_IMPORT_FILE_BYTES} byte import limit`,
        );
    const source = await readFile(path, 'utf8');
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
