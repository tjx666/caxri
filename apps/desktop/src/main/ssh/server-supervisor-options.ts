import type { ServerClient } from '@caxri/client/supervise';
import type { ServerManifest, SshEnvironmentState } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AskpassBridge, AskpassHandler } from './askpass';
import type { SshHostTransport } from './setup';
import type { SshConnectionOptions } from './ssh-connection';

/**
 * The SSH-specific part of the window's environment state; Main adds `kind` and `destination`.
 */
export type SshHostStateUpdate = Omit<SshEnvironmentState, 'kind' | 'destination' | 'hostIdentity'>;

export interface SshHostSeedConfig {
    keybindings?: string;
    settings?: string;
    theme?: string;
}

export interface SshHostServerSupervisorOptions {
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
    onState: (update: SshHostStateUpdate) => void;
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
    seedConfig?: () => Promise<SshHostSeedConfig>;
    sshExecutable?: string;
    /**
     * Test seam for the operator handshake.
     */
    connectOperator?: (manifest: ServerManifest, timeoutMs: number) => Promise<ServerClient>;
    /**
     * Test seam for the SSH transport.
     */
    createTransport?: (options: SshConnectionOptions) => SshHostTransport;
    /**
     * Test seam for the askpass bridge; production uses `AskpassBridge.create`.
     */
    createAskpass?: () => Promise<Pick<AskpassBridge, 'beginAttempt' | 'close' | 'environment'>>;
}
