import { describe, expect, it, vi } from 'vitest';

import { createLocalWorkbenchEnvironment } from '../local-workbench-environment';
import type { MainEnvironmentMethods } from '../main-environment-methods';
import { handleEnvironmentRequest, isEnvironmentRequest } from '../main-environment-methods';
import type { SshHostEnvironments } from '../ssh/host-environments';

function environmentMethods() {
    const connect = vi.fn<MainEnvironmentMethods['connect']>(() => Promise.resolve());
    const replyAskpass = vi.fn<MainEnvironmentMethods['replyAskpass']>();
    const methods: MainEnvironmentMethods = {
        cancel: vi.fn(),
        connect,
        get: vi.fn(() => ({ kind: 'local' as const })),
        listHosts: vi.fn(() => Promise.resolve({ hosts: [], recent: ['dev@build-box'] })),
        reconnect: vi.fn(() => Promise.resolve()),
        retryNow: vi.fn(() => true),
        replyAskpass,
        revealSshConfig: vi.fn(() => Promise.resolve()),
        stopServer: vi.fn(() => Promise.resolve({ canceled: false })),
    };
    return { connect, methods, replyAskpass };
}

describe('Main environment methods', () => {
    it('claims only the environment and SSH Host methods', () => {
        expect(isEnvironmentRequest({ method: 'environment.get', params: {} } as never)).toBe(true);
        expect(isEnvironmentRequest({ method: 'sshHost.stopServer', params: {} } as never)).toBe(
            true,
        );
        expect(isEnvironmentRequest({ method: 'argv.get', params: {} } as never)).toBe(false);
    });

    it('routes each request to the calling window environment', async () => {
        const { connect, methods: environment, replyAskpass } = environmentMethods();

        await expect(
            handleEnvironmentRequest(
                { method: 'sshHost.connect', params: { destination: 'dev@build-box' } } as never,
                environment,
            ),
        ).resolves.toBeNull();
        await expect(
            handleEnvironmentRequest(
                {
                    method: 'sshHost.askpass.reply',
                    params: { requestId: 'r1', response: null },
                } as never,
                environment,
            ),
        ).resolves.toBeNull();
        await expect(
            handleEnvironmentRequest(
                { method: 'sshHost.stopServer', params: {} } as never,
                environment,
            ),
        ).resolves.toEqual({ canceled: false });

        await expect(
            handleEnvironmentRequest(
                { method: 'sshHost.retryNow', params: {} } as never,
                environment,
            ),
        ).resolves.toBe(true);

        expect(connect).toHaveBeenCalledWith('dev@build-box');
        expect(replyAskpass).toHaveBeenCalledWith('r1', null);
    });

    it('refuses to connect from the local Workbench before the SSH Host registry exists', async () => {
        const local = createLocalWorkbenchEnvironment(() => {});

        await expect(local.connect('dev@build-box')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect(local.listHosts()).resolves.toEqual({ hosts: [], recent: [] });
        expect(local.get()).toEqual({ kind: 'local' });
        await expect(local.reconnect()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('hands the local Workbench connect to the SSH Host registry once it exists', async () => {
        const connect = vi.fn(() => Promise.resolve());
        const local = createLocalWorkbenchEnvironment(
            () => ({ connect }) as unknown as SshHostEnvironments,
        );

        await local.connect('dev@build-box');

        expect(connect).toHaveBeenCalledWith('dev@build-box');
    });
});
