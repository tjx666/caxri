import type {
    AgentProvider,
    SessionSearchEntry,
    SessionSearchFilters,
    SessionSearchRelaxation,
    SessionSearchResult,
    SessionSearchSnippet,
    SessionSearchStatusFilter,
} from '@caxri/protocol';
import {
    agentProviderIds,
    normalizeSessionSearchText,
    normalizeSessionSearchWhitespace,
    SESSION_SEARCH_OPERATOR_PATTERN,
    sessionSearchStatusFilters,
} from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * What Enter does on a row: open a Session, restore an archived one and open it, or add an external conversation to
 * Caxri as a new Session. An external conversation without a folder has nowhere to resume, so it has no action.
 */
export type SessionSearchAction = 'open' | 'restore' | 'import';

export function sessionSearchAction(entry: SessionSearchEntry): SessionSearchAction | undefined {
    if (entry.status === 'open') return entry.sessionId ? 'open' : undefined;
    if (entry.status === 'archived') return entry.sessionId ? 'restore' : undefined;
    return entry.cwd && entry.provider && entry.agentSessionId ? 'import' : undefined;
}

export interface SnippetSegment {
    text: string;
    isMatch: boolean;
}

/**
 * Splits a snippet at its highlight ranges. Ranges arrive sorted and disjoint from the Server; anything out of bounds
 * or overlapping is clamped rather than trusted, so a bad range can never drop text.
 */
export function snippetSegments(snippet: SessionSearchSnippet): SnippetSegment[] {
    const segments: SnippetSegment[] = [];
    let cursor = 0;
    for (const [rawStart, rawEnd] of snippet.highlights) {
        const start = Math.max(cursor, Math.min(rawStart, snippet.text.length));
        const end = Math.max(start, Math.min(rawEnd, snippet.text.length));
        if (start > cursor)
            segments.push({ text: snippet.text.slice(cursor, start), isMatch: false });
        if (end > start) segments.push({ text: snippet.text.slice(start, end), isMatch: true });
        cursor = end;
    }
    if (cursor < snippet.text.length)
        segments.push({ text: snippet.text.slice(cursor), isMatch: false });
    return segments;
}

/**
 * The part of `text` that spells `phrase` once whitespace is ignored on both sides, as the message writes it.
 */
function phraseInText(text: string, phrase: string): string | undefined {
    const compactPhrase = phrase.replaceAll(/\s+/gu, '').toLowerCase();
    if (!compactPhrase) return undefined;
    const characters = text.toLowerCase().matchAll(/\S/gu).toArray();
    // One entry per UTF-16 unit, so an index into the compact text maps back to `text`.
    const positions = characters.flatMap(({ 0: character, index }) =>
        Array.from({ length: character.length }, (_, offset) => index + offset),
    );
    const start = characters
        .map(([character]) => character)
        .join('')
        .indexOf(compactPhrase);
    if (start === -1) return undefined;
    return text.slice(positions[start], positions[start + compactPhrase.length - 1] + 1);
}

/**
 * What find in the opened Chat searches for, so a message match lands on that message: the whole query when the quoted
 * message holds it as one phrase (a pasted sentence, or "21 个 token" for "21 个 token"), written as the message spaces
 * it, otherwise the longest matched term the quote shows. Undefined when the row did not match on message text. Find
 * searches rendered text, so Markdown markers are dropped the way the index drops them.
 */
export function sessionSearchFindQuery(
    entry: SessionSearchEntry,
    query: string,
): string | undefined {
    const { snippet } = entry.match;
    if (!snippet || !entry.agentSessionId) return undefined;
    const phrase = phraseInText(
        normalizeSessionSearchWhitespace(snippet.text),
        normalizeSessionSearchText(query),
    );
    if (phrase) return normalizeSessionSearchWhitespace(phrase);
    return snippetSegments(snippet)
        .filter((segment) => segment.isMatch)
        .map((segment) => segment.text)
        .reduce<string | undefined>(
            (longest, text) => (longest && longest.length >= text.length ? longest : text),
            undefined,
        );
}

/**
 * Tab steps through the status filters and wraps, the quickest way to narrow a result list without leaving the input.
 */
export function nextStatusFilter(
    current: SessionSearchStatusFilter,
    delta: 1 | -1,
): SessionSearchStatusFilter {
    const index = sessionSearchStatusFilters.indexOf(current);
    const count = sessionSearchStatusFilters.length;
    return sessionSearchStatusFilters[(index + delta + count) % count];
}

export const sessionSearchProviders: readonly AgentProvider[] = agentProviderIds;

/**
 * Shift+Tab steps through the Agent filter (All Agents, then each provider) and wraps, so both filter groups are
 * reachable from the input without leaving the keyboard.
 */
export function nextProviderFilter(
    current: AgentProvider | undefined,
    delta: 1 | -1,
): AgentProvider | undefined {
    const options: ReadonlyArray<AgentProvider | undefined> = [
        undefined,
        ...sessionSearchProviders,
    ];
    const index = options.indexOf(current);
    return options[(index + delta + options.length) % options.length];
}

/**
 * Whether either filter group narrows the list, which decides if an empty result can offer "Clear filters".
 */
export function hasActiveSearchFilters(
    status: SessionSearchStatusFilter,
    provider: AgentProvider | undefined,
): boolean {
    return status !== 'all' || provider !== undefined;
}

