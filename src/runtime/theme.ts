import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parsePlist } from 'plist';
import YAML from 'yaml';
import { z } from 'zod';

import type { ThemeTokens } from '../shared/types';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const themeSchema: z.ZodType<ThemeTokens> = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.enum(['builtin', 'custom', 'vscode', 'iterm2', 'warp']),
    colors: z.object({
        background: hex,
        surface: hex,
        elevated: hex,
        foreground: hex,
        muted: hex,
        border: hex,
        selection: hex,
        accent: hex,
        success: hex,
        warning: hex,
        danger: hex,
    }),
    terminal: z.object({
        background: hex,
        foreground: hex,
        cursor: hex,
        selectionBackground: hex,
        black: hex,
        red: hex,
        green: hex,
        yellow: hex,
        blue: hex,
        magenta: hex,
        cyan: hex,
        white: hex,
        brightBlack: hex,
        brightRed: hex,
        brightGreen: hex,
        brightYellow: hex,
        brightBlue: hex,
        brightMagenta: hex,
        brightCyan: hex,
        brightWhite: hex,
    }),
    editor: z.object({
        background: hex,
        foreground: hex,
        lineHighlight: hex,
        selection: hex,
        comment: hex,
        keyword: hex,
        string: hex,
        number: hex,
    }),
    warnings: z.array(z.string()),
});

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
        muted: '#6272a4',
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

function parseJsoncSource(source: string): unknown {
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (errors.length > 0) {
        const first = errors[0];
        throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
    }
    return value;
}

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
    return themeSchema.parse(parseJsoncSource(source));
}

export async function importTheme(path: string, current: ThemeTokens): Promise<ThemeTokens> {
    const source = await readFile(path, 'utf8');
    const name =
        path
            .split('/')
            .at(-1)
            ?.replace(/\.[^.]+$/, '') ?? 'Imported Theme';
    const extension = extname(path).toLowerCase();
    let theme: ThemeTokens;
    if (extension === '.itermcolors' || source.includes('<plist')) {
        theme = parseIterm(source, name);
    } else if (extension === '.yaml' || extension === '.yml') {
        theme = parseWarp(source, name);
    } else {
        const value = parseJsoncSource(source);
        const parsed = themeSchema.safeParse(value);
        theme = parsed.success
            ? { ...parsed.data, source: 'custom' }
            : parseVsCode(value as Record<string, unknown>, name);
    }

    if (theme.source === 'iterm2' || theme.source === 'warp') {
        theme.colors = structuredClone(current.colors);
        theme.editor = structuredClone(current.editor);
    }
    return themeSchema.parse(theme);
}

export function serializeTheme(theme: ThemeTokens): string {
    return `${JSON.stringify(theme, null, 2)}\n`;
}
