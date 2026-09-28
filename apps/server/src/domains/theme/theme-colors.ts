/**
 * Hex normalization shared by every theme importer, plus the readers that turn a VS Code color theme's `colors` and
 * `tokenColors` into Caxri roles. Split out of `index.ts` so that file stays the import pipeline — format detection,
 * the iTerm/Warp/Caxri parsers, include resolution, and contrast enforcement — rather than also holding the largest
 * per-format mapping table.
 */
import type { ThemeTokens } from '@caxri/protocol';
import { DEFAULT_SHADOW } from '@caxri/protocol';
import { contrastRatio } from '@caxri/utils';

/**
 * VS Code `colors` keys `parseVsCode` actually maps. Zero-hit rejection also counts syntax roles mapped from
 * `tokenColors`; semantic token colors are omitted because Caxri does not import them.
 */
const VSCODE_MAPPED_COLOR_KEYS = new Set([
    'editor.background',
    'editor.foreground',
    'editor.lineHighlightBackground',
    'editor.selectionBackground',
    'sideBar.background',
    'activityBar.background',
    'editorWidget.background',
    'foreground',
    'descriptionForeground',
    'sideBar.border',
    'tab.border',
    'panel.border',
    'tab.activeBorderTop',
    'activityBar.activeBorder',
    'progressBar.background',
    'focusBorder',
    'charts.green',
    'charts.purple',
    'testing.iconPassed',
    'pullRequests.merged',
    'tab.activeBackground',
    'tab.activeForeground',
    'tab.inactiveBackground',
    'tab.inactiveForeground',
    'tab.hoverBackground',
    'tab.hoverForeground',
    'list.hoverBackground',
    'list.hoverForeground',
    'list.focusBackground',
    'list.focusForeground',
    'list.activeSelectionBackground',
    'list.activeSelectionForeground',
    'list.inactiveSelectionBackground',
    'list.inactiveSelectionForeground',
    'titleBar.activeBackground',
    'titleBar.activeForeground',
    'titleBar.inactiveBackground',
    'titleBar.inactiveForeground',
    'widget.shadow',
    'editorWarning.foreground',
    'editorError.foreground',
    'activityBarBadge.background',
    'gitDecoration.addedResourceForeground',
    'gitDecoration.modifiedResourceForeground',
    'gitDecoration.deletedResourceForeground',
    'gitDecoration.untrackedResourceForeground',
    'gitDecoration.conflictingResourceForeground',
    'terminal.background',
    'terminal.foreground',
    'terminalCursor.foreground',
    'terminal.selectionBackground',
    'terminal.ansiBlack',
    'terminal.ansiRed',
    'terminal.ansiGreen',
    'terminal.ansiYellow',
    'terminal.ansiBlue',
    'terminal.ansiMagenta',
    'terminal.ansiCyan',
    'terminal.ansiWhite',
    'terminal.ansiBrightBlack',
    'terminal.ansiBrightRed',
    'terminal.ansiBrightGreen',
    'terminal.ansiBrightYellow',
    'terminal.ansiBrightBlue',
    'terminal.ansiBrightMagenta',
    'terminal.ansiBrightCyan',
    'terminal.ansiBrightWhite',
]);
export function normalizedHex(
    value: unknown,
    fallback: string,
    options: { preserveAlpha?: boolean } = {},
): string {
    if (typeof value !== 'string') return fallback;
    const candidate = value.startsWith('#') ? value : `#${value}`;
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(candidate)) {
        const hex = candidate.toLowerCase();
        return options.preserveAlpha ? hex : hex.slice(0, 7);
    }
    // VS Code themes may use CSS shorthand (`#fff`, `#fff8`); expand it rather than silently dropping the color.
    const shorthand = /^#([0-9a-f]{3,4})$/i.exec(candidate);
    if (!shorthand) return fallback;
    const digits = shorthand[1].toLowerCase();
    const [red, green, blue] = digits;
    const rgb = `#${red}${red}${green}${green}${blue}${blue}`;
    if (!options.preserveAlpha || digits.length === 3) return rgb;
    const alpha = digits[3];
    return `${rgb}${alpha}${alpha}`;
}

