import { describe, expect, it } from 'vitest';

import type { SessionListEntry } from '../hooks/use-session-polling';
import {
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
        const states = revealSessionListGroup({}, 'finished', 5);
        const rows = sessionListRows(group('finished', 20), states, undefined);
        const shown = rows.filter((row) => row.type === 'session');
        expect(shown).toHaveLength(15);
        expect(rows.at(-1)).toMatchObject({ type: 'reveal', nextRevealCount: 5 });
        const all = sessionListRows(
            group('finished', 20),
            revealSessionListGroup(states, 'finished', 15),
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
