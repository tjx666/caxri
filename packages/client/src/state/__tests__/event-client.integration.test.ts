import type { DurableEventStore, DurableServerEvent, ServerEvent } from '@caxri/protocol';
import {
    createDurableEventJournal,
    createEventJournal,
    MAX_EVENT_JOURNAL_EVENTS,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createRecoveringEventClient } from '../event-client';

describe('recoverable event client integration', () => {
    const changed = (reason: 'project.create' | 'session.create'): ServerEvent => ({
        event: 'state.changed',
        payload: { kind: 'full', reason },
    });

    function durableStore(): DurableEventStore {
        const events: Array<{
            protocolVersion: 2;
            cursor: number;
            event: DurableServerEvent;
        }> = [];
        return {
            appendEvent: (_stateEpoch, event) => {
                const envelope = {
                    protocolVersion: 2 as const,
                    cursor: events.length + 1,
                    event,
                };
                events.push(envelope);
                return envelope;
            },
            changefeedBounds: () => ({
                count: events.length,
                earliest: events.at(0)?.cursor ?? 0,
                latest: events.at(-1)?.cursor ?? 0,
            }),
            eventsAfter: (_stateEpoch, afterCursor) => ({
                events: events.filter(({ cursor }) => cursor > afterCursor),
                requiresSnapshot: false,
            }),
        };
    }

    it('converges a reconnect while preserving the direct Terminal output path', async () => {
        const emitted: ServerEvent[] = [];
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
        const first = journal.publish(changed('project.create'));
        const client = createRecoveringEventClient({
            emit: (event) => {
                emitted.push(event);
            },
            recover: (cursor) => journal.recover(cursor),
        });

        await client.start();
        client.receive(first);
        client.receive({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'visible only to the attached view' },
        });
        expect(emitted).toEqual([
            changed('project.create'),
            {
                event: 'terminal.output',
                payload: {
                    terminalId: 'terminal-1',
                    data: 'visible only to the attached view',
                },
            },
        ]);

        journal.publish(changed('session.create'));
        journal.publish(changed('project.create'));
        const snapshotClientEvents: ServerEvent[] = [];
        const snapshotClient = createRecoveringEventClient({
            emit: (event) => {
                snapshotClientEvents.push(event);
            },
            recover: (cursor) => journal.recover(cursor),
        });
        await snapshotClient.start();
        expect(snapshotClientEvents).toEqual([
            { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        ]);
    });

    it('bounds delayed recovery and converges from a fresh snapshot after the journal capacity', async () => {
        const firstRecoveryResolvers = Promise.withResolvers<void>();
        const releaseFirstRecovery = firstRecoveryResolvers.resolve;
        const firstRecovery = firstRecoveryResolvers.promise;
        const recoveryStartedResolvers = Promise.withResolvers<void>();
        const firstRecoveryStarted = recoveryStartedResolvers.resolve;
        const recoveryStarted = recoveryStartedResolvers.promise;
        const journal = createEventJournal({
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
        const emitted: ServerEvent[] = [];
        let recoveryCalls = 0;
        const client = createRecoveringEventClient({
            emit: (event) => {
                emitted.push(event);
            },
            recover: async (cursor) => {
                recoveryCalls += 1;
                if (recoveryCalls === 1) {
                    firstRecoveryStarted();
                    await firstRecovery;
                }
                return journal.recover(cursor);
            },
        });

        const starting = client.start();
        await recoveryStarted;
        client.receive({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'direct' },
        });
        client.receive({
            event: 'command.execute',
            payload: { command: 'session.selectNext' },
        });
        for (let index = 0; index <= MAX_EVENT_JOURNAL_EVENTS; index += 1) {
            client.receive(
                journal.publish(changed(index % 2 === 0 ? 'project.create' : 'session.create')),
            );
        }
        releaseFirstRecovery();

        await starting;
        expect(recoveryCalls).toBe(2);
        expect(emitted).toEqual([
            {
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'direct' },
            },
            {
                event: 'command.execute',
                payload: { command: 'session.selectNext' },
            },
            { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        ]);
    });

    it('converges once across disconnects at snapshot, catch-up, and live boundaries', async () => {
        const identity = {
            serverId: 'a'.repeat(32),
            stateEpoch: 'b'.repeat(32),
        };
        const journal = createDurableEventJournal({
            identity,
            snapshot: (cursor) => ({
                cursor,
                projectIds: [],
                sessionIds: [],
                terminalIds: [],
                settingsRevision: cursor,
                diagnosticsRevision: cursor,
                agentRevision: cursor,
            }),
            store: durableStore(),
        });
        const first = journal.publish(changed('project.create'));
        const firstRecovery = Promise.withResolvers<void>();
        let recoveryCalls = 0;
        let isStopDuringCatchUp = false;
        const emitted: ServerEvent[] = [];
        const client = createRecoveringEventClient({
            emit: (event) => {
                emitted.push(event);
                if (isStopDuringCatchUp) {
                    isStopDuringCatchUp = false;
                    client.stop();
                }
            },
            identity,
            recover: async (afterCursor) => {
                const recoveryCall = ++recoveryCalls;
                if (recoveryCall === 1) await firstRecovery.promise;
                return journal.recover({
                    ...identity,
                    ...(recoveryCall === 1 && { stateEpoch: 'c'.repeat(32) }),
                    afterCursor,
                });
            },
        });

        const detachedSnapshot = client.start();
        const second = journal.publish(changed('session.create'));
        client.receive(second);
        client.stop();
        firstRecovery.resolve();
        await detachedSnapshot;
        expect(emitted).toEqual([]);

        isStopDuringCatchUp = true;
        await client.start();
        expect(emitted).toEqual([first.event]);

        await client.start();
        expect(emitted).toEqual([first.event, second.event]);

        const live = journal.publish(changed('project.create'));
        client.receive(live);
        client.receive(live);
        client.stop();
        await client.start();

        expect(emitted).toEqual([first.event, second.event, live.event]);
    });
});
