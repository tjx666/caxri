import { describe, expect, it } from 'vitest';

import type { SessionListEntry } from '../hooks/use-session-polling';
import {
    activeProjectFilter,
    filterSessionEntries,
    projectFilterSwipe,
    projectPagerPosition,
    projectPagerTarget,
    projectPagerWindow,
} from '../project-filter';

describe('filterSessionEntries', () => {
    const entries = [
        { id: 'header:attention', label: 'Needs attention', type: 'header' },
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

describe('projectPagerPosition', () => {
    it('follows the finger one to one between the first and last page', () => {
        expect(projectPagerPosition(400, 150, 3, 400)).toBe(250);
        expect(projectPagerPosition(400, -150, 3, 400)).toBe(550);
    });

    it('resists a drag past either end', () => {
        expect(projectPagerPosition(0, 100, 3, 400)).toBeCloseTo(-30);
        expect(projectPagerPosition(800, -100, 3, 400)).toBeCloseTo(830);
        expect(projectPagerPosition(0, -100, 1, 400)).toBeCloseTo(30);
    });
});

describe('projectPagerTarget', () => {
    const far = (translationX: number) => ({ translationX, velocityX: 0 });

    it('settles on the neighbor in the swipe direction', () => {
        expect(projectPagerTarget(1, 3, far(-200), 400)).toBe(2);
        expect(projectPagerTarget(1, 3, far(200), 400)).toBe(0);
    });

    it('stays on the current page for a short drag or past either end', () => {
        expect(projectPagerTarget(1, 3, far(-40), 400)).toBe(1);
        expect(projectPagerTarget(0, 3, far(200), 400)).toBe(0);
        expect(projectPagerTarget(2, 3, far(-200), 400)).toBe(2);
    });
});

describe('projectPagerWindow', () => {
    it('keeps the current page and its neighbors mounted', () => {
        expect(projectPagerWindow(0, 3)).toEqual([0, 1]);
        expect(projectPagerWindow(1, 3)).toEqual([0, 1, 2]);
        expect(projectPagerWindow(2, 3)).toEqual([1, 2]);
        expect(projectPagerWindow(0, 1)).toEqual([0]);
    });
});
