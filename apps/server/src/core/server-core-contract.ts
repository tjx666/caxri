import type { StructuredLogger } from '@caxri/system';

import type { TerminalExecutionPort } from '../domains/terminal';
import type { CreateDomainServices } from './domain-service';
import type { ServerProfileLease } from './profile';

export interface ServerCoreOptions {
    agentHooksPath?: string;
    /**
     * Unique identity of the loaded build; version and commit cannot distinguish two dev builds.
     */
    buildId?: string;
    cliPath?: string;
    commit: string;
    /**
     * Test seam for fault injection below the public Server transport.
     */
    createDomainServices?: CreateDomainServices;
    executable?: string;
    extensionHostPath?: string;
    extensionRoots?: string[];
    /**
     * Test seam for the idle-exit sweep interval (see `docs/adr/0010-server-core-idle-exit.md`); production always uses
     * `DEFAULT_IDLE_EXIT_MS`. `apps/server/src/core/process.ts` also reads the internal `CAXRI_SERVER_IDLE_EXIT_MS`
     * environment override into this field, never a user-facing setting.
     */
    idleExitThresholdMs?: number;
    includeTestExtensions?: boolean;
    launchDesktop?: () => Promise<void>;
    logger?: StructuredLogger;
    /**
     * Test-only label for isolated mobile Acceptance captures.
     */
    mobileHostDisplayName?: string;
    /**
     * Directory with the Android update bundle (`manifest.json` + APK) shipped with this Desktop build.
     */
    mobileUpdateDirectory?: string;
    projectSearch?: { executablePath: string; workerPath: string };
    /**
     * Test seam; production creates the process-backed Terminal execution owner.
     */
    terminalExecution?: TerminalExecutionPort;
    terminalHostPath?: string;
    userDataPath: string;
    version: string;
}

export interface ServerCore {
    lease: ServerProfileLease;
    protocolIdentity: { serverId: string; stateEpoch: string };
    /**
     * Resolves when the Core has closed mutation admission and started graceful shutdown.
     */
    stopping: Promise<void>;
    /**
     * Resolves after every Core-owned service and profile resource has stopped cleanly.
     */
    stopped: Promise<void>;
    stop(reason?: string): Promise<void>;
}
