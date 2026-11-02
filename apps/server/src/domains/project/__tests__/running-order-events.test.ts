import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { createProjectRunningOrderEvents } from '../running-order-events';

const recordsEvent: ServerEvent = {
    event: 'state.changed',
    payload: { kind: 'records', sessionIds: ['s1'], terminalIds: [] },
};

function setup(change: ReturnType<CaxriDatabase['reconcileProjectRunningOrder']>) {
    const sent: ServerEvent[] = [];
    // The first call is the startup reconciliation `attach` runs.
    const reconcile = vi
        .fn<() => typeof change>()
        .mockReturnValueOnce(undefined)
        .mockReturnValue(change);
    const events = createProjectRunningOrderEvents((event) => sent.push(event), {
        write: vi.fn(),
    } as unknown as StructuredLogger);
    events.attach({ reconcileProjectRunningOrder: reconcile } as unknown as CaxriDatabase);
    return { events, reconcile, sent };
}

describe('createProjectRunningOrderEvents', () => {
    it('follows a state change that moved Projects with a full Project refresh', () => {
        const { events, reconcile, sent } = setup({ started: ['p'], stopped: [], running: ['p'] });
        events.send(recordsEvent);
        expect(sent).toEqual([
            recordsEvent,
            { event: 'state.changed', payload: { kind: 'full', reason: 'project.runningOrder' } },
        ]);
        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('passes other events through without reconciling', () => {
        const { events, reconcile, sent } = setup(undefined);
        const other = {
            event: 'files.watchLimitAlert',
            payload: {},
        } as unknown as ServerEvent;
        events.send(other);
        events.send(recordsEvent);
        expect(sent).toEqual([other, recordsEvent]);
        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('reconciles once at startup, before any event', () => {
        const sent: ServerEvent[] = [];
        const events = createProjectRunningOrderEvents((event) => sent.push(event), {
            write: vi.fn(),
        } as unknown as StructuredLogger);
        events.attach({
            reconcileProjectRunningOrder: () => ({ started: ['p'], stopped: [], running: ['p'] }),
        } as unknown as CaxriDatabase);
        expect(sent).toEqual([
            { event: 'state.changed', payload: { kind: 'full', reason: 'project.runningOrder' } },
        ]);
    });
});
