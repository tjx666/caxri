import { describe, expect, it } from 'vitest';

import type { SessionListEntry } from '../hooks/use-session-polling';
import {
    activeProjectFilter,
    adjacentProjectFilter,
    filterSessionEntries,
    projectFilterSwipe,
} from '../project-filter';

describe('filterSessionEntries', () => {
    const entries = [
        { id: 'header:attention', label: 'NEEDS ATTENTION', type: 'header' },
        { id: 'one', session: { projectId: 'alpha' }, type: 'session' },
        { id: 'header:working', label: 'WORKING', type: 'header' },
        { id: 'two', session: { projectId: 'beta' }, type: 'session' },
        { id: 'header:idle', label: 'IDLE', type: 'header' },
        { id: 'three', session: { projectId: 'alpha' }, type: 'session' },
    ] as SessionListEntry[];

    it('keeps the original grouped list for All', () => {
        expect(filterSessionEntries(entries, null)).toBe(entries);
    });

    it('removes empty group headers without changing the surviving group order', () => {
        expect(filterSessionEntries(entries, 'beta').map(({ id }) => id)).toEqual([
            'header:working',
            'two',
        ]);
        expect(filterSessionEntries(entries, 'alpha').map(({ id }) => id)).toEqual([
            'header:attention',
            'one',
            'header:idle',
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

describe('projectFilterSwipe', () => {
    it('turns to the next filter on a far leftward drag and the previous one on a far rightward drag', () => {
        expect(projectFilterSwipe({ translationX: -100, velocityX: 0 }, 400)).toBe('next');
        expect(projectFilterSwipe({ translationX: 100, velocityX: 0 }, 400)).toBe('previous');
    });

    it('accepts a short fling in the drag direction', () => {
        expect(projectFilterSwipe({ translationX: -40, velocityX: -1200 }, 400)).toBe('next');
    });

    it('springs back for a short slow drag or a fling that reversed', () => {
        expect(projectFilterSwipe({ translationX: -60, velocityX: -100 }, 400)).toBeNull();
        expect(projectFilterSwipe({ translationX: -40, velocityX: 1200 }, 400)).toBeNull();
        expect(projectFilterSwipe({ translationX: -20, velocityX: -2000 }, 400)).toBeNull();
    });
});

describe('adjacentProjectFilter', () => {
    const ids = ['alpha', 'beta'];

    it('steps through All and then each Project in chip order', () => {
        expect(adjacentProjectFilter(null, ids, 'next')).toBe('alpha');
        expect(adjacentProjectFilter('alpha', ids, 'next')).toBe('beta');
        expect(adjacentProjectFilter('alpha', ids, 'previous')).toBeNull();
    });

    it('stops at either end instead of wrapping around', () => {
        expect(adjacentProjectFilter(null, ids, 'previous')).toBeUndefined();
        expect(adjacentProjectFilter('beta', ids, 'next')).toBeUndefined();
    });
});
