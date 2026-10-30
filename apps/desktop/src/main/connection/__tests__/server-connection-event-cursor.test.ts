import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createConnection,
    defaultRecoveryIdentity,
    durableEnvelope,
    mockServerRound,
    recoveryRequest,
    recoveryResult,
} from '../../__tests__/support/server-connection-harness';

const { superviseModuleMock } = await vi.hoisted(
    () => import('../../__tests__/support/supervise-module-mock'),
);

vi.mock('@caxri/client/supervise', () => superviseModuleMock());

describe('Desktop Server connection event cursor across reconnects', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('preserves the event cursor when reconnecting to the same Server history', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();
        expect(first.request).toHaveBeenCalledWith('events.recover', recoveryRequest(0));
        first.triggerEvent(
            durableEnvelope(1, {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }),
        );

        const replacement = mockServerRound();
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith('events.recover', recoveryRequest(1));
    });

    it('recovers an event created after reconnect recovery but before Desktop readiness', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        const received: unknown[] = [];
        connection.onEvent((event) => received.push(event));
        await connection.start();
        await connection.markDesktopReady();

        const replacement = mockServerRound();
        replacement.request.mockResolvedValueOnce(recoveryResult(0)).mockResolvedValueOnce(
            recoveryResult(1, [
                {
                    cursor: 1,
                    event: {
                        event: 'state.changed',
                        payload: { kind: 'full', reason: 'unknown' },
                    },
                },
            ]),
        );
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.markDesktopReady).toHaveBeenCalledTimes(1);
        expect(replacement.request).toHaveBeenNthCalledWith(1, 'events.recover', {
            ...recoveryRequest(0),
        });
        expect(replacement.request).toHaveBeenNthCalledWith(2, 'events.recover', {
            ...recoveryRequest(0),
        });
        expect(received).toEqual([
            {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            },
            {
                event: 'host.connectionChanged',
                payload: {
                    status: 'reconnected',
                    downtimeMs: 500,
                    attempt: 1,
                    isHostReplaced: false,
                },
            },
        ]);
    });

    it('preserves the event cursor when a new Boot continues the same durable history', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();
        first.triggerEvent(
            durableEnvelope(1, {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }),
        );

        const replacement = mockServerRound({
            bootId: 'e'.repeat(32),
            pid: 77,
            startedAt: 2000,
        });
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith('events.recover', recoveryRequest(1));
    });

    it('resets the event cursor when the State Epoch changes', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();
        first.triggerEvent(
            durableEnvelope(1, {
                event: 'state.changed',
                payload: { kind: 'full', reason: 'unknown' },
            }),
        );

        const replacementIdentity = {
            ...defaultRecoveryIdentity,
            stateEpoch: 'f'.repeat(32),
        };
        const replacement = mockServerRound(replacementIdentity);
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith(
            'events.recover',
            recoveryRequest(0, replacementIdentity),
        );
    });
});
