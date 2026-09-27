import { connectDesktopToServer, ensureServer } from '@caxri/client/supervise';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createConnection,
    createFakeOperator,
    createFakeServerClient,
    mockServerRound,
} from './support/server-connection-harness';

const { superviseModuleMock } = await vi.hoisted(() => import('./support/supervise-module-mock'));

vi.mock('@caxri/client/supervise', () => superviseModuleMock());

describe('Desktop Server attachment and build identity', () => {
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

    it.each(['1', '0'])('forwards mobile fault seams only for E2E=%s', async (enabled) => {
        vi.stubEnv('CAXRI_E2E', enabled);
        vi.stubEnv('CAXRI_E2E_MOBILE_PAIRING_RESULT_DELAY', '1');
        vi.stubEnv('CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE', '1');
        mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });
        await connection.start();
        const environment = vi.mocked(ensureServer).mock.calls[0]?.[1]?.environment;
        for (const key of [
            'CAXRI_E2E_MOBILE_PAIRING_RESULT_DELAY',
            'CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE',
        ]) {
            if (enabled === '1') expect(environment).toHaveProperty(key, '1');
            else expect(environment).not.toHaveProperty(key);
        }
    });

    it('forwards the synthetic mobile host label only to an E2E Server', async () => {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME', 'Caxri Test Host');
        mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });

        await connection.start();

        expect(vi.mocked(ensureServer).mock.calls[0]?.[1]?.environment).toMatchObject({
            CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host',
        });
    });

    it('does not forward the synthetic mobile host label outside E2E', async () => {
        vi.stubEnv('CAXRI_E2E', '0');
        vi.stubEnv('CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME', 'Caxri Test Host');
        mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });

        await connection.start();

        expect(vi.mocked(ensureServer).mock.calls[0]?.[1]?.environment).not.toHaveProperty(
            'CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME',
        );
    });

    it('forwards a local mobile update directory to Server Core', async () => {
        vi.stubEnv('CAXRI_MOBILE_UPDATE_DIRECTORY', '/tmp/mobile-update');
        mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });

        await connection.start();

        expect(vi.mocked(ensureServer).mock.calls[0]?.[1]?.environment).toMatchObject({
            CAXRI_MOBILE_UPDATE_DIRECTORY: '/tmp/mobile-update',
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

    it('routes Terminal external-link resolution through the Desktop-authenticated Runtime channel', async () => {
        const client = mockServerRound({ serverBuildId: 'build-a', serverVersion: '0.0.9' });
        client.requestServerOperation.mockResolvedValueOnce({
            status: 'external',
            path: '/Users/test/file.ts',
            sourceSessionId: 'session-1',
            trusted: false,
        });
        const { connection } = createConnection({ buildId: 'build-a', version: '0.0.9' });
        await connection.start();

        await expect(
            connection.request('terminal.fileLink.resolve', {
                terminalId: 'terminal-1',
                target: '~/file.ts',
            }),
        ).resolves.toMatchObject({ status: 'external' });
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
});
