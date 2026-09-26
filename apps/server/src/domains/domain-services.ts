import type {
    AgentProvider,
    ServerEvent,
    ServerOperation,
    ServerOperationParameters,
    ServerOperationResult,
    WorkbenchRequestContext,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointLifecycle } from './agent-endpoints';
import type { AgentAdapter, AgentEnvironment } from './agents';
import type { ProtocolRecoveryState } from './protocol-recovery';
import type { TerminalExecutionPort, TerminalManagerOptions } from './terminal';

export type DomainHandlers = {
    [M in ServerOperation]: (
        parameters: ServerOperationParameters<M>,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ) => Promise<ServerOperationResult<M>> | ServerOperationResult<M>;
};

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
    projectSearch?: { executablePath: string; workerPath: string };
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

export interface DomainServices {
    handlers: DomainHandlers;
    protocolRecovery: ProtocolRecoveryState;
    /**
     * Releases every owned resource: schedulers, PTYs, watchers, and the database.
     */
    close(): Promise<void>;
    validateRequestContext(context: WorkbenchRequestContext): void;
}
