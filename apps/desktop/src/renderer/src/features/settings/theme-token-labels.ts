/**
 * Curated labels for `themeTokensSchema` keys (`packages/protocol/src/domain/domain.ts`) so the Theme editor never
 * surfaces a raw camelCase JSON key as a field label (DESIGN.md "Settings": plain-language field labels). Unknown keys
 * (a future schema field this map has not been updated for) fall back to a camelCase-to-sentence-case splitter so the
 * UI still degrades to something readable instead of raw JSON.
 */
const THEME_TOKEN_LABELS: Readonly<Record<string, string>> = {
    // colors
    accent: 'Accent',
    background: 'Background',
    badge: 'Badge',
    border: 'Border',
    danger: 'Danger',
    elevated: 'Elevated',
    errorBadge: 'Error badge',
    foreground: 'Foreground',
    gitAdded: 'Added file',
    gitConflicting: 'Conflicting file',
    gitDeleted: 'Deleted file',
    gitModified: 'Modified file',
    gitUntracked: 'Untracked file',
    merged: 'Merged',
    chart: 'Chart',
    muted: 'Muted',
    selection: 'Selection',
    success: 'Success',
    surface: 'Surface',
    warning: 'Warning',
    warningBadge: 'Warning badge',
    // terminal (ANSI palette plus terminal-only fields)
    black: 'Black',
    blue: 'Blue',
    brightBlack: 'Bright black',
    brightBlue: 'Bright blue',
    brightCyan: 'Bright cyan',
    brightGreen: 'Bright green',
    brightMagenta: 'Bright magenta',
    brightRed: 'Bright red',
    brightWhite: 'Bright white',
    brightYellow: 'Bright yellow',
    cursor: 'Cursor',
    cyan: 'Cyan',
    green: 'Green',
    magenta: 'Magenta',
    red: 'Red',
    selectionBackground: 'Selection background',
    white: 'White',
    yellow: 'Yellow',
    // editor
    comment: 'Comment',
    keyword: 'Keyword',
    lineHighlight: 'Line highlight',
    number: 'Number',
    string: 'String',
};

/**
 * Splits an unmapped camelCase key into sentence case (`lineHighlight` -> `Line highlight`) as the last-resort fallback
 * for keys `THEME_TOKEN_LABELS` has not been updated for.
 */
function splitCamelCaseToSentenceCase(key: string): string {
    const words = key
        .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(' ')
        .filter(Boolean);
    if (words.length === 0) return key;
    const [first, ...rest] = words;
    return [first[0].toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * Resolves a plain-language label for a theme token key, preferring the curated map and falling back to a camelCase
 * splitter for keys the map has not been updated for.
 */
export function humanizeThemeTokenLabel(key: string): string {
    return THEME_TOKEN_LABELS[key] ?? splitCamelCaseToSentenceCase(key);
}
