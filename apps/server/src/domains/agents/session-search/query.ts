import type {
    AgentProvider,
    SessionSearchFilters,
    SessionSearchMatchField,
    SessionSearchPreviewMessage,
    SessionSearchSnippet,
} from '@caxri/protocol';
import {
    agentProviderIds,
    MAX_SESSION_SEARCH_PREVIEW_MESSAGE_CHARACTERS,
    normalizeSessionSearchText,
    SESSION_SEARCH_OPERATOR_PATTERN,
} from '@caxri/protocol';

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
/**
 * Chinese, Japanese, and Korean text is written without spaces around numbers and Latin words ("21 个 token"), while the
 * same sentence elsewhere may carry them ("21 个 token"), so a query term splits where a CJK run meets other text.
 */
const SCRIPT_RUN_PATTERN =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

const MAX_PROJECT_FILTERS = 8;
const MAX_PROJECT_FILTER_LENGTH = 200;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export interface SessionSearchOperators {
    /**
     * The query with every recognized operator removed: what the term search runs on.
     */
    text: string;
    /**
     * The recognized operators, shaped for the response so the Renderer can show them.
     */
    filters: SessionSearchFilters;
    /**
     * Local midnight of the `before:` day: only conversations updated earlier match.
     */
    beforeMs?: number;
    /**
     * Local midnight of the `after:` day: only conversations updated at or after it match.
     */
    afterMs?: number;
}

/**
 * A `YYYY-MM-DD` that names a real calendar day, as local midnight; undefined for anything else ("2026-02-31").
 */
function localDayStart(value: string): number | undefined {
    const match = DATE_PATTERN.exec(value);
    if (!match) return undefined;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(year, month - 1, day);
    const isReal =
        date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    return isReal ? date.getTime() : undefined;
}

/**
 * Splits `agent:`, `project:`, `before:`, and `after:` operators out of a query, as agentsview's search does. An
 * operator with a value it cannot use (an unknown agent, a malformed or impossible date, an empty project) stays in the
 * text, so a pasted `agent:foo` is still searchable as words. Repeated `agent:` and `project:` operators widen the
 * filter; a repeated date keeps the last one.
 */
export function parseSessionOperators(query: string): SessionSearchOperators {
    const agents: AgentProvider[] = [];
    const projects: string[] = [];
    let before: string | undefined;
    let after: string | undefined;
    let beforeMs: number | undefined;
    let afterMs: number | undefined;
    const text = query
        .replaceAll(
            SESSION_SEARCH_OPERATOR_PATTERN,
            (
                whole: string,
                lead: string,
                name: string,
                quoted: string | undefined,
                bare: string | undefined,
            ) => {
                const value = (quoted ?? bare ?? '').trim();
                switch (name.toLowerCase()) {
                    case 'agent': {
                        const provider = agentProviderIds.find((id) => id === value.toLowerCase());
                        if (!provider) return whole;
                        if (!agents.includes(provider)) agents.push(provider);
                        return lead;
                    }
                    case 'project': {
                        if (!value || value.length > MAX_PROJECT_FILTER_LENGTH) return whole;
                        if (projects.length >= MAX_PROJECT_FILTERS) return lead;
                        const lower = value.toLowerCase();
                        if (!projects.includes(lower)) projects.push(lower);
                        return lead;
                    }
                    default: {
                        const start = localDayStart(value);
                        if (start === undefined) return whole;
                        if (name.toLowerCase() === 'before') {
                            before = value;
                            beforeMs = start;
                        } else {
                            after = value;
                            afterMs = start;
                        }
                        return lead;
                    }
                }
            },
        )
        .replaceAll(/\s+/gu, ' ')
        .trim();
    return {
        text,
        filters: {
            agents,
            projects,
            ...(before !== undefined && { before }),
            ...(after !== undefined && { after }),
        },
        ...(beforeMs !== undefined && { beforeMs }),
        ...(afterMs !== undefined && { afterMs }),
    };
}

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
    /**
     * The whole query without whitespace, when it has several terms: a message holding it contiguously (spacing aside)
     * is the sentence the user pasted or remembers, and outranks one that merely holds the terms apart.
     */
    phrase?: string;
}

function characterLength(text: string): number {
    return [...text].length;
}

