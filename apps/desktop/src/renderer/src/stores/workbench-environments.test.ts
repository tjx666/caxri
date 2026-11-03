import type { BootstrapState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { MachineSelection } from './workbench-environments';
import { composeSnapshots, followSelection } from './workbench-environments';

function state(prefix: string, selectedSessionId?: string): BootstrapState {
    return {
        projects: [{ id: `${prefix}-project` }],
        sessions: [{ id: `${prefix}-session` }],
        terminals: [],
        archivedTerminals: [],
        sessionStates: [],
        selectedSessionId,
        selectedProjectId: selectedSessionId === undefined ? undefined : `${prefix}-project`,
        settings: { device: prefix },
    } as unknown as BootstrapState;
}

describe('composeSnapshots', () => {
    it("returns this Mac's snapshot untouched while no SSH Host is connected", () => {
        const local = state('local', 'local-session');
        expect(composeSnapshots(local, [], undefined)).toBe(local);
    });

    it('lists this Mac first, then each Host, and keeps device state local', () => {
        const composed = composeSnapshots(
            state('local', 'local-session'),
            [
                ['a', state('a')],
                ['b', state('b')],
            ],
            undefined,
        );
        expect(composed.sessions.map((session) => session.id)).toEqual([
            'local-session',
            'a-session',
            'b-session',
        ]);
        expect(composed.selectedSessionId).toBe('local-session');
        expect((composed as unknown as { settings: unknown }).settings).toEqual({
            device: 'local',
        });
        expect(composed.openSessionIds).toBeUndefined();
    });

    it("shows the active Host's selection, falling back to this Mac when it has none", () => {
        const local = state('local', 'local-session');
        expect(
            composeSnapshots(local, [['a', state('a', 'a-session')]], 'a').selectedProjectId,
        ).toBe('a-project');
        expect(composeSnapshots(local, [['a', state('a')]], 'a').selectedSessionId).toBe(
            'local-session',
        );
    });
});

function selection(
    selectedSessionId: string | undefined,
    ...sessionIds: string[]
): MachineSelection {
    return { selectedSessionId, sessionIds: new Set(sessionIds) };
}

describe('followSelection', () => {
    const before = new Map([
        ['', selection('m1', 'm1', 'm2')],
        ['a', selection('a1', 'a1')],
        ['b', selection(undefined)],
    ]);

    it('follows a Host whose Server selected a Session created or revealed there', () => {
        const after = new Map([...before, ['b', selection('b1', 'b1')]]);
        expect(followSelection(before, after, '')).toBe('b');
        const revealed = new Map([...before, ['a', selection('a2', 'a1', 'a2')]]);
        expect(followSelection(before, revealed, '')).toBe('a');
    });

    it('follows this Mac when its selection moves while a Host is shown', () => {
        const after = new Map([...before, ['', selection('m2', 'm1', 'm2')]]);
        expect(followSelection(before, after, 'a')).toBe('');
    });

    it("stays put when a machine's selection fell back after its Session was deleted", () => {
        const after = new Map([...before, ['', selection('m2', 'm2')]]);
        expect(followSelection(before, after, 'a')).toBe('a');
    });

    it('stays on the active machine when it moved too, and ignores a newly connected Host', () => {
        const after = new Map([
            ...before,
            ['', selection('m2', 'm1', 'm2')],
            ['a', selection('a2', 'a1', 'a2')],
            ['c', selection('c1', 'c1')],
        ]);
        expect(followSelection(before, after, 'a')).toBe('a');
        const connected = new Map([...before, ['c', selection('c1', 'c1')]]);
        expect(followSelection(before, connected, '')).toBe('');
    });
});
