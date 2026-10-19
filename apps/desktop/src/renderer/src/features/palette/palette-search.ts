import { defaultFilter } from 'cmdk';

/**
 * The text one palette row is found by, split by how strongly a match in it should rank.
 */
export interface PaletteSearchEntry {
    /**
     * The row's name as shown, plus its English catalog name in another UI language.
     */
    readonly titles: readonly string[];
    /**
     * Short identifiers a user may type instead: keywords, the command id, the category.
     */
    readonly terms?: readonly string[];
    /**
     * Longer text that may still match: descriptions, Project names, root paths, ids.
     */
    readonly details?: readonly string[];
}

/**
 * Match strength tiers. A word-prefix hit in a title always outranks anything in the keywords, which always outranks
 * descriptions and paths; a scattered fuzzy hit stays below all of them.
 */
const SCORE = {
    titleExact: 1,
    titlePrefix: 0.95,
    titleWord: 0.9,
    termWord: 0.75,
    titleSubstring: 0.65,
    detailWord: 0.5,
    substring: 0.4,
    fuzzyCeiling: 0.3,
} as const;

const HAN_OR_KANA = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Splits on separators and camelCase boundaries, so `session.compactWarm` offers `compact` and `warm` as words.
 */
function words(text: string): string[] {
    return text
        .replaceAll(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

function hasWordStartingWith(text: string, token: string): boolean {
    return words(text).some((word) => word.startsWith(token));
}

/**
 * CJK text has no spaces between words, so a contiguous hit anywhere in it is the word-level match.
 */
function isWordMatch(text: string, token: string): boolean {
    return HAN_OR_KANA.test(token)
        ? text.toLowerCase().includes(token)
        : hasWordStartingWith(text, token);
}

function tokenScore(entry: PaletteSearchEntry, token: string): number {
    const { titles, terms = [], details = [] } = entry;
    if (titles.some((title) => title.toLowerCase().startsWith(token))) return SCORE.titlePrefix;
    if (titles.some((title) => isWordMatch(title, token))) return SCORE.titleWord;
    if (terms.some((term) => isWordMatch(term, token))) return SCORE.termWord;
    if (titles.some((title) => title.toLowerCase().includes(token))) return SCORE.titleSubstring;
    if (details.some((detail) => isWordMatch(detail, token))) return SCORE.detailWord;
    if ([...terms, ...details].some((text) => text.toLowerCase().includes(token)))
        return SCORE.substring;
    const fuzzy = Math.max(0, ...titles.map((title) => defaultFilter(title, token)));
    return fuzzy * SCORE.fuzzyCeiling;
}

/**
 * Ranks a palette row for a query; 0 hides it. Every whitespace-separated token must match somewhere, and the row ranks
 * by its weakest token. cmdk's default scorer matched a fuzzy subsequence over one joined string, so `compa` ranked a
 * Session whose path held those letters, or `Command Palette`, level with or above the command literally named
 * "Compact".
 */
export function paletteSearchScore(entry: PaletteSearchEntry | undefined, query: string): number {
    const normalized = query.trim().toLowerCase();
    if (!entry || !normalized) return 1;
    if (entry.titles.some((title) => title.toLowerCase() === normalized)) return SCORE.titleExact;
    let score: number = SCORE.titleExact;
    for (const token of normalized.split(/\s+/u)) {
        score = Math.min(score, tokenScore(entry, token));
        if (score === 0) return 0;
    }
    return score;
}