/**
 * First key the VS Code theme actually defines as a usable color, else `fallback`.
 *
 * Several Caxri roles have no single VS Code counterpart and have to walk an ordered preference list (see `border` and
 * `accent` below). Written as a helper rather than nested `normalizedHex` calls so the preference order reads as a list
 * instead of as nesting depth, and so a one-key read looks the same as a three-key one.
 */
export function firstHex(
    colors: Record<string, unknown>,
    keys: readonly string[],
    fallback: string,
    options: { preserveAlpha?: boolean } = {},
): string {
    for (const key of keys) {
        const hex = normalizedHex(colors[key], '', options);
        if (hex) return hex;
    }
    return fallback;
}

export const SYNTAX_EDITOR_ROLES = ['comment', 'keyword', 'string', 'number'] as const;
type SyntaxEditorRole = (typeof SYNTAX_EDITOR_ROLES)[number];

const SYNTAX_SCOPE_PREFIX = {
    comment: 'comment',
    keyword: 'keyword',
    string: 'string',
    number: 'constant.numeric',
} as const satisfies Record<SyntaxEditorRole, string>;

function tokenColorScopes(scope: unknown): string[] {
    const tokens = typeof scope === 'string' ? [scope] : Array.isArray(scope) ? scope : [];
    const scopes: string[] = [];
    for (const token of tokens) {
        if (typeof token !== 'string') continue;
        for (const part of token.split(',')) {
            const trimmed = part.trim();
            if (trimmed.length > 0) scopes.push(trimmed);
        }
    }
    return scopes;
}

function assignMatchingSyntaxRoles(
    theme: ThemeTokens,
    scopes: readonly string[],
    foreground: string,
    assigned: Set<SyntaxEditorRole>,
): void {
    for (const role of SYNTAX_EDITOR_ROLES) {
        if (!scopes.includes(SYNTAX_SCOPE_PREFIX[role])) continue;
        theme.editor[role] = foreground;
        assigned.add(role);
    }
}

/**
 * Maps VS Code `tokenColors` onto Caxri's four editor syntax roles. Only exact selectors count — `keyword.operator`
 * must not overwrite `keyword`. Later exact rules still win. Report both missing roles and valid rules whose scopes
 * Caxri cannot represent so the import warns without counting them as effective mappings. See
 * https://code.visualstudio.com/api/extension-guides/color-theme#syntax-colors.
 */
export function applyVsCodeTokenColors(
    theme: ThemeTokens,
    tokenColors: unknown,
): { missing: SyntaxEditorRole[]; hasOtherSyntaxRules: boolean } {
    if (!Array.isArray(tokenColors))
        return { missing: [...SYNTAX_EDITOR_ROLES], hasOtherSyntaxRules: false };
    const assigned = new Set<SyntaxEditorRole>();
    const mappedScopes = new Set<string>(Object.values(SYNTAX_SCOPE_PREFIX));
    let hasOtherSyntaxRules = false;
    for (const entry of tokenColors) {
        if (!entry || typeof entry !== 'object') continue;
        const rule = entry as { scope?: unknown; settings?: { foreground?: unknown } };
        const scopes = tokenColorScopes(rule.scope);
        const foreground = normalizedHex(rule.settings?.foreground, '');
        if (!foreground) continue;
        if (scopes.length === 0 || scopes.some((scope) => !mappedScopes.has(scope)))
            hasOtherSyntaxRules = true;
        assignMatchingSyntaxRoles(theme, scopes, foreground, assigned);
    }
    return {
        missing: SYNTAX_EDITOR_ROLES.filter((role) => !assigned.has(role)),
        hasOtherSyntaxRules,
    };
}

