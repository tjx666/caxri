import process from 'node:process';

import { connectDesktopToHost, ensureHost } from '@caxri/cli';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopHostConnection } from '../host-connection';

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

function createConnection() {
    const logger = { write: vi.fn() };
    const connection = new DesktopHostConnection({
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

function mockHostRound(
    options: { hostCommit?: string; hostVersion?: string; pid?: number; startedAt?: number } = {},
): FakeHostClient {
    const client = createFakeHostClient();
    vi.mocked(ensureHost).mockResolvedValue({
        close: vi.fn(),
        request: vi.fn().mockResolvedValue({
            pid: options.pid ?? 42,
            runtimePid: 43,
            startedAt: options.startedAt ?? 1000,
            version: options.hostVersion ?? process.env.CAXRI_APP_VERSION ?? '0.0.9',
            ...(options.hostCommit && { commit: options.hostCommit }),
        }),
    } as never);
    vi.mocked(connectDesktopToHost).mockResolvedValue(client as never);
    return client;
}

const originalAppVersion = process.env.CAXRI_APP_VERSION;
const originalGitCommit = process.env.CAXRI_GIT_COMMIT;

function restoreEnvironment(key: string, original: string | undefined): void {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
}

describe('Desktop Host connection facade', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        restoreEnvironment('CAXRI_APP_VERSION', originalAppVersion);
        restoreEnvironment('CAXRI_GIT_COMMIT', originalGitCommit);
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

    it('warns when the adopted Host runs a different build than this Desktop', async () => {
        process.env.CAXRI_APP_VERSION = '0.0.9';
        delete process.env.CAXRI_GIT_COMMIT;
        mockHostRound({ hostVersion: '0.0.6' });
        const { connection, logger } = createConnection();

        await connection.start();

        expect(logger.write).toHaveBeenCalledWith('warn', 'host.version_mismatch', {
            fields: {
                desktopCommit: 'unknown',
                desktopVersion: '0.0.9',
                hostCommit: 'unknown',
                hostPid: 42,
                hostVersion: '0.0.6',
            },
        });
    });

    it('warns on a commit skew even when the package version matches', async () => {
        process.env.CAXRI_APP_VERSION = '0.0.9';
        process.env.CAXRI_GIT_COMMIT = 'bbbbbbb';
        mockHostRound({ hostCommit: 'aaaaaaa', hostVersion: '0.0.9' });
        const { connection, logger } = createConnection();

        await connection.start();

        expect(logger.write).toHaveBeenCalledWith('warn', 'host.version_mismatch', {
            fields: {
                desktopCommit: 'bbbbbbb',
                desktopVersion: '0.0.9',
                hostCommit: 'aaaaaaa',
                hostPid: 42,
                hostVersion: '0.0.9',
            },
        });
    });

    it('stays silent when the adopted Host matches this build', async () => {
        process.env.CAXRI_APP_VERSION = '0.0.9';
        delete process.env.CAXRI_GIT_COMMIT;
        mockHostRound({ hostVersion: '0.0.9' });
        const { connection, logger } = createConnection();

        await connection.start();

        expect(logger.write).not.toHaveBeenCalledWith(
            'warn',
            'host.version_mismatch',
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
            fields: { attempt: 1 },
        });
        expect(replacement.markDesktopReady).toHaveBeenCalledTimes(1);
        await expect(connection.request('app.health')).resolves.toBeDefined();
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
            fields: { attempt: 2 },
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
            fields: { attempt: 2 },
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
