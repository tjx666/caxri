import type { Translate } from '../../i18n';

/**
 * Curated labels (translated through `settings.themeEditor.token.<key>`) for `themeTokensSchema` keys
 * (`packages/protocol/src/domain/domain.ts`) so the Theme editor never surfaces a raw camelCase JSON key as a field
 * label (DESIGN.md "Settings": plain-language field labels). Unknown keys (a future schema field this map has not been
 * updated for) fall back to a camelCase-to-sentence-case splitter so the UI still degrades to something readable
 * instead of raw JSON.
 */
const THEME_TOKEN_LABEL_KEYS = [
    'accent',
    'background',
    'badge',
    'border',
    'danger',
    'elevated',
    'errorBadge',
    'foreground',
    'gitAdded',
    'gitConflicting',
    'gitDeleted',
    'gitModified',
    'gitUntracked',
    'merged',
    'chart',
    'muted',
    'selection',
    'success',
    'surface',
    'warning',
    'warningBadge',
    'black',
    'blue',
    'brightBlack',
    'brightBlue',
    'brightCyan',
    'brightGreen',
    'brightMagenta',
    'brightRed',
    'brightWhite',
    'brightYellow',
    'cursor',
    'cyan',
    'green',
    'magenta',
    'red',
    'selectionBackground',
    'white',
    'yellow',
    'comment',
    'keyword',
    'lineHighlight',
    'number',
    'string',
] as const;

type ThemeTokenLabelKey = (typeof THEME_TOKEN_LABEL_KEYS)[number];

const themeTokenLabelKeys: ReadonlySet<string> = new Set(THEME_TOKEN_LABEL_KEYS);

function isThemeTokenLabelKey(key: string): key is ThemeTokenLabelKey {
    return themeTokenLabelKeys.has(key);
}

/**
 * Splits an unmapped camelCase key into sentence case (`lineHighlight` -> `Line highlight`) as the last-resort fallback
 * for keys `THEME_TOKEN_LABEL_KEYS` has not been updated for.
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
export function humanizeThemeTokenLabel(t: Translate, key: string): string {
    return isThemeTokenLabelKey(key)
        ? t(`settings.themeEditor.token.${key}`)
        : splitCamelCaseToSentenceCase(key);
}
