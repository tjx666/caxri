import process from 'node:process';

import type {
    ServerClient,
    ServerLaunchOptions,
    ServerSupervisionEvent,
} from '@caxri/client/supervise';
import { connectDesktopToServer, connectDesktopWithCredential } from '@caxri/client/supervise';
import type {
    DesktopOperation,
    DesktopTargetPayload,
    ServerDesktopCredential,
    ServerDesktopLaunch,
    ServerManifest,
} from '@caxri/protocol';
import type { E2EAgentPolicy, StructuredLogger } from '@caxri/system';

import { runDesktopCommand } from './desktop-command-scope';
import type { ServerBuildIdentity } from './server-staleness';

type DesktopCommandHandler = (
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
) => Promise<unknown>;

export interface DesktopServerSupervisor {
    ensure(timeoutMs?: number): Promise<ServerClient>;
    /**
     * Waits for a stopped Server process to disappear. Optional because the local default probes this machine's PID
     * table; an SSH Host supervisor answers from the remote machine instead.
     */
    waitForExit?(pid: number, timeoutMs: number): Promise<void>;
    isFailed(): boolean;
    onLifecycle(listener: (event: ServerSupervisionEvent) => void): () => void;
    releaseProcess(pid: number): void;
    reportProcessLoss(pid: number): boolean;
}

/**
 * Construction options for `DesktopServerConnection`, including the seams an SSH Host connection replaces.
 */
export interface DesktopServerConnectionOptions {
    agentHooksPath?: string;
    /**
     * This Desktop build's commit/version identity, compared against `host.status` to replace a detached Server still
     * running an older build. The `buildId` half is never passed in: it is a content fingerprint of the on-disk Server
     * artifact bundles computed per connection attempt (see `computeBuildFingerprint`), because a build-time identifier
     * baked into the window bundle diverges from the Server artifact during development.
     */
    buildIdentity: ServerBuildIdentity;
    /**
     * Test seam for the on-disk bundle fingerprint; production uses `computeBuildFingerprint`.
     */
    computeBuildId?: (outputDirectory: string) => Promise<string | undefined>;
    /**
     * Test seam for the shared artifact supervision contract.
     */
    createServerSupervisor?: (
        userDataPath: string,
        launchOptions: ServerLaunchOptions,
    ) => DesktopServerSupervisor;
    cliPath: string;
    currentDirectory: string;
    desktopId: string;
    /**
     * Reads the Server manifest and Desktop credential for the Desktop attachment. The default reads the local
     * profile's private discovery files; an SSH Host connection returns the remote Server's documents with the endpoint
     * rewritten to its local port forward.
     */
    discoverDesktop?: () => Promise<{
        credential: ServerDesktopCredential;
        manifest: ServerManifest;
    }>;
    desktopLaunch: ServerDesktopLaunch;
    e2eAgentPolicy?: E2EAgentPolicy;
    handleCommand: DesktopCommandHandler;
    logger: StructuredLogger;
    serverArtifactRoot: string;
    userDataPath: string;
}

const SERVER_REPLACEMENT_EXIT_TIMEOUT_MS = 10_000;

/**
 * Waits for a stopped Server process to disappear so `ensureServer` re-discovery cannot race the old manifest. Signal 0
 * only probes liveness; an `ESRCH` throw means the process is gone. On timeout the caller simply proceeds; the final
 * attempt downgrades a still-stale Server to a warning.
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential liveness polling by design
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/**
 * Waits for a stopped Server process through the supervisor when it can answer for the machine that runs the Server,
 * falling back to this machine's PID table.
 */
export function waitForServerExit(supervisor: DesktopServerSupervisor, pid: number): Promise<void> {
    return supervisor.waitForExit
        ? supervisor.waitForExit(pid, SERVER_REPLACEMENT_EXIT_TIMEOUT_MS)
        : waitForProcessExit(pid, SERVER_REPLACEMENT_EXIT_TIMEOUT_MS);
}

/**
 * Attaches as Desktop with every command handler run inside its Desktop command scope. Without `discoverDesktop` this
 * reads the local profile's discovery files; otherwise it uses the documents that hook returns.
 */
export async function connectDesktopAttachment(
    options: DesktopServerConnectionOptions,
): Promise<ServerClient> {
    const handleCommand = (
        operation: DesktopOperation,
        consumeTarget: () => Promise<DesktopTargetPayload>,
    ): Promise<unknown> =>
        runDesktopCommand(operation, () => options.handleCommand(operation, consumeTarget));
    if (!options.discoverDesktop)
        return connectDesktopToServer(options.userDataPath, options.desktopId, handleCommand);
    const { credential, manifest } = await options.discoverDesktop();
    return connectDesktopWithCredential(manifest, credential, options.desktopId, handleCommand);
}