export function nextSelectionIndex(count: number, current: number, delta: number): number {
    if (count === 0) return 0;
    return Math.max(0, Math.min(current + delta, count - 1));
}

/**
 * The next match to preview: steps `delta` through `count` matches and wraps at either end, so the preview cycles.
 */
export function steppedMatchIndex(count: number, current: number, delta: number): number {
    if (count === 0) return 0;
    return (((current + delta) % count) + count) % count;
}

/**
 * The footer's index line: progress while the background index catches up, the indexed count once it has, and a plain
 * statement when only Caxri's own Sessions could be searched.
 */
export function sessionSearchIndexLabel(result: SessionSearchResult, t: Translate): string {
    const { index } = result;
    if (index.state === 'unavailable') return t('session.search.unavailable');
    // A first pass is still listing transcript files before it knows how many remain.
    if (index.state === 'indexing')
        return index.pending > 0
            ? t('session.search.indexing', { pending: index.pending })
            : t('session.search.indexingStarted');
    return t('session.search.indexed', { count: index.conversations });
}

/**
 * A folder's last two segments, which tell Projects and worktrees apart in a dense row; the full path is the row's
 * tooltip.
 */
export function shortFolder(path: string): string {
    const segments = path.split('/').filter(Boolean);
    return segments.length <= 2 ? path : `…/${segments.slice(-2).join('/')}`;
}

/**
 * The row of the selected conversation in a refreshed result list, or the best match when it is gone or none was
 * picked.
 */
export function retainedSelectionIndex(
    entries: ReadonlyArray<Pick<SessionSearchEntry, 'key'>>,
    selectedKey: string | undefined,
): number {
    return Math.max(
        0,
        entries.findIndex((entry) => entry.key === selectedKey),
    );
}

/**
 * How the result list is ordered: the Server's ranking, or newest conversation first.
 */
export const sessionSearchSorts = ['relevance', 'recent'] as const;
export type SessionSearchSort = (typeof sessionSearchSorts)[number];

/**
 * Whether results from the current Project lead the list (the Server's hint) or every Project ranks alike.
 */
export const sessionSearchScopes = ['currentProject', 'allProjects'] as const;
export type SessionSearchScope = (typeof sessionSearchScopes)[number];

/**
 * Orders the Server's results. Relevance keeps the Server's order. Recent sorts by last activity, newest first, and
 * keeps current-Project conversations ahead of the rest, so the scope toggle means the same under both sorts.
 */
export function sortSessionSearchEntries(
    entries: readonly SessionSearchEntry[],
    sort: SessionSearchSort,
): readonly SessionSearchEntry[] {
    if (sort === 'relevance') return entries;
    return entries.toSorted(
        (left, right) =>
            Number(right.isCurrentProject ?? false) - Number(left.isCurrentProject ?? false) ||
            right.updatedAt - left.updatedAt,
    );
}

/**
 * One filter operator the Server parsed out of the query, shown as a removable chip.
 */
export interface SessionSearchFilterChip {
    /**
     * Stable identity: kind plus value.
     */
    key: string;
    kind: 'agent' | 'project' | 'before' | 'after';
    value: string;
}

/**
 * The chips for a result's parsed operators, in the order the filter bar reads them.
 */
export function sessionSearchFilterChips(
    filters: SessionSearchFilters | undefined,
): SessionSearchFilterChip[] {
    if (!filters) return [];
    const chip = (kind: SessionSearchFilterChip['kind'], value: string) => ({
        key: `${kind}:${value}`,
        kind,
        value,
    });
    return [
        ...filters.agents.map((agent) => chip('agent', agent)),
        ...filters.projects.map((project) => chip('project', project)),
        ...(filters.after === undefined ? [] : [chip('after', filters.after)]),
        ...(filters.before === undefined ? [] : [chip('before', filters.before)]),
    ];
}

/**
 * The query without the operator a chip stands for. Agent and Project operators match by value (the Server lower-cases
 * both); a date operator is removed whatever its date, since a repeated date keeps only the last one. Operators the
 * Server did not recognize are plain words and stay.
 */
export function removeSessionSearchOperator(query: string, chip: SessionSearchFilterChip): string {
    const removed = query.replaceAll(
        SESSION_SEARCH_OPERATOR_PATTERN,
        (
            whole: string,
            lead: string,
            name: string,
            quoted: string | undefined,
            bare: string | undefined,
        ) => {
            if (name.toLowerCase() !== chip.kind) return whole;
            const isDate = chip.kind === 'before' || chip.kind === 'after';
            const value = (quoted ?? bare ?? '').trim().toLowerCase();
            return isDate || value === chip.value.toLowerCase() ? lead : whole;
        },
    );
    return normalizeSessionSearchWhitespace(removed);
}

const relaxationNoticeKeys = {
    phrase: undefined,
    allWords: 'session.search.relaxed.allWords',
    anyWord: 'session.search.relaxed.anyWord',
} as const satisfies Record<SessionSearchRelaxation, string | undefined>;

/**
 * The notice explaining a loosened search, or undefined when the query was matched as typed.
 */
export function sessionSearchRelaxationNoticeKey(
    relaxation: SessionSearchRelaxation | undefined,
): 'session.search.relaxed.allWords' | 'session.search.relaxed.anyWord' | undefined {
    return relaxation && relaxationNoticeKeys[relaxation];
}
