import { describe, expect, it, vi } from 'vitest';

import { CaxriError } from '../errors';
import type { DurableEventStore, DurableServerEvent } from '../event-journal';
import {
    createDurableEventJournal,
    createEventJournal,
    durableServerEventSchema,
    isTransientServerEvent,
    MAX_EVENT_JOURNAL_EVENTS,
    transientServerEventSchema,
} from '../event-journal';

function durableStore(maximumEvents = 2): DurableEventStore {
    let cursor = 0;
    const events: Array<{
        protocolVersion: 2;
        cursor: number;
        event: DurableServerEvent;
    }> = [];
    return {
        appendEvent: (_stateEpoch, event) => {
            const envelope = { protocolVersion: 2 as const, cursor: ++cursor, event };
            events.push(envelope);
            if (events.length > maximumEvents) events.shift();
            return envelope;
        },
        changefeedBounds: () => ({
            count: events.length,
            earliest: events.at(0)?.cursor ?? 0,
            latest: events.at(-1)?.cursor ?? 0,
        }),
        eventsAfter: (_stateEpoch, afterSequence) => ({
            events: events.filter((event) => event.cursor > afterSequence),
            requiresSnapshot: false,
        }),
    };
}

const durableIdentity = {
    serverId: 'a'.repeat(32),
    stateEpoch: 'b'.repeat(32),
};

const durableEvent = {
    event: 'state.changed' as const,
    payload: { kind: 'full' as const, reason: 'unknown' as const },
};