export function formatMissingSyntaxWarning(missing: readonly SyntaxEditorRole[]): string {
    if (missing.length === SYNTAX_EDITOR_ROLES.length) return 'Syntax colors were not imported.';
    const labels = {
        comment: 'comments',
        keyword: 'keywords',
        string: 'strings',
        number: 'numbers',
    };
    return `Syntax colors for ${missing.map((role) => labels[role]).join(', ')} were not imported.`;
}

export function isLightVsCodeTheme(
    value: Record<string, unknown>,
    editorBackground: string,
): boolean {
    const declared = value.type ?? value.uiTheme;
    if (declared === 'light' || declared === 'vs') return true;
    if (declared === 'dark' || declared === 'vs-dark') return false;
    return contrastRatio(editorBackground, '#000000') > contrastRatio(editorBackground, '#ffffff');
}

/**
 * VS Code's own registry defaults for the list state fills, which is what a theme that declares them in the TypeScript
 * color registry rather than in its JSON actually renders. See
 * `competitors/vscode/src/vs/platform/theme/common/colors/listColors.ts`.
 *
 * `elevated` used to stand in for all four, which is why Dark+ painted hover, keyboard focus, and selection in one
 * identical grey: a keyboard user had nothing at all marking the row they were on. See issue #1006.
 *
 * Focus is the one deviation from the registry. VS Code draws it as an outline (`list.focusOutline`) over no background
 * at all, and Caxri has no outline token for a list row, so focus takes the selection hue at a third of its weight
 * instead. That keeps the three states on one ramp — a neutral wash for the pointer, the selection hue for the
 * keyboard, that hue opaque for the current item — the same shape `dracula.ts` already uses.
 */
const LIST_STATE_FOCUS_ALPHA = '59';
const VSCODE_LIST_STATE_DEFAULTS = {
    dark: {
        activeSelectionBackground: '#04395e',
        activeSelectionForeground: '#ffffff',
        hoverBackground: '#2a2d2e',
        inactiveSelectionBackground: '#37373d',
    },
    light: {
        activeSelectionBackground: '#0060c0',
        activeSelectionForeground: '#ffffff',
        hoverBackground: '#f0f0f0',
        inactiveSelectionBackground: '#e4e6f1',
    },
} as const;

/**
 * Picks the registry defaults by the brightness of the theme's own canvas, so an imported light theme never gets the
 * dark list fills. Derived from the resolved background rather than the theme's declared `type`, because these
 * fallbacks run after `background` is already settled and a mis-declared `type` would be visible here immediately.
 */
function listStateDefaults(background: string): {
    activeSelectionBackground: string;
    activeSelectionForeground: string;
    focusBackground: string;
    hoverBackground: string;
    inactiveSelectionBackground: string;
} {
    const isLight = contrastRatio(background, '#000000') > contrastRatio(background, '#ffffff');
    const defaults = isLight ? VSCODE_LIST_STATE_DEFAULTS.light : VSCODE_LIST_STATE_DEFAULTS.dark;
    return {
        ...defaults,
        focusBackground: `${defaults.activeSelectionBackground}${LIST_STATE_FOCUS_ALPHA}`,
    };
}

export function hasMappedVsCodeColor(colors: Record<string, unknown>): boolean {
    for (const key of VSCODE_MAPPED_COLOR_KEYS) {
        if (normalizedHex(colors[key], '')) return true;
    }
    return false;
}

/**
 * Reads the tab, list, and title-bar state colors, plus the popup shadow.
 *
 * Split out of `parseVsCode` because these nineteen roles share one rule the roles above them do not: each is a state
 * of a specific control, and the fallback is another role already resolved in this same import rather than a
 * per-brightness default. The two-source rows are VS Code's own inheritance — a theme that styles only the focused
 * state means the unfocused one to match, not to fall back to a generic surface.
 *
 * Every value keeps its alpha. `list.hoverBackground` is a translucent wash in most themes, and flattening it would
 * paint an opaque band over the row instead of tinting it.
 *
 * Nothing here writes back into `background`, `surface`, or `elevated`. Those three are the canvas, the chrome, and the
 * popup fill; letting a list-selection color reach `elevated` would repaint every popup in the Workbench, which is the
 * boundary `theme.test.ts`'s "keeps the surface fallback when only tab and title-bar fills are supplied" pins.
 */
