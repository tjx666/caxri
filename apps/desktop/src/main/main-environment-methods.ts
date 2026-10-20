import type { EnvironmentState, MainRequest, SshHostEntry } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * The calling window's environment and the SSH Host registry behind the `environment.*` and `sshHost.*` methods. The
 * local Workbench answers `environment.get` with `{ kind: 'local' }`; `environmentMethodScopes` keeps the SSH-only
 * methods from reaching it at all.
 */
export interface MainEnvironmentMethods {
    connect(destination: string): Promise<void>;
    get(): EnvironmentState;
    listHosts(): Promise<{ hosts: SshHostEntry[]; recent: string[] }>;
    reconnect(): Promise<void>;
    /**
     * Ends the calling SSH Host window's reconnect backoff wait; see `sshHost.retryNow`.
     */
    retryNow(): boolean;
    /**
     * Stops the calling SSH Host window's in-flight connection attempt; see `sshHost.cancel`.
     */
    cancel(): void;
    revealSshConfig(): Promise<void>;
    replyAskpass(requestId: string, response: string | null): void;
    stopServer(): Promise<{ canceled: boolean }>;
}

/**
 * A local environment without SSH Host support, which is what focused handler tests need.
 */
export const unconfiguredEnvironment: MainEnvironmentMethods = {
    connect: () => Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
    get: () => ({ kind: 'local' }),
    listHosts: () => Promise.resolve({ hosts: [], recent: [] }),
    reconnect: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window')),
    retryNow: () => {
        throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
    },
    cancel: () => {
        throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
    },
    revealSshConfig: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
    replyAskpass: () => {},
    stopServer: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window')),
};

type EnvironmentRequest = Extract<MainRequest, { method: 'environment.get' | `sshHost.${string}` }>;

export function isEnvironmentRequest(request: MainRequest): request is EnvironmentRequest {
    return request.method === 'environment.get' || request.method.startsWith('sshHost.');
}

/**
 * Answers the `environment.*` and `sshHost.*` Main methods from the calling window's environment.
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
        case 'sshHost.connect':
            await environment.connect(request.params.destination);
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
        case 'sshHost.askpass.reply':
            environment.replyAskpass(request.params.requestId, request.params.response);
            return null;
    }
}
