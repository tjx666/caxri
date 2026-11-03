import type {
    EnvironmentState,
    HostPreferences,
    MainRequest,
    SshEnvironmentState,
    SshHostEntry,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { HostPreferenceChange } from './ssh/environments/host-preferences';

/**
 * The request's environment and the SSH Host registry behind the `environment.*` and `sshHost.*` methods. The local
 * Server answers `environment.get` with `{ kind: 'local' }`; `environmentMethodScopes` keeps the SSH-only methods from
 * reaching it at all.
 */
export interface MainEnvironmentMethods {
    /**
     * Answers the connected environment's id.
     */
    connect(destination: string): Promise<string>;
    /**
     * Detaches the request's SSH Host; see `sshHost.disconnect`.
     */
    disconnect(): Promise<void>;
    get(): EnvironmentState;
    list(): SshEnvironmentState[];
    listHosts(): Promise<{ hosts: SshHostEntry[]; recent: string[] }>;
    reconnect(): Promise<void>;
    /**
     * Ends the request's SSH Host's reconnect backoff wait; see `sshHost.retryNow`.
     */
    retryNow(): boolean;
    /**
     * Stops the request's SSH Host's in-flight connection attempt; see `sshHost.cancel`.
     */
    cancel(): void;
    revealSshConfig(): Promise<void>;
    replyAskpass(requestId: string, response: string | null): void;
    stopServer(): Promise<{ canceled: boolean }>;
    /**
     * This Mac's display preferences for every machine; see `sshHost.preferences.*`.
     */
    preferences: {
        get(): Promise<HostPreferences>;
        update(hostId: string, change: HostPreferenceChange): Promise<HostPreferences>;
        setShowHostNames(shouldShowHostNames: boolean): Promise<HostPreferences>;
    };
}

/**
 * A local environment without SSH Host support, which is what focused handler tests need.
 */
export const unconfiguredEnvironment: MainEnvironmentMethods = {
    connect: () => Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
    disconnect: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'The SSH Host is not connected')),
    get: () => ({ kind: 'local' }),
    list: () => [],
    listHosts: () => Promise.resolve({ hosts: [], recent: [] }),
    reconnect: () => Promise.reject(new CaxriError('UNAVAILABLE', 'The SSH Host is not connected')),
    retryNow: () => {
        throw new CaxriError('UNAVAILABLE', 'The SSH Host is not connected');
    },
    cancel: () => {
        throw new CaxriError('UNAVAILABLE', 'The SSH Host is not connected');
    },
    revealSshConfig: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
    replyAskpass: () => {},
    preferences: {
        get: () => Promise.resolve({ shouldShowHostNames: false, hosts: {} }),
        update: () => Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
        setShowHostNames: () =>
            Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
    },
    stopServer: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'The SSH Host is not connected')),
};

type EnvironmentRequest = Extract<MainRequest, { method: 'environment.get' | `sshHost.${string}` }>;

export function isEnvironmentRequest(request: MainRequest): request is EnvironmentRequest {
    return request.method === 'environment.get' || request.method.startsWith('sshHost.');
}

/**
 * Answers the `environment.*` and `sshHost.*` Main methods for the request's environment.
 */
export async function handleEnvironmentRequest(
    request: EnvironmentRequest,
    environment: MainEnvironmentMethods,
): Promise<unknown> {
    switch (request.method) {
        case 'environment.get':
            return environment.get();
        case 'sshHost.hosts.list':
            return environment.listHosts();
        case 'sshHost.environments.list':
            return environment.list();
        case 'sshHost.connect':
            return { environmentId: await environment.connect(request.params.destination) };
        case 'sshHost.disconnect':
            await environment.disconnect();
            return null;
        case 'sshHost.reconnect':
            await environment.reconnect();
            return null;
        case 'sshHost.retryNow':
            return environment.retryNow();
        case 'sshHost.cancel':
            environment.cancel();
            return null;
        case 'sshHost.sshConfig.reveal':
            await environment.revealSshConfig();
            return null;
        case 'sshHost.stopServer':
            return environment.stopServer();
        case 'sshHost.preferences.get':
            return environment.preferences.get();
        case 'sshHost.preferences.update': {
            const { hostId, ...change } = request.params;
            return environment.preferences.update(hostId, change);
        }
        case 'sshHost.preferences.setShowHostNames':
            return environment.preferences.setShowHostNames(request.params.shouldShowHostNames);
        case 'sshHost.askpass.reply':
            environment.replyAskpass(request.params.requestId, request.params.response);
            return null;
    }
}
