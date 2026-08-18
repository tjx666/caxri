import { connectDesktopToHost, ensureHost } from '@caxri/cli';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopHostConnection } from '../host-connection';
import type { HostBuildIdentity } from '../host-staleness';

vi.mock('@caxri/cli', () => ({
    connectDesktopToHost: vi.fn(),
    ensureHost: vi.fn(),
}));

interface FakeHostClient {
    close: ReturnType<typeof vi.fn>;
    markDesktopReady: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
    onEvent: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    triggerClose: () => void;
    triggerEvent: (envelope: unknown) => void;
}

function createFakeHostClient(): FakeHostClient {
    const closeListeners: Array<() => void> = [];
    const eventListeners: Array<(envelope: unknown) => void> = [];
    return {
        close: vi.fn(),
        markDesktopReady: vi.fn().mockResolvedValue(undefined),
        onClose: vi.fn((listener: () => void) => {
            closeListeners.push(listener);
            return () => {};
        }),
        onEvent: vi.fn((listener: (envelope: unknown) => void) => {
            eventListeners.push(listener);
            return () => {};
        }),
        request: vi.fn().mockResolvedValue({ cursor: 0, events: [], kind: 'events' }),
        triggerClose: () => {
            for (const listener of closeListeners) listener();
        },
        triggerEvent: (envelope) => {
            for (const listener of eventListeners) listener(envelope);
        },
    };
}

function createConnection(buildIdentity: HostBuildIdentity = {}) {
    const logger = { write: vi.fn() };
    const connection = new DesktopHostConnection({
        buildIdentity,
        currentDirectory: '/app/out/main',
        cliPath: '/app/cli/caxri.cjs',
        desktopId: 'desktop-1',
        desktopLaunch: { executable: '/app/Caxri', args: [], cwd: '/app' },
        handleCommand: () => Promise.resolve(null),
        logger: logger as never,
        userDataPath: '/profile',
    });
    return { connection, logger };
}

interface HostRoundOptions {
    hostBuildId?: string;
    hostCommit?: string;
    hostVersion?: string;
    pid?: number;
    startedAt?: number;
}

function createFakeOperator(options: HostRoundOptions = {}) {
    return {
        close: vi.fn(),
        request: vi.fn((method: string) =>
            method === 'host.stop'
                ? Promise.resolve({ stopping: true, activePtyCount: 0 })
                : Promise.resolve({
                      /**
                       * An impossible pid so the replacement path's liveness poll returns immediately instead of
                       * probing a real process.
                       */
                      pid: options.pid ?? 999_999,
                      runtimePid: 43,
                      startedAt: options.startedAt ?? 1000,
                      version: options.hostVersion ?? '0.0.9',
                      ...(options.hostCommit && { commit: options.hostCommit }),
                      ...(options.hostBuildId && { buildId: options.hostBuildId }),
                  }),
        ),
    };
}

function mockHostRound(options: HostRoundOptions = {}): FakeHostClient {
    const client = createFakeHostClient();
    vi.mocked(ensureHost).mockResolvedValue(createFakeOperator(options) as never);
    vi.mocked(connectDesktopToHost).mockResolvedValue(client as never);
    return client;
}

