import { Buffer } from 'node:buffer';
import { dirname, extname, join } from 'node:path';

/**
 * The theme token shape lives in the IPC contract; importers reuse it instead of redeclaring it.
 */
import type { ThemeTokens } from '@caxri/protocol';
import {
    CaxriError,
    themeImportFormats,
    themeTokensSchema as themeSchema,
    upgradeThemeColors,
} from '@caxri/protocol';
import type { BoundedRegularFileReadOptions } from '@caxri/system';
import { parseJsonc, readBoundedRegularFileText } from '@caxri/system';
import { contrastRatio, relativeLuminance } from '@caxri/utils';

import {
    applyVsCodeControlColors,
    applyVsCodeTokenColors,
    firstHex,
    formatMissingSyntaxWarning,
    hasMappedVsCodeColor,
    isLightVsCodeTheme,
    SYNTAX_EDITOR_ROLES,
} from './theme-colors';
import type { ParsedThemeImport } from './theme-import-source';
import { cloneFallback, parseThemeDocument, themeDocumentRoot } from './theme-import-source';
import { importItermTheme, importWarpTheme } from './theme-terminal-formats';
import { VSCODE_DEFAULTS } from './vscode-defaults';

export { draculaTheme } from '@caxri/protocol';

type ThemeImportFormat = (typeof themeImportFormats)[number];

/**
 * Ceiling for a theme file selected for import. Theme files (VS Code color themes, iTerm2 plists, Warp YAML, Caxri
 * JSON) are small hand-authored documents; 1 MiB is generous while still bounding the amount of untrusted content
 * handed to the plist/YAML/JSONC parsers, mirroring the size cap other untrusted-file reads apply (see
 * `files/documents.ts` and `MAX_CONFIGURABLE_FILE_BYTES` in `shared/ipc/domain.ts`).
 */
export const MAX_THEME_IMPORT_FILE_BYTES = 1 * 1024 * 1024;
const ZERO_HIT_THEME_MESSAGE =
    'This theme file does not define any colors Caxri can import. Check that you picked the theme JSON and not a package manifest.';
const VSIX_THEME_MESSAGE =
    'Caxri cannot read a .vsix package yet. Unzip it and pick the theme JSON under themes/.';
const JSON_THEME_PARSE_MESSAGE =
    'This theme file is not readable JSON. Check it for a syntax error such as an unclosed brace or a missing comma.';
const JSON_THEME_ROOT_MESSAGE =
    'This theme file is not a JSON object. Pick the theme JSON that holds the "colors" object, not a list or a bare value.';
const INCLUDE_DIRECTORY_MESSAGE = 'Theme include must be a file in the same directory.';

const MIN_MUTED_CONTRAST = 4.5;
const APP_COLOR_SURFACES = ['background', 'surface', 'elevated'] as const;
const APP_COLOR_SURFACE_LABELS = {
    background: 'editor background',
    elevated: 'raised panel background',
    surface: 'sidebar and status bar background',
} satisfies Record<(typeof APP_COLOR_SURFACES)[number], string>;

function mixHex(from: string, toward: string, amount: number): string {
    const channel = (hex: string, start: number): number =>
        Number.parseInt(hex.slice(start, start + 2), 16);
    const mix = (start: number, end: number): string =>
        Math.round(start + (end - start) * amount)
            .toString(16)
            .padStart(2, '0');
    return `#${[0, 2, 4].map((offset) => mix(channel(from, offset + 1), channel(toward, offset + 1))).join('')}`;
}

/**
 * Caxri chrome seams are only `bg-surface` vs `bg-background`. When the fallback surface matches the editor canvas,
 * nudge the fallback so the workbench regions remain distinguishable without rewriting an explicit theme color.
 */
function separateSurfaceFromBackground(background: string, surface: string): string {
    if (surface === background) {
        return mixHex(
            background,
            relativeLuminance(background) > 0.5 ? '#000000' : '#ffffff',
            0.08,
        );
    }
    return surface;
}

