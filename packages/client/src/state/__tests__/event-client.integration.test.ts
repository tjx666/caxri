import type { RuntimeEvent } from '@caxri/protocol';
import { createEventJournal, MAX_EVENT_JOURNAL_EVENTS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createRecoveringEventClient } from '../event-client';

describe('recoverable event client integration', () => {
    const changed = (reason: 'project.create' | 'session.create'): RuntimeEvent => ({
        event: 'state.changed',
        payload: { kind: 'full', reason },
    });

    it('converges a reconnect while preserving the direct Terminal output path', async () => {
        const emitted: RuntimeEvent[] = [];
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
        const snapshotClientEvents: RuntimeEvent[] = [];
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
        const emitted: RuntimeEvent[] = [];
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
});