describe('Desktop Host connection facade', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns a classified rejected Promise before Host attachment instead of throwing', async () => {
        const { connection } = createConnection();
        let request: Promise<unknown> | undefined;

        expect(() => {
            request = connection.request('app.health');
        }).not.toThrow();
        await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('shares a pending attachment and retries after that attachment rejects', async () => {
        const { connection } = createConnection();
        const connect = vi
            .spyOn(connection as unknown as { connect(): Promise<void> }, 'connect')
            .mockRejectedValueOnce(new Error('first attachment failed'))
            .mockResolvedValueOnce();

        const first = connection.start();
        expect(connection.start()).toBe(first);
        await expect(first).rejects.toThrow('first attachment failed');

        const retry = connection.start();
        expect(connection.start()).toBe(retry);
        await expect(retry).resolves.toBeUndefined();
        expect(connect).toHaveBeenCalledTimes(2);
    });

    /**
     * The stale-Host incident this guards against: a detached dev Host kept running an older build after a rebuild with
     * identical version and commit (dirty checkout), so only the per-build id can prove the mismatch — and the
     * connection must replace the Host, not merely warn.
     */
    it('replaces an adopted Host whose buildId differs despite matching version and commit', async () => {
        const staleOperator = createFakeOperator({
            hostBuildId: 'build-old',
            hostCommit: 'aaaaaaa',
            hostVersion: '0.0.9',
        });
        const freshOperator = createFakeOperator({
            hostBuildId: 'build-new',
            hostCommit: 'aaaaaaa',
            hostVersion: '0.0.9',
            pid: 100,
            startedAt: 2000,
        });
        vi.mocked(ensureHost)
            .mockResolvedValueOnce(staleOperator as never)
            .mockResolvedValueOnce(freshOperator as never);
        vi.mocked(connectDesktopToHost).mockResolvedValue(createFakeHostClient() as never);
        const { connection, logger } = createConnection({
            buildId: 'build-new',
            commit: 'aaaaaaa',
            version: '0.0.9',
        });

        await connection.start();

        expect(staleOperator.request).toHaveBeenCalledWith('host.stop', {
            confirmLivePtys: true,
        });
        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'host.stale_build_replaced',
            expect.anything(),
        );
        expect(freshOperator.request).not.toHaveBeenCalledWith('host.stop', expect.anything());
        expect(connection.hostProcessId()).toBe(100);
    });

    it('replaces an adopted Host on version skew when it predates the buildId stamp', async () => {
        const staleOperator = createFakeOperator({ hostVersion: '0.0.6' });
        const freshOperator = createFakeOperator({ hostVersion: '0.0.9', pid: 100 });
        vi.mocked(ensureHost)
            .mockResolvedValueOnce(staleOperator as never)
            .mockResolvedValueOnce(freshOperator as never);
        vi.mocked(connectDesktopToHost).mockResolvedValue(createFakeHostClient() as never);
        const { connection } = createConnection({ buildId: 'build-new', version: '0.0.9' });

        await connection.start();

        expect(staleOperator.request).toHaveBeenCalledWith('host.stop', {
            confirmLivePtys: true,
        });
        expect(connection.hostProcessId()).toBe(100);
    });

    it('downgrades a still-stale replacement to a warning instead of stopping Hosts forever', async () => {
        mockHostRound({ hostBuildId: 'build-old', hostVersion: '0.0.9' });
        const { connection, logger } = createConnection({
            buildId: 'build-new',
            version: '0.0.9',
        });

        await connection.start();

        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'host.version_mismatch',
            expect.anything(),
        );
        expect(connection.hostProcessId()).toBe(999_999);
    });

    it('stays silent when the adopted Host matches this build', async () => {
        mockHostRound({ hostBuildId: 'build-a', hostVersion: '0.0.9' });
        const { connection, logger } = createConnection({ buildId: 'build-a', version: '0.0.9' });

        await connection.start();

        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'host.version_mismatch',
            expect.anything(),
        );
        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'host.stale_build_replaced',
            expect.anything(),
        );
    });

    it('reconnects after connection loss and re-announces Desktop readiness', async () => {
        vi.useFakeTimers();
        const first = mockHostRound();
        const { connection, logger } = createConnection();
        await connection.start();
        await connection.markDesktopReady();
        expect(first.markDesktopReady).toHaveBeenCalledTimes(1);

        const replacement = mockHostRound();
        first.triggerClose();
        await expect(connection.request('app.health')).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(logger.write).toHaveBeenCalledWith('warn', 'host.connection_lost', {});

        await vi.advanceTimersByTimeAsync(500);
        expect(logger.write).toHaveBeenCalledWith('info', 'host.reconnected', {
            fields: { attempt: 1, downtimeMs: 500, isHostReplaced: false },
        });
        expect(replacement.markDesktopReady).toHaveBeenCalledTimes(1);
        await expect(connection.request('app.health')).resolves.toBeDefined();
    });

    it('announces a Renderer resync event once the reconnect succeeds', async () => {
        vi.useFakeTimers();
        const first = mockHostRound();
        const { connection } = createConnection();
        const received: unknown[] = [];
        connection.onEvent((event) => received.push(event));
        await connection.start();

        mockHostRound({ pid: 77, startedAt: 2000 });
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

    it('keeps retrying with backoff while the Host stays down', async () => {
        vi.useFakeTimers();
        const first = mockHostRound();
        const { connection, logger } = createConnection();
        await connection.start();

        vi.mocked(ensureHost).mockRejectedValue(new Error('host is still down'));
        first.triggerClose();

        await vi.advanceTimersByTimeAsync(500);
        expect(logger.write).toHaveBeenCalledWith('warn', 'host.reconnect_failed', {
            fields: { attempt: 1, error: 'host is still down' },
        });

        const replacement = mockHostRound();
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.write).toHaveBeenCalledWith('info', 'host.reconnected', {
            fields: { attempt: 2, downtimeMs: 1500, isHostReplaced: false },
        });
        expect(replacement.onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying when the replacement is lost while re-announcing readiness', async () => {
        vi.useFakeTimers();
        const first = mockHostRound();
        const { connection, logger } = createConnection();
        await connection.start();
        await connection.markDesktopReady();

        const flaky = mockHostRound();
        flaky.markDesktopReady.mockImplementation(() => {
            flaky.triggerClose();
            return Promise.reject(new Error('lease revoked mid-announce'));
        });
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);
        expect(flaky.markDesktopReady).toHaveBeenCalledTimes(1);

        const stable = mockHostRound();
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.write).toHaveBeenCalledWith('info', 'host.reconnected', {
            fields: { attempt: 2, downtimeMs: 1500, isHostReplaced: false },
        });
        expect(stable.markDesktopReady).toHaveBeenCalledTimes(1);
        await expect(connection.request('app.health')).resolves.toBeDefined();
    });

    it('preserves the event cursor when reconnecting to the same Host process', async () => {
        vi.useFakeTimers();
        const first = mockHostRound();
        const { connection } = createConnection();
        await connection.start();
        expect(first.request).toHaveBeenCalledWith('events.recover', { afterCursor: 0 });
        first.triggerEvent({
            cursor: 1,
            event: { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        });

        const replacement = mockHostRound();
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith('events.recover', { afterCursor: 1 });
    });

    it('resets the event cursor when a different Host process takes over', async () => {
        vi.useFakeTimers();
        const first = mockHostRound();
        const { connection } = createConnection();
        await connection.start();
        first.triggerEvent({
            cursor: 1,
            event: { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        });

        const replacement = mockHostRound({ pid: 77, startedAt: 2000 });
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith('events.recover', { afterCursor: 0 });
    });

    it('does not reconnect after an intentional close', async () => {
        vi.useFakeTimers();
        const client = mockHostRound();
        const { connection, logger } = createConnection();
        await connection.start();

        connection.close();
        client.triggerClose();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(logger.write).not.toHaveBeenCalledWith('warn', 'host.connection_lost', {});
        expect(logger.write).not.toHaveBeenCalledWith(
            'info',
            'host.reconnected',
            expect.anything(),
        );
    });
});
