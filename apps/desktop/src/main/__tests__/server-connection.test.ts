import type { ServerSupervisionEvent } from '@caxri/client/supervise';
import { connectDesktopToServer, ensureServer } from '@caxri/client/supervise';
import { CaxriError } from '@caxri/protocol';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopServerSupervisor } from '../server-connection';
import { DesktopServerConnection } from '../server-connection';
import type { ServerBuildIdentity } from '../server-staleness';

vi.mock('@caxri/client/supervise', () => ({
    connectDesktopToServer: vi.fn(),
    ensureServer: vi.fn(),
    ServerArtifactSupervisor: vi.fn(),
    resolveServerArtifact: vi.fn(() =>
        Promise.resolve({
            bundleDirectory: '/app/server/bundles',
            entryPath: '/app/server/bundles/server-core.js',
            executablePath: '/app/server/runtime/bin/node',
            manifest: {},
            rootPath: '/app/server',
        }),
    ),
}));

interface FakeServerClient {
    close: ReturnType<typeof vi.fn>;
    markDesktopReady: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
    onEvent: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    requestServerOperation: ReturnType<typeof vi.fn>;
    triggerClose: (reason?: 'replaced') => void;
    triggerEvent: (envelope: unknown) => void;
}

function createFakeServerClient(): FakeServerClient {
    const closeListeners: Array<(reason?: 'replaced') => void> = [];
    const eventListeners: Array<(envelope: unknown) => void> = [];
    return {
        close: vi.fn(),
        markDesktopReady: vi.fn().mockResolvedValue(undefined),
        onClose: vi.fn((listener: (reason?: 'replaced') => void) => {
            closeListeners.push(listener);
            return () => {};
        }),
        onEvent: vi.fn((listener: (envelope: unknown) => void) => {
            eventListeners.push(listener);
            return () => {};
        }),
        request: vi.fn().mockResolvedValue({ cursor: 0, events: [], kind: 'events' }),
        requestServerOperation: vi.fn(),
        triggerClose: (reason) => {
            for (const listener of closeListeners) listener(reason);
        },
        triggerEvent: (envelope) => {
            for (const listener of eventListeners) listener(envelope);
        },
    };
}

interface FakeDesktopServerSupervisor extends DesktopServerSupervisor {
    emit(event: ServerSupervisionEvent): void;
    lossEvent?: ServerSupervisionEvent;
    releaseProcess: Mock<(pid: number) => void>;
    reportProcessLoss: Mock<(pid: number) => boolean>;
}

function createConnection(identity: ServerBuildIdentity = {}) {
    const logger = { write: vi.fn() };
    let serverSupervisor!: FakeDesktopServerSupervisor;
    // Production computes `buildId` by fingerprinting the on-disk bundles; the test seam returns it directly.
    const { buildId, ...buildIdentity } = identity;
    const connection = new DesktopServerConnection({
        buildIdentity,
        computeBuildId: () => Promise.resolve(buildId),
        createServerSupervisor: (userDataPath, launchOptions) => {
            let isFailed = false;
            let listener: ((event: ServerSupervisionEvent) => void) | undefined;
            serverSupervisor = {
                emit(event) {
                    isFailed = event.status === 'failed';
                    listener?.(event);
                },
                ensure: (timeoutMs) => ensureServer(userDataPath, launchOptions, timeoutMs),
                isFailed: () => isFailed,
                onLifecycle: (nextListener) => {
                    listener = nextListener;
                    return () => {
                        if (listener === nextListener) listener = undefined;
                    };
                },
                releaseProcess: vi.fn<(pid: number) => void>(),
                reportProcessLoss: vi.fn<(pid: number) => boolean>(() => {
                    if (!serverSupervisor.lossEvent) return false;
                    serverSupervisor.emit(serverSupervisor.lossEvent);
                    return true;
                }),
            };
            return serverSupervisor;
        },
        currentDirectory: '/app/out/main',
        cliPath: '/app/cli/caxri.cjs',
        desktopId: 'desktop-1',
        desktopLaunch: { executable: '/app/Caxri', args: [], cwd: '/app' },
        handleCommand: () => Promise.resolve(null),
        logger: logger as never,
        serverArtifactRoot: '/app/server',
        userDataPath: '/profile',
    });
    return { connection, logger, serverSupervisor };
}

interface ServerRoundOptions {
    serverBuildId?: string;
    serverCommit?: string;
    serverVersion?: string;
    pid?: number;
    startedAt?: number;
}