/**
 * `type` is the theme author's own declaration; `uiTheme` is the older manifest field carrying the same information.
 * Falling back to the editor background's luminance covers a file that declares neither.
 */
function parseVsCode(value: Record<string, unknown>, name: string): ParsedThemeImport {
    const theme = cloneFallback('vscode', name);
    const colors = (value.colors ?? {}) as Record<string, unknown>;
    const syntaxMapping = applyVsCodeTokenColors(theme, value.tokenColors);
    if (
        !hasMappedVsCodeColor(colors) &&
        syntaxMapping.missing.length === SYNTAX_EDITOR_ROLES.length
    ) {
        throw new CaxriError('VALIDATION', ZERO_HIT_THEME_MESSAGE);
    }
    /**
     * `--background` is the editor/Terminal canvas and `--surface` is the chrome around it, which is exactly VS Code's
     * `editor.background` / `sideBar.background` split. These two were previously swapped: `background` read
     * `sideBar.background` and `surface` read `activityBar.background`, so an imported theme painted the editor in its
     * sidebar color and the sidebar in its activity-bar color.
     */
    theme.colors.background = firstHex(colors, ['editor.background'], theme.colors.background);
    const defaults = isLightVsCodeTheme(value, theme.colors.background)
        ? VSCODE_DEFAULTS.light
        : VSCODE_DEFAULTS.dark;
    /**
     * Fall back to VS Code's own sidebar default rather than the editor canvas. Only a fallback collision may be
     * adjusted; an explicit sidebar or activity-bar color is the theme author's choice.
     */
    const explicitSurface = firstHex(colors, ['sideBar.background', 'activityBar.background'], '');
    theme.colors.surface =
        explicitSurface || separateSurfaceFromBackground(theme.colors.background, defaults.surface);
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
    /**
     * `testing.iconPassed` is the workbench's own "this passed" green and is what a theme tunes for a success glyph;
     * `charts.green` is a data-series color that several themes leave at a saturated default. It stays as the second
     * source because plenty of themes set only it.
     */
    theme.colors.success = firstHex(
        colors,
        ['testing.iconPassed', 'charts.green'],
        defaults.success,
    );
    theme.colors.warning = firstHex(colors, ['editorWarning.foreground'], defaults.warning);
    theme.colors.danger = firstHex(colors, ['editorError.foreground'], defaults.danger);
    /**
     * `activityBarBadge.background` rather than `badge.background`: Caxri's numeric badge sits on a view-container tab,
     * which is the control VS Code styles with the activity-bar key.
     */
    theme.colors.badge = firstHex(colors, ['activityBarBadge.background'], defaults.badge);
    /**
     * The severity badges fall back to the theme's own error/warning text color before the registry default, because a
     * theme that never heard of these keys still declared how its errors should look.
     */
    theme.colors.errorBadge = firstHex(
        colors,
        ['activityErrorBadge.background', 'editorError.foreground'],
        defaults.errorBadge,
    );
    theme.colors.warningBadge = firstHex(
        colors,
        ['activityWarningBadge.background', 'editorWarning.foreground'],
        defaults.warningBadge,
    );
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
     * VS Code core has no merged-pull-request color, but the GitHub Pull Requests extension declares
     * `pullRequests.merged`, and real themes set it far more often than they tune `charts.purple` for this. The chart
     * palette stays as the workbench-native second source. Absent both, the value stays whatever `cloneFallback`
     * seeded, i.e. Dracula's, which is the same fallback every unmapped app color here already uses.
     */
    theme.colors.merged = firstHex(
        colors,
        ['pullRequests.merged', 'charts.purple'],
        theme.colors.merged,
    );
    /**
     * `charts.green` is the workbench's own data-series color, the one VS Code paints a chart with. A theme that leaves
     * it unset keeps charts on its resolved `success`, which is what they painted before the role existed.
     */
    theme.colors.chart = firstHex(colors, ['charts.green'], theme.colors.success);
    applyVsCodeControlColors(theme, colors);
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
    // Unlike opaque workbench colors, a translucent selection must retain its alpha for xterm to blend it correctly.
    theme.terminal.selectionBackground = firstHex(
        colors,
        ['terminal.selectionBackground'],
        theme.terminal.selectionBackground,
        { preserveAlpha: true },
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
        theme.terminal[target] = firstHex(colors, [source], theme.terminal[target]);
    if (syntaxMapping.missing.length > 0)
        theme.warnings.push({
            id: 'missing-syntax-colors',
            message: formatMissingSyntaxWarning(syntaxMapping.missing),
        });
    if (syntaxMapping.hasOtherSyntaxRules)
        theme.warnings.push({
            id: 'other-syntax-colors',
            message: 'Other syntax token colors were not imported.',
        });
    if (value.semanticTokenColors !== undefined)
        theme.warnings.push({
            id: 'semantic-token-colors',
            message: 'Semantic token colors were not imported.',
        });
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
        const actualRatio = muted && backdrop ? contrastRatio(muted, backdrop) : null;
        if (actualRatio !== null && actualRatio >= MIN_MUTED_CONTRAST) continue;
        throw new CaxriError(
            'VALIDATION',
            `Secondary text in the imported theme must have at least ${MIN_MUTED_CONTRAST}:1 contrast against the ${APP_COLOR_SURFACE_LABELS[surface]}. Choose a lighter or darker secondary text color and try again.`,
            {
                kind: 'theme-contrast',
                foregroundRole: 'muted',
                backgroundRole: surface,
                actualRatio,
                requiredRatio: MIN_MUTED_CONTRAST,
            },
        );
    }
}

