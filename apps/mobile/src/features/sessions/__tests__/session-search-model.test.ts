import { describe, expect, it } from 'vitest';

import {
    sessionSearchEmptyKey,
    sessionSearchIndexNotice,
    sessionSearchMatchLabel,
    sessionSearchRowAction,
} from '../session-search-model';

const ready = (state: 'indexing' | 'ready' | 'unavailable', pending = 0) => ({
    entries: [],
    index: { state, conversations: 10, pending },
    relaxation: 'phrase' as const,
});

describe('Session search model', () => {
    it('opens an open Session and restores an archived one only from a control device', () => {
        expect(sessionSearchRowAction({ status: 'open' }, 'view')).toBe('open');
        expect(sessionSearchRowAction({ status: 'archived' }, 'control')).toBe('restore');
        expect(sessionSearchRowAction({ status: 'archived' }, 'reply')).toBeUndefined();
        expect(sessionSearchRowAction({ status: 'archived' }, null)).toBeUndefined();
    });

    it('explains an empty list by what was searched and the index state', () => {
        expect(sessionSearchEmptyKey('', ready('ready'))).toBe('sessions.search.noSessions');
        expect(sessionSearchEmptyKey('invoice', ready('ready'))).toBe('sessions.search.noResults');
        expect(sessionSearchEmptyKey('invoice', ready('indexing', 3))).toBe(
            'sessions.search.emptyWhileIndexing',
        );
    });

    it('reports index progress and an unavailable index', () => {
        expect(sessionSearchIndexNotice(ready('ready'))).toBeUndefined();
        expect(sessionSearchIndexNotice(ready('indexing', 3))).toBe(
            'Indexing history: 3 conversations left',
        );
        expect(sessionSearchIndexNotice(ready('unavailable'))).toBe(
            'History index unavailable; searching Session titles only',
        );
    });

    it('labels only matches the title does not explain', () => {
        expect(sessionSearchMatchLabel({ match: { field: 'title' } })).toBeUndefined();
        expect(sessionSearchMatchLabel({ match: { field: 'path' } })).toBe('Folder match');
        expect(sessionSearchMatchLabel({ match: { field: 'id' } })).toBe('ID match');
    });
});
