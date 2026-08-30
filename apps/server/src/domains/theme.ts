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
    const parsed = themeSchema.safeParse(value);
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
