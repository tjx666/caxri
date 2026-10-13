import type { SessionSearchEntry, SessionSearchResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    nextStatusFilter,
    retainedSelectionIndex,
    sessionSearchAction,
    sessionSearchIndexLabel,
    shortFolder,
    snippetSegments,
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

describe('Session search model', () => {
    it('picks the action from where the conversation lives', () => {
        expect(sessionSearchAction({ ...base, status: 'open', sessionId: 's1' })).toBe('open');
        expect(sessionSearchAction({ ...base, status: 'archived', sessionId: 's1' })).toBe(
            'restore',
        );
        expect(sessionSearchAction(base)).toBe('import');
        // Without a folder there is nowhere to resume the conversation.
        expect(sessionSearchAction({ ...base, cwd: undefined })).toBeUndefined();
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

    it('keeps the last two folder segments', () => {
        expect(shortFolder('/workspace/billing')).toBe('/workspace/billing');
        expect(shortFolder('/workspace/clients/acme/billing')).toBe('…/acme/billing');
    });

    it('does not report an index that is still listing files as empty', () => {
        const t = ((key: string, values?: Record<string, number>) =>
            `${key}${values ? JSON.stringify(values) : ''}`) as never;
        const label = (index: SessionSearchResult['index']) =>
            sessionSearchIndexLabel({ entries: [], index, usedSubstringScan: false }, t);
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