export function applyVsCodeControlColors(
    theme: ThemeTokens,
    colors: Record<string, unknown>,
): void {
    const alpha = { preserveAlpha: true };
    const { background, elevated, foreground, muted, surface } = theme.colors;
    const list = listStateDefaults(background);
    theme.colors.tabActiveBackground = firstHex(
        colors,
        ['tab.activeBackground'],
        background,
        alpha,
    );
    theme.colors.tabActiveForeground = firstHex(
        colors,
        ['tab.activeForeground'],
        foreground,
        alpha,
    );
    theme.colors.tabInactiveBackground = firstHex(
        colors,
        ['tab.inactiveBackground'],
        surface,
        alpha,
    );
    theme.colors.tabInactiveForeground = firstHex(colors, ['tab.inactiveForeground'], muted, alpha);
    theme.colors.tabHoverBackground = firstHex(colors, ['tab.hoverBackground'], elevated, alpha);
    theme.colors.tabHoverForeground = firstHex(colors, ['tab.hoverForeground'], foreground, alpha);
    theme.colors.listHoverBackground = firstHex(
        colors,
        ['list.hoverBackground'],
        list.hoverBackground,
        alpha,
    );
    theme.colors.listHoverForeground = firstHex(
        colors,
        ['list.hoverForeground'],
        foreground,
        alpha,
    );
    theme.colors.listFocusBackground = firstHex(
        colors,
        ['list.focusBackground'],
        list.focusBackground,
        alpha,
    );
    theme.colors.listFocusForeground = firstHex(
        colors,
        ['list.focusForeground'],
        foreground,
        alpha,
    );
    theme.colors.listActiveSelectionBackground = firstHex(
        colors,
        ['list.activeSelectionBackground'],
        list.activeSelectionBackground,
        alpha,
    );
    theme.colors.listActiveSelectionForeground = firstHex(
        colors,
        ['list.activeSelectionForeground'],
        /**
         * White rather than the theme's own foreground, because the fallback selection fill is a saturated blue. A
         * theme that declares its own selection background keeps its own foreground fallback through the key above.
         */
        colors['list.activeSelectionBackground'] ? foreground : list.activeSelectionForeground,
        alpha,
    );
    theme.colors.listInactiveSelectionBackground = firstHex(
        colors,
        ['list.inactiveSelectionBackground', 'list.activeSelectionBackground'],
        list.inactiveSelectionBackground,
        alpha,
    );
    theme.colors.listInactiveSelectionForeground = firstHex(
        colors,
        ['list.inactiveSelectionForeground', 'list.activeSelectionForeground'],
        theme.colors.listActiveSelectionForeground,
        alpha,
    );
    theme.colors.titleBarActiveBackground = firstHex(
        colors,
        ['titleBar.activeBackground'],
        surface,
        alpha,
    );
    theme.colors.titleBarActiveForeground = firstHex(
        colors,
        ['titleBar.activeForeground'],
        foreground,
        alpha,
    );
    theme.colors.titleBarInactiveBackground = firstHex(
        colors,
        ['titleBar.inactiveBackground', 'titleBar.activeBackground'],
        theme.colors.titleBarActiveBackground,
        alpha,
    );
    theme.colors.titleBarInactiveForeground = firstHex(
        colors,
        ['titleBar.inactiveForeground', 'titleBar.activeForeground'],
        theme.colors.titleBarActiveForeground,
        alpha,
    );
    theme.colors.shadow = firstHex(colors, ['widget.shadow'], DEFAULT_SHADOW, alpha);
}
