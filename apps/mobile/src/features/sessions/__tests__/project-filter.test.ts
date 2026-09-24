import { describe, expect, it } from 'vitest';

import type { SessionListEntry } from '../hooks/use-session-polling';
import { activeProjectFilter, filterSessionEntries } from '../project-filter';

describe('filterSessionEntries', () => {
    const entries = [
        { id: 'header:attention', label: 'NEEDS ATTENTION', type: 'header' },
        { id: 'one', session: { projectId: 'alpha' }, type: 'session' },
        { id: 'header:running', label: 'RUNNING', type: 'header' },
        { id: 'two', session: { projectId: 'beta' }, type: 'session' },
        { id: 'header:recent', label: 'RECENT', type: 'header' },
        { id: 'three', session: { projectId: 'alpha' }, type: 'session' },
    ] as SessionListEntry[];

    it('keeps the original grouped list for All', () => {
        expect(filterSessionEntries(entries, null)).toBe(entries);
    });

    it('removes empty group headers without changing the surviving group order', () => {
        expect(filterSessionEntries(entries, 'beta').map(({ id }) => id)).toEqual([
            'header:running',
            'two',
        ]);
        expect(filterSessionEntries(entries, 'alpha').map(({ id }) => id)).toEqual([
            'header:attention',
            'one',
            'header:recent',
            'three',
        ]);
    });

    it('falls back to All when a selected Project leaves the device grant', () => {
        const projects = [{ id: 'alpha' }];
        expect(activeProjectFilter('alpha', projects)).toBe('alpha');
        expect(activeProjectFilter('beta', projects)).toBeNull();
        expect(activeProjectFilter(null, projects)).toBeNull();
    });
});
