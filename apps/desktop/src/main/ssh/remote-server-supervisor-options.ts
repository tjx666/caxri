import type { ServerClient } from '@caxri/client/supervise';
import type { ServerManifest, SshEnvironmentState } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AskpassBridge, AskpassHandler } from './askpass';
import type { RemoteTransport } from './remote-setup';
import type { SshConnectionOptions } from './ssh-connection';

/**
 * The SSH-specific part of the window's environment state; Main adds `kind` and `destination`.
 */
export type RemoteStateUpdate = Omit<SshEnvironmentState, 'kind' | 'destination' | 'hostIdentity'>;

export interface RemoteSeedConfig {
    keybindings?: string;
    settings?: string;
    theme?: string;
}

export interface RemoteServerSupervisorOptions {
    askpass: AskpassHandler;
    /**
     * `ssh -F` override; Main sets it from `CAXRI_SSH_CONFIG` for tests and acceptance.
     */
    configFile?: string;
    destination: string;
    electronExecutable: string;
    /**
     * Opt-in inspector for the remote Server.
     */
    inspect?: boolean;
    logger: Pick<StructuredLogger, 'write'>;
    onState: (update: RemoteStateUpdate) => void;
    /**
     * Private (0700, current-user, short) directory for ControlMaster sockets and the askpass bridge.
     */
    privateDirectory: string;
    /**
     * Directory holding `linux-x64/` and `linux-arm64/` application layers with their `descriptor.json`.
     */
    remoteLayersRoot: string;
    runtimeCacheDirectory: string;
    /**
     * Desktop config to copy into a fresh remote profile; files that already exist remotely are never overwritten.
     */
    seedConfig?: () => Promise<RemoteSeedConfig>;
    sshExecutable?: string;
    /**
     * Test seam for the operator handshake.
     */
    connectOperator?: (manifest: ServerManifest, timeoutMs: number) => Promise<ServerClient>;
    /**
     * Test seam for the SSH transport.
     */
    createTransport?: (options: SshConnectionOptions) => RemoteTransport;
    /**
     * Test seam for the askpass bridge; production uses `AskpassBridge.create`.
     */
    createAskpass?: () => Promise<Pick<AskpassBridge, 'beginAttempt' | 'close' | 'environment'>>;
}
