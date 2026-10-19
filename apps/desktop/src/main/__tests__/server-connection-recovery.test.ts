import { connectDesktopToServer, ensureServer } from '@caxri/client/supervise';
import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createConnection,
    defaultRecoveryIdentity,
    durableEnvelope,
    mockServerRound,
    recoveryRequest,
    recoveryResult,
} from './support/server-connection-harness';

const { superviseModuleMock } = await vi.hoisted(() => import('./support/supervise-module-mock'));

vi.mock('@caxri/client/supervise', () => superviseModuleMock());

describe('Desktop Server connection recovery', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('reconnects after connection loss and re-announces Desktop readiness', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, logger } = createConnection();
        await connection.start();
        await connection.markDesktopReady();
        expect(first.markDesktopReady).toHaveBeenCalledTimes(1);

        const replacement = mockServerRound();
        // 1006: the abnormal-closure code `ws` reports for `terminate()` (github.com/tjx666/caxri/issues/553).
        first.triggerClose(undefined, 1006);
        await expect(connection.request('app.health')).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(logger.write).toHaveBeenCalledWith('warn', 'server_connection.lost', {
            fields: { closeCode: 1006 },
        });

        await vi.advanceTimersByTimeAsync(500);
        expect(logger.write).toHaveBeenCalledWith('info', 'server_connection.reconnected', {
            fields: { attempt: 1, downtimeMs: 500, isHostReplaced: false },
        });
        expect(replacement.markDesktopReady).toHaveBeenCalledTimes(1);
        await expect(connection.request('app.health')).resolves.toBeDefined();
    });

    it('reports recovery only while the reconnect loop still owns the outage', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();
        expect(connection.isRecovering()).toBe(false);

        mockServerRound();
        first.triggerClose(undefined, 1006);
        expect(connection.isRecovering()).toBe(true);

        await vi.advanceTimersByTimeAsync(500);
        expect(connection.isRecovering()).toBe(false);
    });

    /**
     * `ServerArtifactSupervisor.ensure` throws `CONFLICT` without touching the restart budget when the Server process
     * is alive but its endpoint keeps refusing, so the supervisor never reports a failure and the loop retries forever.
     * Only the outage age can end the recovery window for that outage.
     */
    it('stops reporting recovery once the outage outlives the reconnect window', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();

        vi.mocked(ensureServer).mockRejectedValue(
            new CaxriError(
                'CONFLICT',
                'Caxri Host process is alive but its endpoint is unavailable',
            ),
        );
        first.triggerClose(undefined, 1006);
        expect(connection.isRecovering()).toBe(true);

        await vi.advanceTimersByTimeAsync(119_000);
        expect(connection.isRecovering()).toBe(true);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(connection.isRecovering()).toBe(false);
    });

    it('stops reporting recovery once the Core restart budget is exhausted', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, serverSupervisor } = createConnection();
        await connection.start();
        serverSupervisor.lossEvent = {
            error: new CaxriError('UNAVAILABLE', 'restart budget exhausted'),
            restartCount: 3,
            status: 'failed',
        };

        first.triggerClose();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(connection.isRecovering()).toBe(false);
    });

    it('projects a Core crash through the preserved restarting and ready status flow', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, serverSupervisor } = createConnection();
        const received: unknown[] = [];
        connection.onEvent((event) => received.push(event));
        await connection.start();

        serverSupervisor.lossEvent = {
            backoffMs: 250,
            restartCount: 1,
            status: 'restarting',
        };
        const replacement = mockServerRound({ pid: 77, startedAt: 2000 });
        replacement.request.mockResolvedValueOnce(
            recoveryResult(1, [
                {
                    cursor: 1,
                    event: {
                        event: 'runtime.status',
                        payload: { restartCount: 0, status: 'ready' },
                    },
                },
            ]),
        );

        first.triggerClose();
        expect(received).toEqual([
            {
                event: 'runtime.status',
                payload: { restartCount: 1, status: 'restarting' },
            },
        ]);
        await vi.advanceTimersByTimeAsync(0);

        expect(serverSupervisor.reportProcessLoss).toHaveBeenCalledWith(999_999);
        expect(received).toEqual([
            {
                event: 'runtime.status',
                payload: { restartCount: 1, status: 'restarting' },
            },
            {
                event: 'runtime.status',
                payload: { restartCount: 0, status: 'ready' },
            },
            {
                event: 'host.connectionChanged',
                payload: {
                    status: 'reconnected',
                    downtimeMs: 0,
                    attempt: 1,
                    isHostReplaced: true,
                },
            },
        ]);
    });

    it('projects an exhausted Core restart budget and stops reconnecting', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, serverSupervisor } = createConnection();
        const received: unknown[] = [];
        connection.onEvent((event) => received.push(event));
        await connection.start();
        const attachmentCount = vi.mocked(ensureServer).mock.calls.length;
        serverSupervisor.lossEvent = {
            error: new CaxriError('UNAVAILABLE', 'restart budget exhausted'),
            restartCount: 3,
            status: 'failed',
        };

        first.triggerClose();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(received).toEqual([
            {
                event: 'runtime.status',
                payload: { restartCount: 3, status: 'failed' },
            },
        ]);
        expect(ensureServer).toHaveBeenCalledTimes(attachmentCount);
    });

    it('stops reconnecting and reports when another Desktop replaces its lease', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, logger } = createConnection();
        const received: unknown[] = [];
        connection.onEvent((event) => received.push(event));
        await connection.start();
        const attachmentCount = vi.mocked(ensureServer).mock.calls.length;

        first.triggerClose('replaced');
        await vi.advanceTimersByTimeAsync(30_000);

        expect(ensureServer).toHaveBeenCalledTimes(attachmentCount);
        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'server_connection.desktop_lease_replaced',
            {},
        );
        expect(received).toEqual([
            {
                event: 'host.connectionChanged',
                payload: { status: 'replaced' },
            },
        ]);
        await expect(connection.request('app.health')).rejects.toMatchObject({
            code: 'CANCELLED',
        });

        // Only the user's explicit Reconnect takes the lease back.
        mockServerRound();
        const resumed = connection.resume();
        await vi.advanceTimersByTimeAsync(500);
        await resumed;
        await expect(connection.request('app.health')).resolves.toBeDefined();
        expect(received.at(-1)).toMatchObject({
            event: 'host.connectionChanged',
            payload: { status: 'reconnected', attempt: 1 },
        });
    });

    it('announces a Renderer resync event once the reconnect succeeds', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        const received: unknown[] = [];
        connection.onEvent((event) => received.push(event));
        await connection.start();

        mockServerRound({ pid: 77, startedAt: 2000 });
        first.triggerClose();
        expect(received).toEqual([]);

        await vi.advanceTimersByTimeAsync(500);
        expect(received).toEqual([
            {
                event: 'host.connectionChanged',
                payload: {
                    status: 'reconnected',
                    downtimeMs: 500,
                    attempt: 1,
                    isHostReplaced: true,
                },
            },
        ]);
    });

    it('keeps retrying with backoff while the Server stays down', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, logger } = createConnection();
        await connection.start();

        vi.mocked(ensureServer).mockRejectedValue(new Error('host is still down'));
        first.triggerClose();

        await vi.advanceTimersByTimeAsync(500);
        expect(logger.write).toHaveBeenCalledWith('warn', 'server_connection.reconnect_failed', {
            fields: { attempt: 1, error: 'host is still down' },
        });

        const replacement = mockServerRound();
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.write).toHaveBeenCalledWith('info', 'server_connection.reconnected', {
            fields: { attempt: 2, downtimeMs: 1500, isHostReplaced: false },
        });
        expect(replacement.onClose).toHaveBeenCalledTimes(1);
    });

    it('starts the next attempt at once when Retry Now ends a backoff wait', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, logger } = createConnection();
        await connection.start();

        vi.mocked(ensureServer).mockRejectedValue(new Error('host is still down'));
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);
        expect(connection.retryNow()).toBe(true);

        const replacement = mockServerRound();
        // The second backoff would last 1000 ms; waking it must not wait for the timer.
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.write).toHaveBeenCalledWith('info', 'server_connection.reconnected', {
            fields: { attempt: 2, downtimeMs: 500, isHostReplaced: false },
        });
        expect(replacement.onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores Retry Now when no backoff wait is pending', () => {
        const { connection } = createConnection();
        expect(connection.retryNow()).toBe(false);
    });

    it('keeps retrying when the replacement is lost while re-announcing readiness', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, logger } = createConnection();
        await connection.start();
        await connection.markDesktopReady();

        const flaky = mockServerRound();
        flaky.markDesktopReady.mockImplementation(() => {
            flaky.triggerClose();
            return Promise.reject(new Error('lease revoked mid-announce'));
        });
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);
        expect(flaky.markDesktopReady).toHaveBeenCalledTimes(1);

        const stable = mockServerRound();
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.write).toHaveBeenCalledWith('info', 'server_connection.reconnected', {
            fields: { attempt: 2, downtimeMs: 1500, isHostReplaced: false },
        });
        expect(stable.markDesktopReady).toHaveBeenCalledTimes(1);
        await expect(connection.request('app.health')).resolves.toBeDefined();
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

    it('does not reconnect after an intentional close', async () => {
        vi.useFakeTimers();
        const client = mockServerRound();
        const { connection, logger } = createConnection();
        await connection.start();

        connection.close();
        expect(client.close).toHaveBeenCalledWith({ cancelPendingRequests: true });
        client.triggerClose();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(logger.write).not.toHaveBeenCalledWith('warn', 'server_connection.lost', {});
        expect(logger.write).not.toHaveBeenCalledWith(
            'info',
            'server_connection.reconnected',
            expect.anything(),
        );
    });

    it('treats a connection loss after an accepted quit as the end of Server rather than a crash to recover', async () => {
        vi.useFakeTimers();
        const client = mockServerRound();
        const { connection, logger, serverSupervisor } = createConnection();
        await connection.start();
        mockServerRound({ pid: 77, startedAt: 2000 });
        const attachments = vi.mocked(connectDesktopToServer).mock.calls.length;

        connection.markQuitting();
        client.triggerClose();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(serverSupervisor.reportProcessLoss).not.toHaveBeenCalled();
        expect(connectDesktopToServer).toHaveBeenCalledTimes(attachments);
        expect(logger.write).toHaveBeenCalledWith('info', 'server_connection.lost', {
            fields: { closeCode: null, source: 'desktop-quitting' },
        });
        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'server_connection.lost',
            expect.anything(),
        );
    });

    it('terminates tasks before stopping Server and fences the expected transport close from recovery', async () => {
        const client = mockServerRound({ pid: 999_999 });
        client.requestServerOperation.mockResolvedValue(undefined);
        client.request.mockImplementation((method: string) =>
            method === 'host.stop'
                ? Promise.resolve({ stopping: true, activePtyCount: 0 })
                : Promise.resolve(recoveryResult(0)),
        );
        const { connection, logger, serverSupervisor } = createConnection();
        await connection.start();

        const stopping = connection.stopServer();
        client.triggerClose();
        await stopping;

        expect(client.requestServerOperation).toHaveBeenCalledWith(
            'terminal.terminateAll',
            undefined,
            undefined,
        );
        expect(client.request).toHaveBeenCalledWith('host.stop', { confirmLivePtys: true });
        expect(serverSupervisor.releaseProcess).toHaveBeenCalledWith(999_999);
        expect(client.close).toHaveBeenCalledWith({ cancelPendingRequests: true });
        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'server_connection.lost',
            expect.anything(),
        );
        await expect(connection.request('app.health')).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('still stops Server when task termination fails during an accepted destructive quit', async () => {
        const client = mockServerRound({ pid: 999_999 });
        const terminationFailure = new Error('Terminal Host unavailable');
        client.requestServerOperation.mockRejectedValue(terminationFailure);
        client.request.mockImplementation((method: string) =>
            method === 'host.stop'
                ? Promise.resolve({ stopping: true, activePtyCount: 1 })
                : Promise.resolve(recoveryResult(0)),
        );
        const { connection, serverSupervisor } = createConnection();
        await connection.start();

        await expect(connection.stopServer()).rejects.toBe(terminationFailure);

        expect(client.request).toHaveBeenCalledWith('host.stop', { confirmLivePtys: true });
        expect(serverSupervisor.releaseProcess).toHaveBeenCalledWith(999_999);
        expect(client.close).toHaveBeenCalledWith({ cancelPendingRequests: true });
    });
});
