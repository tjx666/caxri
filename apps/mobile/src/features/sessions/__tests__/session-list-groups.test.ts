import { describe, expect, it } from 'vitest';

import type { SessionListEntry } from '../hooks/use-session-polling';
import {
    resetSessionListReveals,
    revealSessionListGroup,
    sessionListRows,
    toggleSessionListGroup,
} from '../session-list-groups';
import type { MobileSessionListGroup } from '../session-model';

function group(name: MobileSessionListGroup, count: number): SessionListEntry[] {
    return [
        { id: `header:${name}`, group: name, label: name.toUpperCase(), type: 'header' },
        ...Array.from(
            { length: count },
            (_, index) =>
                ({
                    id: `${name}:${name}-${index}`,
                    group: name,
                    session: { id: `${name}-${index}` },
                    type: 'session',
                }) as SessionListEntry,
        ),
    ];
}

const ids = (rows: ReturnType<typeof sessionListRows>) => rows.map(({ id }) => id);

describe('sessionListRows', () => {
    it('windows a long Idle group to its newest five behind a reveal row', () => {
        const rows = sessionListRows(group('idle', 12), {}, undefined);
        expect(ids(rows)).toEqual([
            'header:idle',
            ...Array.from({ length: 5 }, (_, index) => `idle:idle-${index}`),
            'reveal:idle',
        ]);
        expect(rows[0]).toMatchObject({ count: 12, isCollapsed: false });
        expect(rows.at(-1)).toMatchObject({ nextRevealCount: 7, windowCount: 5 });
    });

    it('lists every Session in the groups that ask for the user', () => {
        const rows = sessionListRows(group('working', 8), {}, undefined);
        expect(rows).toHaveLength(9);
    });

    it('keeps only the header of a collapsed group, with its count', () => {
        const states = toggleSessionListGroup({}, 'working');
        const rows = sessionListRows(
            [...group('working', 3), ...group('idle', 2)],
            states,
            undefined,
        );
        expect(ids(rows)).toEqual(['header:working', 'header:idle', 'idle:idle-0', 'idle:idle-1']);
        expect(rows[0]).toMatchObject({ count: 3, isCollapsed: true });
        expect(toggleSessionListGroup(states, 'working').working?.isCollapsed).toBe(false);
    });

    it('steps the window by ten from what it shows', () => {
        const states = revealSessionListGroup({}, 'idle', 5);
        const rows = sessionListRows(group('idle', 20), states, undefined);
        const shown = rows.filter((row) => row.type === 'session');
        expect(shown).toHaveLength(15);
        expect(rows.at(-1)).toMatchObject({ type: 'reveal', nextRevealCount: 5 });
        const all = sessionListRows(
            group('idle', 20),
            revealSessionListGroup(states, 'idle', 15),
            undefined,
        );
        const hasReveal = all.some((row) => row.type === 'reveal');
        expect(hasReveal).toBe(false);
    });

    it('keeps the selected Session in sight below the window', () => {
        const rows = sessionListRows(group('idle', 9), {}, 'idle-8');
        expect(ids(rows)).toContain('idle:idle-8');
    });
});

describe('sessionListRows with Server totals', () => {
    const totals = { pinned: 0, attention: 40, working: 0, idle: 30 };

    it('counts and offers the rows the Server holds beyond a group the list shows in full', () => {
        const rows = sessionListRows(group('attention', 15), {}, undefined, totals);
        expect(rows[0]).toMatchObject({ count: 40 });
        expect(rows).toHaveLength(17);
        expect(rows.at(-1)).toMatchObject({
            id: 'reveal:attention',
            nextRevealCount: 10,
            windowCount: 15,
        });
    });

    it('steps a reveal still loading from what it asked for, not from the rows held', () => {
        const states = revealSessionListGroup({}, 'attention', 15);
        expect(states.attention?.revealedCount).toBe(25);
        const rows = sessionListRows(group('attention', 15), states, undefined, totals);
        expect(rows.at(-1)).toMatchObject({ windowCount: 25 });
    });

    it('keeps the reveal row under a windowed group that shows every row it holds', () => {
        const states = revealSessionListGroup({}, 'idle', 5);
        const rows = sessionListRows(group('idle', 15), states, undefined, totals);
        expect(rows.filter(({ type }) => type === 'session')).toHaveLength(15);
        expect(rows.at(-1)).toMatchObject({ nextRevealCount: 10, windowCount: 15 });
    });

    it('offers nothing more once every row is held', () => {
        const rows = sessionListRows(group('attention', 40), {}, undefined, totals);
        expect(rows.some(({ type }) => type === 'reveal')).toBe(false);
    });

    it('counts only the rows held without totals for the shown filter', () => {
        const rows = sessionListRows(group('attention', 3), {}, undefined);
        expect(rows[0]).toMatchObject({ count: 3 });
        expect(rows.some(({ type }) => type === 'reveal')).toBe(false);
    });

    it('starts reveals over for another Project and keeps collapsed groups', () => {
        const states = toggleSessionListGroup(revealSessionListGroup({}, 'idle', 5), 'working');
        expect(resetSessionListReveals(states)).toEqual({
            idle: { isCollapsed: undefined },
            working: { isCollapsed: true },
        });
    });
});