describe('isTransientServerEvent / transient and durable schemas', () => {
    it('classifies direct-delivery events (PTY bytes, one-shot commands) as transient', () => {
        expect(isTransientServerEvent({ event: 'terminal.output', payload: {} } as never)).toBe(
            true,
        );
        expect(
            isTransientServerEvent({ event: 'terminal.outputRecovery', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientServerEvent({
                event: 'terminal.sizeOwnership',
                payload: { terminalId: 'terminal-1', owner: 'mobile', cols: 42, rows: 20 },
            }),
        ).toBe(true);
        expect(isTransientServerEvent({ event: 'command.execute', payload: {} } as never)).toBe(
            true,
        );
        expect(
            isTransientServerEvent({ event: 'host.connectionChanged', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientServerEvent({ event: 'gpu.recoveryRequested', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientServerEvent({ event: 'projectStatus.changed', payload: {} } as never),
        ).toBe(true);
        expect(
            isTransientServerEvent({
                event: 'viewContainers.catalogChanged',
                payload: {},
            } as never),
        ).toBe(true);
    });

    it('classifies a durable state event as non-transient', () => {
        expect(
            isTransientServerEvent({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            } as never),
        ).toBe(false);
    });

    it('accepts only transient events through transientServerEventSchema', () => {
        expect(
            transientServerEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(true);
        expect(
            transientServerEventSchema.safeParse({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }).success,
        ).toBe(false);
    });

    it('rejects a transient event through durableServerEventSchema', () => {
        expect(
            durableServerEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(false);
        expect(
            durableServerEventSchema.safeParse({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }).success,
        ).toBe(true);
    });
});

describe('createEventJournal capacity validation', () => {
    const snapshot = (cursor: number) => ({
        cursor,
        projectIds: [],
        sessionIds: [],
        terminalIds: [],
        settingsRevision: cursor,
        diagnosticsRevision: cursor,
        agentRevision: cursor,
    });

    it('rejects a capacity outside the 1..MAX_EVENT_JOURNAL_EVENTS bound', () => {
        expect(() => createEventJournal({ snapshot, maximumEvents: 0 })).toThrow(CaxriError);
        expect(() =>
            createEventJournal({ snapshot, maximumEvents: MAX_EVENT_JOURNAL_EVENTS + 1 }),
        ).toThrow(CaxriError);
        expect(() => createEventJournal({ snapshot, maximumEvents: 1.5 })).toThrow(CaxriError);
    });

    it('accepts the bound edges', () => {
        expect(() => createEventJournal({ snapshot, maximumEvents: 1 })).not.toThrow();
        expect(() =>
            createEventJournal({ snapshot, maximumEvents: MAX_EVENT_JOURNAL_EVENTS }),
        ).not.toThrow();
    });
});

describe('createEventJournal.recover cursor validation', () => {
    it('rejects a recovery cursor ahead of the journal', async () => {
        const journal = createEventJournal({
            maximumEvents: 2,
            snapshot: (cursor) => ({
                cursor,
                projectIds: [],
                sessionIds: [],
                terminalIds: [],
                settingsRevision: cursor,
                diagnosticsRevision: cursor,
                agentRevision: cursor,
            }),
        });
        await expect(journal.recover(10)).rejects.toThrow(CaxriError);
    });
});

describe('createDurableEventJournal', () => {
    const snapshot = (cursor: number) => ({
        cursor,
        projectIds: [],
        sessionIds: [],
        terminalIds: [],
        settingsRevision: cursor,
        diagnosticsRevision: cursor,
        agentRevision: cursor,
    });

    it('returns an identity-bound contiguous suffix followed by an explicit live barrier', async () => {
        const observe = vi.fn();
        const journal = createDurableEventJournal({
            identity: durableIdentity,
            observe,
            snapshot,
            store: durableStore(),
        });
        journal.publish(durableEvent);
        journal.publish(durableEvent);

        await expect(
            journal.recover({ ...durableIdentity, afterCursor: 0 }),
        ).resolves.toMatchObject({
            kind: 'events',
            cursor: 2,
            serverId: durableIdentity.serverId,
            stateEpoch: durableIdentity.stateEpoch,
            barrier: { kind: 'live', cursor: 2 },
            events: [
                { cursor: 1, ...durableIdentity },
                { cursor: 2, ...durableIdentity },
            ],
        });
        expect(observe).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'catch-up', reason: 'matched', eventCount: 2 }),
        );
    });

    it('uses a bounded snapshot for an expired cursor or mismatched recovery identity', async () => {
        const journal = createDurableEventJournal({
            identity: durableIdentity,
            snapshot,
            store: durableStore(1),
        });
        journal.publish(durableEvent);
        journal.publish(durableEvent);

        await expect(
            journal.recover({ ...durableIdentity, afterCursor: 0 }),
        ).resolves.toMatchObject({
            kind: 'snapshot',
            cursor: 2,
            barrier: { kind: 'live', cursor: 2 },
        });
        await expect(
            journal.recover({
                serverId: 'c'.repeat(32),
                stateEpoch: durableIdentity.stateEpoch,
                afterCursor: 2,
            }),
        ).resolves.toMatchObject({ kind: 'snapshot', cursor: 2 });
    });

    it('uses a bounded snapshot when the durable suffix contains a private payload marker', async () => {
        const store = durableStore();
        store.eventsAfter = () => ({ events: [], requiresSnapshot: true });
        const journal = createDurableEventJournal({
            identity: durableIdentity,
            snapshot,
            store,
        });
        journal.publish({ event: 'settings.changed', payload: { source: '{"secret":true}' } });

        await expect(
            journal.recover({ ...durableIdentity, afterCursor: 0 }),
        ).resolves.toMatchObject({ kind: 'snapshot', cursor: 1 });
    });

    it('freezes the snapshot barrier before later live events are appended', async () => {
        const releaseSnapshot = Promise.withResolvers<void>();
        const journal = createDurableEventJournal({
            identity: durableIdentity,
            snapshot: async (cursor) => {
                await releaseSnapshot.promise;
                return snapshot(cursor);
            },
            store: durableStore(),
        });
        journal.publish(durableEvent);
        const recovering = journal.recover({
            serverId: durableIdentity.serverId,
            stateEpoch: 'c'.repeat(32),
            afterCursor: 0,
        });
        const live = journal.publish(durableEvent);
        releaseSnapshot.resolve();

        await expect(recovering).resolves.toMatchObject({
            kind: 'snapshot',
            cursor: 1,
            barrier: { kind: 'live', cursor: 1 },
        });
        expect(live.cursor).toBe(2);
    });

    it('rejects Terminal bytes before they reach durable storage', () => {
        const store = durableStore();
        const journal = createDurableEventJournal({
            identity: durableIdentity,
            snapshot,
            store,
        });

        expect(() =>
            journal.publish({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'private output' },
            }),
        ).toThrow(/Transient events/u);
        expect(store.changefeedBounds(durableIdentity.stateEpoch).count).toBe(0);
    });
});