export function parseSessionQuery(query: string): ParsedSessionQuery {
    const normalized = normalizeSessionSearchText(query).trim().toLowerCase();
    const words = normalized.split(/\s+/u).filter(Boolean);
    const terms = [...new Set(words.flatMap((word) => word.match(SCRIPT_RUN_PATTERN) ?? []))].slice(
        0,
        MAX_TERMS,
    );
    const indexed = terms.filter((term) => characterLength(term) >= MIN_INDEXED_TERM_LENGTH);
    return {
        terms,
        ...(terms.length > 1 && { phrase: words.join('') }),
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
    mode: 'all' | 'any' = 'all',
): Exclude<SessionSearchMatchField, 'content' | 'recent'> | undefined {
    const title = fields.title?.toLowerCase() ?? '';
    const cwd = fields.cwd?.toLowerCase() ?? '';
    const ids = fields.ids.map((id) => id.toLowerCase());
    /**
     * `any` is the last relaxation step: one matching word is enough, in whichever field holds it.
     */
    const holds = (isMatch: (term: string) => boolean) =>
        mode === 'all' ? terms.every((term) => isMatch(term)) : terms.some((term) => isMatch(term));
    if (
        terms.length === 1 &&
        terms[0].length >= MIN_ID_FRAGMENT_LENGTH &&
        ids.some((id) => id.includes(terms[0]))
    )
        return 'id';
    if (holds((term) => title.includes(term))) return 'title';
    if (holds((term) => isFolderMatch(cwd, term))) return 'path';
    if (holds((term) => title.includes(term) || isFolderMatch(cwd, term))) return 'title';
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
 * Where `phrase` (which holds no whitespace) starts in `lower`, ignoring the whitespace inside `lower`.
 */
function phraseIndex(lower: string, phrase: string): number {
    const characters = lower.matchAll(/\S/gu).toArray();
    // One entry per UTF-16 unit, so an index into the compact text maps back to `lower`.
    const positions = characters.flatMap(({ 0: character, index }) =>
        Array.from({ length: character.length }, (_, offset) => index + offset),
    );
    const index = characters
        .map(([character]) => character)
        .join('')
        .indexOf(phrase);
    return index === -1 ? Infinity : positions[index];
}

/**
 * The excerpt around a match in one message: around the phrase when the message holds it, otherwise around the first
 * term, with every term highlighted.
 */
export function snippetAround(
    role: SessionSearchSnippet['role'],
    messageText: string,
    terms: readonly string[],
    phrase?: string,
): SessionSearchSnippet {
    const text = messageText.replaceAll(/\s+/gu, ' ').trim();
    const lower = text.toLowerCase();
    const anchor = phrase === undefined ? Infinity : phraseIndex(lower, phrase);
    const first = Number.isFinite(anchor)
        ? anchor
        : Math.min(
              ...terms.map((term) => {
                  const index = lower.indexOf(term);
                  return index === -1 ? Infinity : index;
              }),
          );
    const begin = Number.isFinite(first) ? Math.max(0, first - SNIPPET_LEADING_CHARACTERS) : 0;
    const prefix = begin > 0 ? ELLIPSIS : '';
    const window = `${prefix}${text.slice(begin, begin + MAX_SNIPPET_CHARACTERS)}`;
    return bounded({ role, text: window, highlights: termRanges(window, terms) });
}

/**
 * One message of the preview: whole when it fits, otherwise cut around its first matched term with an ellipsis on each
 * cut side. Line breaks stay (the preview renders them), unlike a result row's one-line snippet.
 */
export function previewMessage(
    role: SessionSearchPreviewMessage['role'],
    messageText: string,
    terms: readonly string[],
    isMatch: boolean,
): SessionSearchPreviewMessage {
    const full = messageText.replaceAll('\r\n', '\n').trim();
    const limit = MAX_SESSION_SEARCH_PREVIEW_MESSAGE_CHARACTERS;
    let text = full;
    if (full.length > limit) {
        const lower = full.toLowerCase();
        const found = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
        const anchor = found.length > 0 ? Math.min(...found) : 0;
        const begin = Math.max(0, Math.min(anchor - 120, full.length - limit));
        const end = Math.min(full.length, begin + limit);
        text = `${begin > 0 ? ELLIPSIS : ''}${full.slice(begin, end)}${end < full.length ? ELLIPSIS : ''}`;
    }
    return { role, text, highlights: termRanges(text, terms).slice(0, 64), isMatch };
}

/**
 * Adds highlights for `terms` to an FTS5 snippet, whose own markers cover only the terms the full-text index matched: a
 * short term such as a number or a single Chinese character is found by substring and would otherwise stay plain.
 */
export function withTermHighlights(
    snippet: SessionSearchSnippet,
    terms: readonly string[],
): SessionSearchSnippet {
    const ranges = [...snippet.highlights, ...termRanges(snippet.text, terms)].toSorted(
        (left, right) => left[0] - right[0],
    );
    return { ...snippet, highlights: mergeRanges(ranges).slice(0, 32) };
}

function termRanges(text: string, terms: readonly string[]): Array<[number, number]> {
    const lower = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const term of terms) {
        for (
            let index = lower.indexOf(term);
            index !== -1;
            index = lower.indexOf(term, index + term.length)
        )
            ranges.push([index, index + term.length]);
    }
    return mergeRanges(ranges.toSorted((left, right) => left[0] - right[0]));
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
