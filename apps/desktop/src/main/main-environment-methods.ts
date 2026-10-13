import type { EnvironmentState, MainRequest, SshHostEntry } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * The calling window's environment and the SSH Host registry behind the `environment.*` and `remote.*` methods. The
 * local Workbench answers `environment.get` with `{ kind: 'local' }`; `environmentMethodScopes` keeps the SSH-only
 * methods from reaching it at all.
 */
export interface MainEnvironmentMethods {
    connect(destination: string): Promise<void>;
    get(): EnvironmentState;
    listHosts(): Promise<{ hosts: SshHostEntry[]; recent: string[] }>;
    reconnect(): Promise<void>;
    /**
     * Stops the calling SSH Host window's in-flight connection attempt; see `remote.cancel`.
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
    cancel: () => {
        throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
    },
    revealSshConfig: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'SSH Hosts are not available')),
    replyAskpass: () => {},
    stopServer: () =>
        Promise.reject(new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window')),
};

type EnvironmentRequest = Extract<MainRequest, { method: 'environment.get' | `remote.${string}` }>;

export function isEnvironmentRequest(request: MainRequest): request is EnvironmentRequest {
    return request.method === 'environment.get' || request.method.startsWith('remote.');
}

/**
 * Answers the `environment.*` and `remote.*` Main methods from the calling window's environment.
 */
export async function handleEnvironmentRequest(
    request: EnvironmentRequest,
    environment: MainEnvironmentMethods,
): Promise<unknown> {
    switch (request.method) {
        case 'environment.get':
            return environment.get();
        case 'remote.hosts.list':
            return environment.listHosts();
        case 'remote.connect':
            await environment.connect(request.params.destination);
            return null;
        case 'remote.reconnect':
            await environment.reconnect();
            return null;
        case 'remote.cancel':
            environment.cancel();
            return null;
        case 'remote.sshConfig.reveal':
            await environment.revealSshConfig();
            return null;
        case 'remote.stopServer':
            return environment.stopServer();
        case 'remote.askpass.reply':
            environment.replyAskpass(request.params.requestId, request.params.response);
            return null;
    }
}
