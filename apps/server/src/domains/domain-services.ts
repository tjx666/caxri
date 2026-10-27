import type {
    AgentProvider,
    CaxriMethod,
    DesktopServerOperation,
    ServerEvent,
    ServerMethod,
    ServerOperation,
    ServerOperationParameters,
    ServerOperationResult,
    WorkbenchRequestContext,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointLifecycle } from './agent-endpoints';
import type { AgentAdapter, AgentEnvironment } from './agents';
import type { ServerCredentialStores } from './db';
import type { ProtocolRecoveryState } from './protocol-recovery';
import type { TerminalExecutionPort, TerminalManagerOptions } from './terminal';

/**
 * Desktop-owned public methods that Electron Main answers itself and never delegates to Server Core.
 */
type MainAnsweredMethod = Exclude<CaxriMethod, ServerMethod | DesktopServerOperation>;

/**
 * Every operation a Server domain handler may serve, derived from the protocol's owner metadata: Server-owned public
 * methods, internal methods, and the `desktopServerOperationIds` Main delegates after its native step. A new
 * Desktop-owned method therefore needs no edit here; if one still reaches the dispatcher it is rejected there.
 */
export type DomainOperation = Exclude<ServerOperation, MainAnsweredMethod>;

export type DomainHandlers = {
    [M in DomainOperation]: (
        parameters: ServerOperationParameters<M>,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ) => Promise<ServerOperationResult<M>> | ServerOperationResult<M>;
};

/**
 * Search Workers bundled beside the Server. Without `session`, Session search answers from Caxri's own Sessions only.
 */
export interface SearchWorkers {
    project?: { executablePath: string; workerPath: string };
    session?: { workerPath: string };
}

/**
 * Environment-owned seams supplied to the domain-service composition root.
 */
export interface DomainDependencies {
    hasMobileAttentionRecipient?: (projectId: string) => boolean;
    userDataPath: string;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
    startedAt?: number;
    pid?: number;
    searchWorkers?: SearchWorkers;
    agentRefreshDelayMs?: number;
    /**
     * Shortened hook-turn unknown-evidence recovery window; only focused Electron coverage supplies it.
     */
    agentUnknownRecoveryMs?: number;
    terminal?: Omit<TerminalManagerOptions, 'execution'>;
    terminalExecution: TerminalExecutionPort;
    terminalRestoreGridWaitMs?: number;
    /**
     * Test-only overrides for the background Agent suspension sweep: its cadence and clock.
     */
    terminalSuspension?: { now?: () => number; sweepIntervalMs?: number };
    agentAdapters?: Record<AgentProvider, AgentAdapter>;
    agentEnvironment?: AgentEnvironment;
    agentHooksPath?: string;
    hookExecutable?: string;
    agentEndpoints?: AgentEndpointLifecycle;
}

/**
 * Runs one named domain shutdown step for Server Core's stop log; `terminals` is the orderly Terminal snapshot pass,
 * named apart because a failure there is what loses Terminal history across a restart.
 */
export type DomainShutdownStepRunner = (
    step: 'terminals',
    action: () => Promise<void>,
) => Promise<void>;

export interface DomainServices {
    handlers: DomainHandlers;
    protocolRecovery: ProtocolRecoveryState;
    /**
     * Paired-phone and delegation-client storage on the Server database, which Server Core's registries own.
     */
    credentials: ServerCredentialStores;
    /**
     * Releases every owned resource: schedulers, PTYs, watchers, and the database. `runStep` lets Server Core time and
     * name the steps worth telling apart in its shutdown log.
     */
    close(runStep?: DomainShutdownStepRunner): Promise<void>;
    /**
     * Subscribes to a change of the Session the user is in (see `WindowPresence.currentSessionId`), which has no
     * `state.changed` event of its own because moving window focus must not make every Renderer re-read the Workbench.
     */
    onActiveContextChanged?(listener: () => void): () => void;
    /**
     * A control connection closed; forget any per-connection memory state it reported (window presence).
     */
    onConnectionClosed?(connectionId: string): void;
    validateRequestContext(context: WorkbenchRequestContext): void;
}
