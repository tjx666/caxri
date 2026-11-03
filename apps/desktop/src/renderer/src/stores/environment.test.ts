import type { ServerEvent, SshEnvironmentState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    attach: vi.fn<(id: string) => void>(),
    detach: vi.fn<(id: string) => void>(),
    listeners: [] as Array<(event: ServerEvent, environmentId?: string) => void>,
    pushToast: vi.fn(),
    request: vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(),
}));

vi.mock('./toasts', () => ({ pushToast: mocks.pushToast }));

vi.mock('../lib/caxri', () => ({
    caxri: {
        environments: { attach: mocks.attach, detach: mocks.detach },
        onEvent: (listener: (event: ServerEvent, environmentId?: string) => void) => {
            mocks.listeners.push(listener);
            return () => {
                mocks.listeners = mocks.listeners.filter((candidate) => candidate !== listener);
            };
        },
        request: mocks.request,
    },
}));

import {
    getSshEnvironment,
    isLocalOnlyAvailable,
    isSshHost,
    setSelectedEnvironment,
    storageScopeOf,
    subscribeEnvironment,
    useEnvironmentStore,
} from './environment';

const buildBox: SshEnvironmentState = {
    kind: 'ssh',
    destination: 'build-box',
    hostIdentity: 'me@build-box:22',
    phase: 'connected',
    needsUserAction: false,
};
const gpuBox: SshEnvironmentState = {
    ...buildBox,
    destination: 'gpu-box',
    hostIdentity: 'me@gpu-box:22',
    phase: 'connecting',
};

function emitHosts(hosts: SshEnvironmentState[]): void {
    for (const listener of mocks.listeners)
        listener({ event: 'sshHost.environmentsChanged', payload: hosts });
}

function listResolving(hosts: Promise<SshEnvironmentState[]> | SshEnvironmentState[]): void {
    mocks.request.mockImplementation(async (method) => {
        if (method === 'sshHost.environments.list') return hosts;
        return null;
    });
}

afterEach(() => {
    useEnvironmentStore.setState({
        hosts: [],
        selectedEnvironmentId: undefined,
        state: { kind: 'local' },
    });
    mocks.listeners = [];
    mocks.request.mockReset();
    mocks.pushToast.mockReset();
    mocks.attach.mockReset();
    mocks.detach.mockReset();
});

describe('environment predicates', () => {
    it('answers for this Mac until a Session on an SSH Host is selected', () => {
        expect(isLocalOnlyAvailable()).toBe(true);
        expect(isSshHost()).toBe(false);
        expect(isLocalOnlyAvailable(buildBox)).toBe(false);
        expect(isSshHost(buildBox)).toBe(true);
    });

    it('keys device storage by machine', () => {
        expect(storageScopeOf(undefined)).toBe('local');
        expect(storageScopeOf('me@build-box:22')).toBe('ssh:me@build-box:22');
    });
});

describe('subscribeEnvironment', () => {
    it('stores the initial host list and attaches each connected Host', async () => {
        listResolving([buildBox, gpuBox]);
        const unsubscribe = subscribeEnvironment();
        await vi.waitFor(() => expect(useEnvironmentStore.getState().hosts).toHaveLength(2));
        expect(mocks.attach).toHaveBeenCalledExactlyOnceWith('me@build-box:22');
        expect(getSshEnvironment()).toBeUndefined();
        unsubscribe();
    });

    it('keeps a change that arrived while the initial read was in flight', async () => {
        const read = Promise.withResolvers<SshEnvironmentState[]>();
        listResolving(read.promise);
        const unsubscribe = subscribeEnvironment();
        emitHosts([buildBox]);
        read.resolve([]);
        await read.promise;
        await Promise.resolve();
        expect(useEnvironmentStore.getState().hosts).toEqual([buildBox]);
        unsubscribe();
    });

    it('ignores a Host list that an SSH Host itself sent', () => {
        listResolving([]);
        const unsubscribe = subscribeEnvironment();
        for (const listener of mocks.listeners)
            listener(
                { event: 'sshHost.environmentsChanged', payload: [gpuBox] },
                'me@build-box:22',
            );
        expect(useEnvironmentStore.getState().hosts).toEqual([]);
        unsubscribe();
    });

    it('detaches a disconnected Host and stops showing its Session', async () => {
        listResolving([buildBox]);
        const unsubscribe = subscribeEnvironment();
        await vi.waitFor(() => expect(useEnvironmentStore.getState().hosts).toHaveLength(1));
        setSelectedEnvironment('me@build-box:22');
        expect(getSshEnvironment()?.destination).toBe('build-box');

        emitHosts([]);
        expect(mocks.detach).toHaveBeenCalledWith('me@build-box:22');
        expect(useEnvironmentStore.getState().selectedEnvironmentId).toBeUndefined();
        expect(isLocalOnlyAvailable()).toBe(true);
        unsubscribe();
        emitHosts([buildBox]);
        expect(useEnvironmentStore.getState().hosts).toEqual([]);
    });

    it('explains a connect that Main answered with an existing connection', async () => {
        listResolving([buildBox]);
        const unsubscribe = subscribeEnvironment();
        await vi.waitFor(() => expect(useEnvironmentStore.getState().hosts).toHaveLength(1));
        for (const listener of mocks.listeners)
            listener(
                {
                    event: 'environment.connectionReused',
                    payload: { destination: 'build-box-direct' },
                },
                'me@build-box:22',
            );
        expect(mocks.pushToast).toHaveBeenCalledOnce();
        expect(mocks.pushToast.mock.calls[0]?.[1]).toContain('build-box-direct');
        unsubscribe();
    });

    it('ignores a read that resolves after unsubscribing', async () => {
        const read = Promise.withResolvers<SshEnvironmentState[]>();
        listResolving(read.promise);
        const unsubscribe = subscribeEnvironment();
        unsubscribe();
        read.resolve([buildBox]);
        await read.promise;
        await Promise.resolve();
        expect(useEnvironmentStore.getState().hosts).toEqual([]);
    });
});

describe('setSelectedEnvironment', () => {
    it('tells Main whether the shown Session is on this Mac, once per change', () => {
        mocks.request.mockResolvedValue(null);
        useEnvironmentStore.setState({ hosts: [buildBox] });
        setSelectedEnvironment('me@build-box:22');
        setSelectedEnvironment('me@build-box:22');
        setSelectedEnvironment(undefined);
        expect(mocks.request.mock.calls).toEqual([
            ['window.reportSelectedMachine', { isLocal: false }],
            ['window.reportSelectedMachine', { isLocal: true }],
        ]);
    });
});
