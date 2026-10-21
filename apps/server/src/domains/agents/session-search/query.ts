import type { SessionSearchMatchField, SessionSearchSnippet } from '@caxri/protocol';
import { normalizeSessionSearchText } from '@caxri/protocol';

/**
 * Trigram full-text search needs three characters; a shorter term is matched as a plain substring instead.
 */
const MIN_INDEXED_TERM_LENGTH = 3;
const MAX_TERMS = 8;
/**
 * A conversation ID fragment shorter than this matches too many IDs by chance to rank as an ID match.
 */
const MIN_ID_FRAGMENT_LENGTH = 4;
const SNIPPET_LEADING_CHARACTERS = 40;
const MAX_SNIPPET_CHARACTERS = 200;
const HIGHLIGHT_START = '\u{1}';
const HIGHLIGHT_END = '\u{2}';
const ELLIPSIS = '…';

export interface ParsedSessionQuery {
    /**
     * Lower-cased terms that must all match.
     */
    terms: string[];
    /**
     * FTS5 expression requiring every term of at least three characters; absent when every term is shorter.
     */
    ftsQuery?: string;
    /**
     * Terms too short for the trigram index, matched with `LIKE`.
     */
    substrings: string[];
}

function characterLength(text: string): number {
    return [...text].length;
}

export function parseSessionQuery(query: string): ParsedSessionQuery {
    const terms = [
        ...new Set(
            normalizeSessionSearchText(query).trim().toLowerCase().split(/\s+/u).filter(Boolean),
        ),
    ].slice(0, MAX_TERMS);
    const indexed = terms.filter((term) => characterLength(term) >= MIN_INDEXED_TERM_LENGTH);
    return {
        terms,
        // A quoted FTS5 string is a literal phrase; a doubled quote escapes a quote inside it.
        ...(indexed.length > 0 && {
            ftsQuery: indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(' '),
        }),
        substrings: terms.filter((term) => characterLength(term) < MIN_INDEXED_TERM_LENGTH),
    };
}

/**
 * The part of a folder a plain term matches: its last two segments, which is all a result row shows. A deeper segment
 * such as a worktree container or a home directory would otherwise match every conversation under it, as a folder match
 * the user cannot see. A term containing a separator is a pasted path and matches the whole folder.
 */
function isFolderMatch(cwd: string, term: string): boolean {
    if (term.includes('/')) return cwd.includes(term);
    return cwd.split('/').filter(Boolean).slice(-2).join('/').includes(term);
}

/**
 * Which metadata field a conversation matched on, if every term occurs in its title, folder, or ID together. An ID
 * match needs one term long enough to identify a conversation, so a pasted ID ranks first.
 */
export function metadataMatch(
    terms: readonly string[],
    fields: { title?: string; cwd?: string; ids: readonly string[] },
): Exclude<SessionSearchMatchField, 'content' | 'recent'> | undefined {
    const title = fields.title?.toLowerCase() ?? '';
    const cwd = fields.cwd?.toLowerCase() ?? '';
    const ids = fields.ids.map((id) => id.toLowerCase());
    if (
        terms.length === 1 &&
        terms[0].length >= MIN_ID_FRAGMENT_LENGTH &&
        ids.some((id) => id.includes(terms[0]))
    )
        return 'id';
    if (terms.every((term) => title.includes(term))) return 'title';
    if (terms.every((term) => isFolderMatch(cwd, term))) return 'path';
    if (terms.every((term) => title.includes(term) || isFolderMatch(cwd, term))) return 'title';
    return undefined;
}

/**
 * Collapses whitespace in an FTS5 `snippet()` result and converts its control-character markers to highlight ranges.
 */
export function snippetFromMarkers(
    role: SessionSearchSnippet['role'],
    marked: string,
): SessionSearchSnippet {
    const collapsed = marked.replaceAll(/\s+/gu, ' ').trim();
    const highlights: Array<[number, number]> = [];
    let text = '';
    let start: number | undefined;
    for (const character of collapsed) {
        if (character === HIGHLIGHT_START) start = text.length;
        else if (character === HIGHLIGHT_END) {
            if (start !== undefined && text.length > start) highlights.push([start, text.length]);
            start = undefined;
        } else text += character;
    }
    return bounded({ role, text, highlights });
}

/**
 * The excerpt around a substring match, for a query whose terms were all too short for the full-text index.
 */
export function snippetAround(
    role: SessionSearchSnippet['role'],
    messageText: string,
    terms: readonly string[],
): SessionSearchSnippet {
    const text = messageText.replaceAll(/\s+/gu, ' ').trim();
    const lower = text.toLowerCase();
    const first = Math.min(
        ...terms.map((term) => {
            const index = lower.indexOf(term);
            return index === -1 ? Infinity : index;
        }),
    );
    const begin = Number.isFinite(first) ? Math.max(0, first - SNIPPET_LEADING_CHARACTERS) : 0;
    const prefix = begin > 0 ? ELLIPSIS : '';
    const window = `${prefix}${text.slice(begin, begin + MAX_SNIPPET_CHARACTERS)}`;
    const windowLower = window.toLowerCase();
    const highlights: Array<[number, number]> = [];
    for (const term of terms) {
        for (
            let index = windowLower.indexOf(term);
            index !== -1;
            index = windowLower.indexOf(term, index + term.length)
        )
            highlights.push([index, index + term.length]);
    }
    highlights.sort((left, right) => left[0] - right[0]);
    return bounded({ role, text: window, highlights: mergeRanges(highlights) });
}

function mergeRanges(ranges: ReadonlyArray<[number, number]>): Array<[number, number]> {
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }
    return merged;
}

/**
 * Keeps the snippet inside the protocol's bounds without splitting a highlight.
 */
function bounded(snippet: SessionSearchSnippet): SessionSearchSnippet {
    const limit = MAX_SNIPPET_CHARACTERS + SNIPPET_LEADING_CHARACTERS;
    const text =
        snippet.text.length > limit
            ? `${snippet.text.slice(0, limit - 1)}${ELLIPSIS}`
            : snippet.text;
    return {
        role: snippet.role,
        text,
        highlights: snippet.highlights
            .filter(([, end]) => end <= text.length - (text === snippet.text ? 0 : 1))
            .slice(0, 32),
    };
}
