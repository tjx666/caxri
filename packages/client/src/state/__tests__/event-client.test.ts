import type { EventRecovery, ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createRecoveringEventClient } from '../event-client';

describe('createRecoveringEventClient', () => {
    it('fails closed on a recovery or live event from another durable history', async () => {
        const errors: unknown[] = [];
        const emitted: ServerEvent[] = [];
        const identity = {
            serverId: 'a'.repeat(32),
            stateEpoch: 'b'.repeat(32),
        };
        const client = createRecoveringEventClient({
            emit: (event) => emitted.push(event),
            identity,
            onError: (error) => errors.push(error),
            // oxlint-disable-next-line typescript/require-await -- deterministic identity rejection fixture
            recover: async () => ({
                kind: 'events',
                cursor: 0,
                events: [],
                serverId: identity.serverId,
                stateEpoch: 'c'.repeat(32),
                barrier: { kind: 'live', cursor: 0 },
            }),
        });

        await expect(client.start()).rejects.toMatchObject({ code: 'CONFLICT' });
        client.receive({
            protocolVersion: 2,
            cursor: 1,
            serverId: identity.serverId,
            stateEpoch: 'c'.repeat(32),
            event: {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            },
        });

        expect(errors).toHaveLength(2);
        expect(errors).toEqual([
            expect.objectContaining({ code: 'CONFLICT' }),
            expect.objectContaining({ code: 'CONFLICT' }),
        ]);
        expect(emitted).toEqual([]);
    });

    it('reports a failed recovery through onError and rejects start() so the attach path can retry', async () => {
        const errors: unknown[] = [];
        const client = createRecoveringEventClient({
            emit: () => {},
            onError: (error) => {
                errors.push(error);
            },
            // oxlint-disable-next-line typescript/require-await -- rejects synchronously to exercise the onError path deterministically
            recover: async () => {
                throw new Error('recovery transport failed');
            },
        });

        await expect(client.start()).rejects.toThrow('recovery transport failed');

        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('recovery transport failed');
    });

    it('drops queued envelopes after a failed recovery instead of replaying them into a hot loop', async () => {
        const errors: unknown[] = [];
        let recoverCalls = 0;
        const client = createRecoveringEventClient({
            emit: () => {},
            onError: (error) => {
                errors.push(error);
            },
            // oxlint-disable-next-line typescript/require-await -- rejects synchronously like a disposed transport
            recover: async () => {
                recoverCalls += 1;
                throw new Error('Desktop Host connection is no longer active');
            },
        });
        const gapped = {
            cursor: 5,
            event: { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        } as never;

        // A live envelope with a cursor gap starts recovery; a second one queues behind it.
        client.receive(gapped);
        client.receive({ ...(gapped as object), cursor: 6 } as never);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(recoverCalls).toBe(1);
        expect(errors).toHaveLength(1);
    });

    it('emits a transient event immediately without waiting for recovery to settle', () => {
        const emitted: ServerEvent[] = [];
        const client = createRecoveringEventClient({
            emit: (event) => {
                emitted.push(event);
            },
            // oxlint-disable-next-line typescript/require-await -- resolves synchronously; this path is never awaited by the assertion
            recover: async () => ({ kind: 'events', cursor: 0, events: [] }),
        });

        client.receive({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'direct bytes' },
        });

        expect(emitted).toEqual([
            {
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'direct bytes' },
            },
        ]);
    });

    it('discards a detached recovery without advancing the durable cursor', async () => {
        const firstRecovery = Promise.withResolvers<EventRecovery>();
        const secondRecovery = Promise.withResolvers<EventRecovery>();
        const recoveries = [firstRecovery, secondRecovery];
        const recoveryCursors: number[] = [];
        const emitted: ServerEvent[] = [];
        const firstEvent = {
            protocolVersion: 2 as const,
            cursor: 1,
            event: {
                event: 'state.changed' as const,
                payload: { kind: 'full' as const, reason: 'project.create' as const },
            },
        };
        const secondEvent = {
            protocolVersion: 2 as const,
            cursor: 2,
            event: {
                event: 'state.changed' as const,
                payload: { kind: 'full' as const, reason: 'session.create' as const },
            },
        };
        const client = createRecoveringEventClient({
            emit: (event) => {
                emitted.push(event);
            },
            recover: (afterCursor) => {
                recoveryCursors.push(afterCursor);
                const recovery = recoveries.shift();
                if (!recovery) throw new Error('Unexpected recovery request');
                return recovery.promise;
            },
        });

        const detachedStart = client.start();
        client.stop();
        const attachedStart = client.start();

        expect(recoveryCursors).toEqual([0, 0]);

        firstRecovery.resolve({ kind: 'events', cursor: 1, events: [firstEvent] });
        await detachedStart;
        client.receive(secondEvent);

        expect(emitted).toEqual([]);

        secondRecovery.resolve({ kind: 'events', cursor: 1, events: [firstEvent] });
        await attachedStart;

        expect(emitted).toEqual([firstEvent.event, secondEvent.event]);

        client.stop();
        client.receive({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'detached bytes' },
        });
        client.receive({
            protocolVersion: 2,
            cursor: 3,
            event: {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'project.create' },
            },
        });

        expect(emitted).toEqual([firstEvent.event, secondEvent.event]);
    });
});