/**
 * VS Code files aren't distinguished by content sniffing: a full Caxri theme export and a VS Code color theme are both
 * plain JSON. Try parsing as a Caxri theme first, and only fall back to the VS Code token mapping when that validation
 * fails.
 */
function parseVsCodeOrCustom(source: string, name: string): ParsedThemeImport {
    const document = parseThemeDocument(() => parseJsonc(source), JSON_THEME_PARSE_MESSAGE);
    const value = themeDocumentRoot(document, JSON_THEME_ROOT_MESSAGE);
    // Upgrade first: a Caxri theme exported before a color role existed must still be recognized as one here, or it
    // would fall through to the VS Code mapping and import as a mangled theme rather than the one the user exported.
    const parsed = themeSchema.safeParse(upgradeThemeColors(value));
    if (!parsed.success) {
        const theme = parseVsCode(value, name);
        assertImportedThemeContrast(theme);
        return theme;
    }
    assertImportedThemeContrast(parsed.data);
    return { ...parsed.data, source: 'custom', warnings: [] };
}

/**
 * Format id -> parser, keyed by `themeImportFormats[number]['id']` from the shared registry. The terminal-only formats
 * load their document parsers on first use; see `theme-terminal-formats.ts`.
 */
async function parseThemeForFormat(
    formatId: ThemeImportFormat['id'],
    source: string,
    name: string,
): Promise<ParsedThemeImport> {
    switch (formatId) {
        case 'iterm2':
            return importItermTheme(source, name);
        case 'warp':
            return importWarpTheme(source, name);
        case 'vscode':
            return parseVsCodeOrCustom(source, name);
    }
}

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

function sameDirectoryIncludePath(fromPath: string, include: string): string | undefined {
    const posix = include.trim().replaceAll('\\', '/');
    if (posix.length === 0 || posix.includes('..')) return undefined;
    const relative = posix.startsWith('./') ? posix.slice(2) : posix;
    if (relative.length === 0 || relative.includes('/')) return undefined;
    return join(dirname(fromPath), relative);
}

