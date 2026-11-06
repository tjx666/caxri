import { describe, expect, it } from 'vitest';

import type { ServerEvent } from '../index';
import { createEventJournal, projectObservableEventRecovery } from '../index';

describe('recoverable event cursor', () => {
    const changed = (reason: 'project.create' | 'session.create'): ServerEvent => ({
        event: 'state.changed',
        payload: { kind: 'full', reason },
    });

    it('replays an intact suffix, detects gaps, drops duplicates, and bounds snapshots', async () => {
        const journal = createEventJournal({
            maximumEvents: 2,
            snapshot: (cursor) => ({
                cursor,
                projectIds: ['project-1'],
                sessionIds: ['session-1'],
                terminalIds: [],
                settingsRevision: 1,
                diagnosticsRevision: 1,
                agentRevision: 1,
            }),
        });
        journal.publish(changed('project.create'));
        const second = journal.publish(changed('session.create'));
        await expect(journal.recover(1)).resolves.toEqual({
            kind: 'events',
            cursor: 2,
            events: [second],
        });
        journal.publish(changed('project.create'));
        await expect(journal.recover(0)).resolves.toMatchObject({
            kind: 'snapshot',
            cursor: 3,
            snapshot: { projectIds: ['project-1'] },
        });
        expect(JSON.stringify(await journal.recover(0))).not.toContain('terminal.output');
        expect(() =>
            journal.publish({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'secret output' },
            }),
        ).toThrow('Transient events cannot enter durable protocol replay');
        expect(() =>
            journal.publish({
                event: 'command.execute',
                payload: { command: 'session.delete' },
            }),
        ).toThrow('Transient events cannot enter durable protocol replay');
    });

    it('projects CLI recovery to typed names without configuration source or record IDs', () => {
        expect(
            projectObservableEventRecovery({
                kind: 'events',
                cursor: 1,
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
                barrier: { kind: 'live', cursor: 1 },
                events: [
                    {
                        protocolVersion: 2,
                        cursor: 1,
                        serverId: 'a'.repeat(32),
                        stateEpoch: 'b'.repeat(32),
                        event: {
                            event: 'settings.changed',
                            payload: { source: 'secret-sentinel' },
                        },
                    },
                ],
            }),
        ).toEqual({
            kind: 'events',
            cursor: 1,
            events: [{ cursor: 1, event: 'settings.changed' }],
        });
        expect(
            projectObservableEventRecovery({
                kind: 'snapshot',
                cursor: 2,
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
                barrier: { kind: 'live', cursor: 2 },
                snapshot: {
                    cursor: 2,
                    projectIds: ['private-project'],
                    sessionIds: ['private-session'],
                    terminalIds: ['private-terminal'],
                    settingsRevision: 2,
                    diagnosticsRevision: 2,
                    agentRevision: 2,
                },
            }),
        ).toEqual({ kind: 'snapshot', cursor: 2, gap: true });
    });

    it('keeps events published during an asynchronous snapshot behind its frozen cursor', async () => {
        const snapshotBlockedResolvers = Promise.withResolvers<void>();
        const releaseSnapshot = snapshotBlockedResolvers.resolve;
        const snapshotBlocked = snapshotBlockedResolvers.promise;
        const journal = createEventJournal({
            maximumEvents: 1,
            snapshot: async (cursor) => {
                await snapshotBlocked;
                return {
                    cursor,
                    projectIds: [],
                    sessionIds: [],
                    terminalIds: [],
                    settingsRevision: cursor,
                    diagnosticsRevision: cursor,
                    agentRevision: cursor,
                };
            },
        });
        journal.publish(changed('project.create'));
        journal.publish(changed('session.create'));
        const recovering = journal.recover(0);
        const later = journal.publish(changed('project.create'));
        releaseSnapshot();

        await expect(recovering).resolves.toMatchObject({ kind: 'snapshot', cursor: 2 });
        await expect(journal.recover(2)).resolves.toEqual({
            kind: 'events',
            cursor: 3,
            events: [later],
        });
    });
});
