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
    includeTestExtensions?: boolean;
    launchDesktop?: () => Promise<void>;
    logger?: StructuredLogger;
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
    stop(reason?: string): Promise<void>;
}
