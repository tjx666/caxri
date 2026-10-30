import type { SessionSearchEntry, SessionSearchResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    hasActiveSearchFilters,
    nextProviderFilter,
    nextStatusFilter,
    removeSessionSearchOperator,
    retainedSelectionIndex,
    sessionSearchAction,
    sessionSearchFilterChips,
    sessionSearchFindQuery,
    sessionSearchIndexLabel,
    sessionSearchRelaxationNoticeKey,
    shortFolder,
    snippetSegments,
    sortSessionSearchEntries,
    steppedMatchIndex,
} from '../session-search-model';

const base: SessionSearchEntry = {
    key: 'codex:019a0000-0000-7000-8000-00000000a001',
    title: 'Fix invoice rounding',
    status: 'external',
    provider: 'codex',
    agentSessionId: '019a0000-0000-7000-8000-00000000a001',
    cwd: '/workspace/billing',
    updatedAt: 1,
    match: { field: 'content' },
};

function first() {
    return nextProviderFilter(undefined, 1);
}

describe('Session search model', () => {
    it('cycles the previewed match in both directions', () => {
        expect(steppedMatchIndex(3, 2, 1)).toBe(0);
        expect(steppedMatchIndex(3, 0, -1)).toBe(2);
        expect(steppedMatchIndex(3, 1, 1)).toBe(2);
        expect(steppedMatchIndex(0, 0, 1)).toBe(0);
    });

    it('picks the action from where the conversation lives', () => {
        expect(sessionSearchAction({ ...base, status: 'open', sessionId: 's1' })).toBe('open');
        expect(sessionSearchAction({ ...base, status: 'archived', sessionId: 's1' })).toBe(
            'restore',
        );
        expect(sessionSearchAction(base)).toBe('import');
        // Without a folder there is nowhere to resume the conversation.
        expect(sessionSearchAction({ ...base, cwd: undefined })).toBeUndefined();
    });

    it('hands the opened Chat the pasted phrase when the quote holds it, else the longest matched term', () => {
        const entry: SessionSearchEntry = {
            ...base,
            match: {
                field: 'content',
                snippet: {
                    role: 'assistant',
                    text: 'Even a probe with\nonly 21 tokens waits 30 to 190 seconds.',
                    highlights: [
                        [7, 12],
                        [23, 25],
                        [33, 38],
                    ],
                },
            },
        };
        expect(sessionSearchFindQuery(entry, '  probe with   only 21 ')).toBe('probe with only 21');
        expect(sessionSearchFindQuery(entry, '`probe` with only')).toBe('probe with only');
        expect(sessionSearchFindQuery(entry, 'waits 21 probe')).toBe('probe');
        // A query typed without the message's spaces finds the phrase as the message writes it.
        expect(sessionSearchFindQuery(entry, 'only21tokens')).toBe('only 21 tokens');
        expect(sessionSearchFindQuery(base, 'probe')).toBeUndefined();
    });

    it('treats line breaks in a snippet and in the query like spaces when handing off the phrase', () => {
        const entry: SessionSearchEntry = {
            ...base,
            match: {
                field: 'content',
                snippet: {
                    role: 'assistant',
                    text: 'The first paragraph ends here.\n\nThe second one starts there.',
                    highlights: [],
                },
            },
        };
        expect(sessionSearchFindQuery(entry, 'ends here.\n\nThe second')).toBe(
            'ends here. The second',
        );
    });

    it('lists the parsed operators as chips and removes one from the query text', () => {
        const chips = sessionSearchFilterChips({
            agents: ['codex'],
            projects: ['two words'],
            before: '2026-10-01',
        });
        expect(chips.map(({ key }) => key)).toEqual([
            'agent:codex',
            'project:two words',
            'before:2026-10-01',
        ]);
        const query = 'agent:codex invoice project:"Two Words" before:2026-10-01 rounding';
        expect(removeSessionSearchOperator(query, chips[0])).toBe(
            'invoice project:"Two Words" before:2026-10-01 rounding',
        );
        expect(removeSessionSearchOperator(query, chips[1])).toBe(
            'agent:codex invoice before:2026-10-01 rounding',
        );
        expect(removeSessionSearchOperator(query, chips[2])).toBe(
            'agent:codex invoice project:"Two Words" rounding',
        );
        // An operator the Server left as plain words has no chip and stays.
        expect(removeSessionSearchOperator('agent:foo agent:claude x', chips[0])).toBe(
            'agent:foo agent:claude x',
        );
        expect(sessionSearchFilterChips(undefined)).toEqual([]);
    });

    it('sorts recent first while keeping current-Project conversations ahead', () => {
        const entry = (key: string, updatedAt: number, isCurrentProject?: true) => ({
            ...base,
            key,
            updatedAt,
            ...(isCurrentProject && { isCurrentProject }),
        });
        const entries = [entry('a', 1, true), entry('b', 9), entry('c', 5, true), entry('d', 7)];
        expect(sortSessionSearchEntries(entries, 'relevance')).toBe(entries);
        expect(sortSessionSearchEntries(entries, 'recent').map(({ key }) => key)).toEqual([
            'c',
            'a',
            'b',
            'd',
        ]);
    });

    it('explains only a relaxed search', () => {
        expect(sessionSearchRelaxationNoticeKey('phrase')).toBeUndefined();
        expect(sessionSearchRelaxationNoticeKey(undefined)).toBeUndefined();
        expect(sessionSearchRelaxationNoticeKey('allWords')).toBe(
            'session.search.relaxed.allWords',
        );
        expect(sessionSearchRelaxationNoticeKey('anyWord')).toBe('session.search.relaxed.anyWord');
    });

    it('splits a snippet at its highlights and clamps bad ranges', () => {
        expect(
            snippetSegments({ role: 'user', text: 'fix the invoice total', highlights: [[8, 15]] }),
        ).toEqual([
            { text: 'fix the ', isMatch: false },
            { text: 'invoice', isMatch: true },
            { text: ' total', isMatch: false },
        ]);
        expect(
            snippetSegments({
                role: 'assistant',
                text: 'abc',
                highlights: [
                    [1, 9],
                    [0, 2],
                ],
            }),
        ).toEqual([
            { text: 'a', isMatch: false },
            { text: 'bc', isMatch: true },
        ]);
    });

    it('cycles status filters with Tab in both directions', () => {
        expect(nextStatusFilter('all', 1)).toBe('caxri');
        expect(nextStatusFilter('all', -1)).toBe('external');
    });

    it('cycles the Agent filter with Shift+Tab through All Agents and each provider', () => {
        const first = nextProviderFilter(undefined, 1);
        expect(first).toBeDefined();
        let current = first;
        for (let step = 0; current !== undefined && step < 20; step += 1)
            current = nextProviderFilter(current, 1);
        expect(current).toBeUndefined();
        expect(nextProviderFilter(first, -1)).toBeUndefined();
    });

    it('reports active filters only when one narrows the list', () => {
        expect(hasActiveSearchFilters('all', undefined)).toBe(false);
        expect(hasActiveSearchFilters('archived', undefined)).toBe(true);
        expect(hasActiveSearchFilters('all', first())).toBe(true);
    });

    it('keeps the last two folder segments', () => {
        expect(shortFolder('/workspace/billing')).toBe('/workspace/billing');
        expect(shortFolder('/workspace/clients/acme/billing')).toBe('…/acme/billing');
    });

    it('does not report an index that is still listing files as empty', () => {
        const t = ((key: string, values?: Record<string, number>) =>
            `${key}${values ? JSON.stringify(values) : ''}`) as never;
        const label = (index: SessionSearchResult['index']) =>
            sessionSearchIndexLabel(
                {
                    entries: [],
                    index,
                    usedSubstringScan: false,
                    filters: { agents: [], projects: [] },
                    relaxation: 'phrase',
                },
                t,
            );
        expect(label({ state: 'indexing', conversations: 0, pending: 0 })).toBe(
            'session.search.indexingStarted',
        );
        expect(label({ state: 'indexing', conversations: 10, pending: 4 })).toBe(
            'session.search.indexing{"pending":4}',
        );
        expect(label({ state: 'ready', conversations: 10, pending: 0 })).toBe(
            'session.search.indexed{"count":10}',
        );
    });

    it('keeps the picked conversation selected when a refresh re-ranks the rows', () => {
        const rows = (...keys: string[]) => keys.map((key) => ({ key }));
        expect(retainedSelectionIndex(rows('a', 'b', 'c'), 'c')).toBe(2);
        // A newly indexed match lands above it; the selection moves with the conversation.
        expect(retainedSelectionIndex(rows('new', 'a', 'b', 'c'), 'c')).toBe(3);
        expect(retainedSelectionIndex(rows('a', 'b'), 'c')).toBe(0);
        expect(retainedSelectionIndex(rows('a', 'b'), undefined)).toBe(0);
    });
});
