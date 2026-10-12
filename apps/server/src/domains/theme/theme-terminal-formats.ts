/**
 * Parsers for the terminal-only theme formats (iTerm2 color presets and Warp themes), split from the VS Code and Caxri
 * JSON path in `index.ts`. Both formats map only the terminal palette (Warp also the accent) and seed every other role
 * from the fallback theme.
 *
 * The plist (with its XML DOM stack) and YAML parsers load on first use through `importItermTheme` and
 * `importWarpTheme`: theme import is rare, and keeping them out of the Server Core startup chunk saves their compiled
 * source and evaluation in every resident Server, including a detached remote one.
 */

import type { ThemeTokens } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { normalizedHex } from './theme-colors';
import type { ParsedThemeImport } from './theme-import-source';
import { cloneFallback, parseThemeDocument, themeDocumentRoot } from './theme-import-source';

const ITERM_PARSE_MESSAGE =
    'This file is not a readable iTerm2 color preset. Export it again from iTerm2 > Settings > Profiles > Colors > Color Presets.';
const ITERM_ROOT_MESSAGE =
    'This iTerm2 color preset is empty. Its property list must have a dictionary root holding the color entries.';
const ITERM_ZERO_HIT_MESSAGE =
    'This iTerm2 color preset does not define any colors Caxri can import. It needs at least one background, foreground, cursor, selection, or ANSI color.';
const WARP_PARSE_MESSAGE =
    'This file is not a readable Warp theme. Warp themes are YAML documents; check the file for an indentation or quoting error.';
const WARP_ROOT_MESSAGE =
    'This Warp theme is empty. A Warp theme is a YAML mapping with top-level color keys such as background, foreground, and terminal_colors.';
const WARP_ZERO_HIT_MESSAGE =
    'This Warp theme does not define any colors Caxri can import. It needs at least one of accent, background, foreground, cursor, or terminal_colors.';

interface PlistColor {
    'Red Component'?: number;
    'Green Component'?: number;
    'Blue Component'?: number;
}

/**
 * `undefined` rather than a fallback so `parseIterm` can tell an imported color from a seeded one: a preset that maps
 * nothing must be rejected, not silently imported as a renamed copy of the fallback theme.
 */
function plistColor(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const color = value as PlistColor;
    if (
        [color['Red Component'], color['Green Component'], color['Blue Component']].some(
            (part) => typeof part !== 'number',
        )
    )
        return undefined;
    return `#${[color['Red Component'], color['Green Component'], color['Blue Component']]
        .map((part) =>
            Math.round((part ?? 0) * 255)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;
}

function parseIterm(
    source: string,
    name: string,
    parsePlist: (source: string) => unknown,
): ParsedThemeImport {
    const document = parseThemeDocument(() => parsePlist(source), ITERM_PARSE_MESSAGE);
    const value = themeDocumentRoot(document, ITERM_ROOT_MESSAGE);
    const theme = cloneFallback('iterm2', name);
    let mapped = 0;
    const importColor = (key: string, fallback: string): string => {
        const color = plistColor(value[key]);
        if (color === undefined) return fallback;
        mapped += 1;
        return color;
    };
    theme.terminal.background = importColor('Background Color', theme.terminal.background);
    theme.terminal.foreground = importColor('Foreground Color', theme.terminal.foreground);
    theme.terminal.cursor = importColor('Cursor Color', theme.terminal.cursor);
    theme.terminal.selectionBackground = importColor(
        'Selection Color',
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
        theme.terminal[target] = importColor(`Ansi ${index} Color`, theme.terminal[target]);
    });
    if (mapped === 0) throw new CaxriError('VALIDATION', ITERM_ZERO_HIT_MESSAGE);
    theme.warnings.push({
        id: 'iterm-terminal-only',
        message: 'iTerm2 is terminal-only; app and editor colors inherit from the active theme.',
    });
    return theme;
}

function parseWarp(
    source: string,
    name: string,
    parseYaml: (source: string) => unknown,
): ParsedThemeImport {
    const document = parseThemeDocument(() => parseYaml(source), WARP_PARSE_MESSAGE);
    const value = themeDocumentRoot(document, WARP_ROOT_MESSAGE);
    const theme = cloneFallback('warp', typeof value.name === 'string' ? value.name : name);
    let mapped = 0;
    const importColor = (raw: unknown, fallback: string): string => {
        const hex = normalizedHex(raw, '');
        if (!hex) return fallback;
        mapped += 1;
        return hex;
    };
    theme.colors.accent = importColor(value.accent, theme.colors.accent);
    theme.terminal.background = importColor(value.background, theme.terminal.background);
    theme.terminal.foreground = importColor(value.foreground, theme.terminal.foreground);
    theme.terminal.cursor = importColor(value.cursor, theme.colors.accent);
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
        theme.terminal[key] = importColor(normal[key], theme.terminal[key]);
        const brightKey =
            `bright${key[0].toUpperCase()}${key.slice(1)}` as keyof ThemeTokens['terminal'];
        theme.terminal[brightKey] = importColor(bright[key], theme.terminal[brightKey]);
    }
    if (mapped === 0) throw new CaxriError('VALIDATION', WARP_ZERO_HIT_MESSAGE);
    theme.warnings.push({
        id: 'warp-visual-effects',
        message: 'Warp gradients and background images were ignored.',
    });
    return theme;
}

/**
 * Parses an iTerm2 color preset, loading the plist parser on first use.
 */
export async function importItermTheme(source: string, name: string): Promise<ParsedThemeImport> {
    const { parse } = await import('plist');
    return parseIterm(source, name, parse);
}

/**
 * Parses a Warp YAML theme, loading the YAML parser on first use.
 */
export async function importWarpTheme(source: string, name: string): Promise<ParsedThemeImport> {
    const { parse } = await import('yaml');
    return parseWarp(source, name, parse);
}