function createFakeOperator(options: ServerRoundOptions = {}) {
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
                      startedAt: options.startedAt ?? 1000,
                      version: options.serverVersion ?? '0.0.9',
                      ...(options.serverCommit && { commit: options.serverCommit }),
                      ...(options.serverBuildId && { buildId: options.serverBuildId }),
                  }),
        ),
    };
}

function mockServerRound(options: ServerRoundOptions = {}): FakeServerClient {
    const client = createFakeServerClient();
    vi.mocked(ensureServer).mockResolvedValue(createFakeOperator(options) as never);
    vi.mocked(connectDesktopToServer).mockResolvedValue(client as never);
    return client;
}

describe('Desktop Server connection facade', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('forwards the bounded Terminal backpressure seam only through the E2E Server environment', async () => {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS', '1000');
        mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });

        await connection.start();

        expect(vi.mocked(ensureServer).mock.calls[0]?.[1]?.environment).toMatchObject({
            CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS: '1000',
        });
    });

    it('returns a classified rejected Promise before Server attachment instead of throwing', async () => {
        const { connection } = createConnection();
        let request: Promise<unknown> | undefined;

        expect(() => {
            request = connection.request('app.health');
        }).not.toThrow();
        await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('routes Terminal Home-link resolution through the Desktop-authenticated Runtime channel', async () => {
        const client = mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        client.requestServerOperation.mockResolvedValueOnce({
            status: 'authorization_required',
            path: '/Users/test/file.ts',
            sourceSessionId: 'session-1',
        });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });
        await connection.start();

        await expect(
            connection.request('terminal.fileLink.resolve', {
                terminalId: 'terminal-1',
                target: '~/file.ts',
            }),
        ).resolves.toMatchObject({ status: 'authorization_required' });
        expect(client.requestServerOperation).toHaveBeenCalledWith(
            'terminal.fileLink.resolve',
            { terminalId: 'terminal-1', target: '~/file.ts' },
            undefined,
        );
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
     * The stale-Server incident this guards against: a detached dev Server kept running an older build after a rebuild
     * with identical version and commit (dirty checkout), so only the per-build id can prove the mismatch — and the
     * connection must replace the Server, not merely warn.
     */
    it('replaces an adopted Server whose buildId differs despite matching version and commit', async () => {
        const staleOperator = createFakeOperator({
            serverBuildId: 'build-old',
            serverCommit: 'aaaaaaa',
            serverVersion: '0.0.9',
        });
        const freshOperator = createFakeOperator({
            serverBuildId: 'build-new',
            serverCommit: 'aaaaaaa',
            serverVersion: '0.0.9',
            pid: 100,
            startedAt: 2000,
        });
        vi.mocked(ensureServer)
            .mockResolvedValueOnce(staleOperator as never)
            .mockResolvedValueOnce(freshOperator as never);
        vi.mocked(connectDesktopToServer).mockResolvedValue(createFakeServerClient() as never);
        const { connection, logger, serverSupervisor } = createConnection({
            buildId: 'build-new',
            commit: 'aaaaaaa',
            version: '0.0.9',
        });

        await connection.start();

        expect(staleOperator.request).toHaveBeenCalledWith('host.stop', {
            confirmLivePtys: true,
        });
        expect(serverSupervisor.releaseProcess).toHaveBeenCalledWith(999_999);
        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'server_connection.stale_build_replaced',
            expect.anything(),
        );
        expect(freshOperator.request).not.toHaveBeenCalledWith('host.stop', expect.anything());
        expect(connection.serverProcessId()).toBe(100);
    });

    it('replaces an adopted Server on version skew when it predates the buildId stamp', async () => {
        const staleOperator = createFakeOperator({ serverVersion: '0.0.6' });
        const freshOperator = createFakeOperator({ serverVersion: '0.0.9', pid: 100 });
        vi.mocked(ensureServer)
            .mockResolvedValueOnce(staleOperator as never)
            .mockResolvedValueOnce(freshOperator as never);
        vi.mocked(connectDesktopToServer).mockResolvedValue(createFakeServerClient() as never);
        const { connection } = createConnection({ buildId: 'build-new', version: '0.0.9' });

        await connection.start();

        expect(staleOperator.request).toHaveBeenCalledWith('host.stop', {
            confirmLivePtys: true,
        });
        expect(connection.serverProcessId()).toBe(100);
    });

    it('downgrades a still-stale replacement to a warning instead of stopping Hosts forever', async () => {
        mockServerRound({ serverBuildId: 'build-old', serverVersion: '0.0.9' });
        const { connection, logger } = createConnection({
            buildId: 'build-new',
            version: '0.0.9',
        });

        await connection.start();

        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'server_connection.version_mismatch',
            expect.anything(),
        );
        expect(connection.serverProcessId()).toBe(999_999);
    });

    /**
     * Regression for the replacement storm: the one-shot downgrade used to live inside a single `connect()` call, so
     * every background reconnect restarted the replacement and a persistent mismatch (e.g. two Desktops of different
     * builds sharing one Server) became an endless kill/spawn loop of error toasts.
     */
    it('replaces a persistently stale Server at most once per connection across reconnects', async () => {
        vi.useFakeTimers();
        const operator = createFakeOperator({ serverBuildId: 'build-old', serverVersion: '0.0.9' });
        vi.mocked(ensureServer).mockResolvedValue(operator as never);
        const first = createFakeServerClient();
        vi.mocked(connectDesktopToServer).mockResolvedValue(first as never);
        const { connection, logger } = createConnection({
            buildId: 'build-new',
            version: '0.0.9',
        });
        const stopCallCount = () =>
            operator.request.mock.calls.filter(([method]) => method === 'host.stop').length;

        await connection.start();
        expect(stopCallCount()).toBe(1);
        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            'server_connection.version_mismatch',
            expect.anything(),
        );

        vi.mocked(connectDesktopToServer).mockResolvedValue(createFakeServerClient() as never);
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);
        expect(logger.write).toHaveBeenCalledWith(
            'info',
            'server_connection.reconnected',
            expect.anything(),
        );
        expect(stopCallCount()).toBe(1);
    });

    it('stays silent when the adopted Server matches this build', async () => {
        mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        const { connection, logger } = createConnection({ buildId: 'build-a', version: '0.0.9' });

        await connection.start();

        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'server_connection.version_mismatch',
            expect.anything(),
        );
        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'server_connection.stale_build_replaced',
            expect.anything(),
        );
    });

    it('reconnects after connection loss and re-announces Desktop readiness', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection, logger } = createConnection();
        await connection.start();
        await connection.markDesktopReady();
        expect(first.markDesktopReady).toHaveBeenCalledTimes(1);

        const replacement = mockServerRound();
        first.triggerClose();
        await expect(connection.request('app.health')).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(logger.write).toHaveBeenCalledWith('warn', 'server_connection.lost', {});

        await vi.advanceTimersByTimeAsync(500);
        expect(logger.write).toHaveBeenCalledWith('info', 'server_connection.reconnected', {
            fields: { attempt: 1, downtimeMs: 500, isHostReplaced: false },
        });
        expect(replacement.markDesktopReady).toHaveBeenCalledTimes(1);
        await expect(connection.request('app.health')).resolves.toBeDefined();
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
        replacement.request.mockResolvedValueOnce({
            cursor: 1,
            events: [
                {
                    cursor: 1,
                    event: {
                        event: 'runtime.status',
                        payload: { restartCount: 0, status: 'ready' },
                    },
                },
            ],
            kind: 'events',
        });

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

    it('preserves the event cursor when reconnecting to the same Server process', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();
        expect(first.request).toHaveBeenCalledWith('events.recover', { afterCursor: 0 });
        first.triggerEvent({
            cursor: 1,
            event: { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        });

        const replacement = mockServerRound();
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith('events.recover', { afterCursor: 1 });
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
        replacement.request
            .mockResolvedValueOnce({ cursor: 0, events: [], kind: 'events' })
            .mockResolvedValueOnce({
                cursor: 1,
                kind: 'events',
                events: [
                    {
                        cursor: 1,
                        event: {
                            event: 'state.changed',
                            payload: { kind: 'full', reason: 'unknown' },
                        },
                    },
                ],
            });
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.markDesktopReady).toHaveBeenCalledTimes(1);
        expect(replacement.request).toHaveBeenNthCalledWith(1, 'events.recover', {
            afterCursor: 0,
        });
        expect(replacement.request).toHaveBeenNthCalledWith(2, 'events.recover', {
            afterCursor: 0,
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

    it('resets the event cursor when a different Server process takes over', async () => {
        vi.useFakeTimers();
        const first = mockServerRound();
        const { connection } = createConnection();
        await connection.start();
        first.triggerEvent({
            cursor: 1,
            event: { event: 'state.changed', payload: { kind: 'full', reason: 'unknown' } },
        });

        const replacement = mockServerRound({ pid: 77, startedAt: 2000 });
        first.triggerClose();
        await vi.advanceTimersByTimeAsync(500);

        expect(replacement.request).toHaveBeenCalledWith('events.recover', { afterCursor: 0 });
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
});