function mergeVsCodeTheme(
    parent: Record<string, unknown>,
    child: Record<string, unknown>,
): Record<string, unknown> {
    const parentColors =
        parent.colors && typeof parent.colors === 'object' && !Array.isArray(parent.colors)
            ? (parent.colors as Record<string, unknown>)
            : {};
    const childColors =
        child.colors && typeof child.colors === 'object' && !Array.isArray(child.colors)
            ? (child.colors as Record<string, unknown>)
            : {};
    const parentTokens: unknown[] = Array.isArray(parent.tokenColors) ? parent.tokenColors : [];
    const childTokens: unknown[] = Array.isArray(child.tokenColors) ? child.tokenColors : [];
    return {
        ...parent,
        ...child,
        colors: { ...parentColors, ...childColors },
        tokenColors: [...parentTokens, ...childTokens],
    };
}

/**
 * Resolves one included parent; nested includes are not traversed, so only this merged document needs a final size
 * check.
 */
async function resolveVsCodeInclude(
    path: string,
    source: string,
    testSeam?: ThemeImportTestSeam,
): Promise<string> {
    let child: unknown;
    try {
        child = parseJsonc(source);
    } catch {
        return source;
    }
    if (!child || typeof child !== 'object' || Array.isArray(child)) return source;
    const document = child as Record<string, unknown>;
    if (themeSchema.safeParse(upgradeThemeColors(document)).success) return source;
    if (typeof document.include !== 'string' || document.include.trim() === '') return source;
    const parentPath = sameDirectoryIncludePath(path, document.include);
    if (!parentPath) throw new CaxriError('VALIDATION', INCLUDE_DIRECTORY_MESSAGE);
    const parentSource = await readBoundedRegularFileText(parentPath, MAX_THEME_IMPORT_FILE_BYTES, {
        beforeRead: testSeam?.beforeRead,
        capacityMessage: `Theme file exceeds the ${MAX_THEME_IMPORT_FILE_BYTES} byte import limit`,
    });
    /**
     * The included parent is a second untrusted document, so it gets the same two guards as the file the user picked. A
     * parent that parsed to an array used to be reported as `INCLUDE_DIRECTORY_MESSAGE`, which pointed at the one thing
     * that was not wrong: the parent is in the right directory, it just does not hold theme colors.
     */
    const parent = parseThemeDocument(() => parseJsonc(parentSource), JSON_THEME_PARSE_MESSAGE);
    const merged = JSON.stringify(
        mergeVsCodeTheme(themeDocumentRoot(parent, JSON_THEME_ROOT_MESSAGE), document),
    );
    if (Buffer.byteLength(merged, 'utf8') > MAX_THEME_IMPORT_FILE_BYTES)
        throw new CaxriError(
            'VALIDATION',
            `Theme exceeds the ${MAX_THEME_IMPORT_FILE_BYTES} byte limit after merging its included parent`,
        );
    return merged;
}

export async function importTheme(
    path: string,
    current: ThemeTokens,
    testSeam?: ThemeImportTestSeam,
): Promise<ParsedThemeImport> {
    const extension = extname(path).toLowerCase();
    if (extension === '.vsix') throw new CaxriError('VALIDATION', VSIX_THEME_MESSAGE);
    const source = await readBoundedRegularFileText(path, MAX_THEME_IMPORT_FILE_BYTES, {
        beforeRead: testSeam?.beforeRead,
        capacityMessage: `Theme file exceeds the ${MAX_THEME_IMPORT_FILE_BYTES} byte import limit`,
    });
    const name =
        path
            .split('/')
            .at(-1)
            ?.replace(/\.[^.]+$/, '') ?? 'Imported Theme';
    const format = resolveThemeImportFormat(extension, source);
    const document =
        format.id === 'vscode' ? await resolveVsCodeInclude(path, source, testSeam) : source;
    const theme = await parseThemeForFormat(format.id, document, name);

    if (format.terminalOnly) {
        theme.colors = structuredClone(current.colors);
        theme.editor = structuredClone(current.editor);
    }
    return { ...themeSchema.parse(theme), warnings: theme.warnings };
}

export function serializeTheme(theme: ThemeTokens): string {
    return `${JSON.stringify(themeSchema.parse(theme), null, 2)}\n`;
}
