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
import type { TerminalManagerOptions } from './terminal';

export type DomainHandlers = {
    [M in ServerOperation]: (
        parameters: ServerOperationParameters<M>,
        signal?: AbortSignal,
    ) => Promise<ServerOperationResult<M>> | ServerOperationResult<M>;
};

/**
 * Environment-owned seams supplied to the domain-service composition root.
 */
export interface DomainDependencies {
    userDataPath: string;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
    startedAt?: number;
    pid?: number;
    agentRefreshDelayMs?: number;
    terminal?: TerminalManagerOptions;
    terminalRestoreGridWaitMs?: number;
    agentAdapters?: Record<AgentProvider, AgentAdapter>;
    agentEnvironment?: AgentEnvironment;
    agentHooksPath?: string;
    hookExecutable?: string;
    agentEndpoints?: AgentEndpointLifecycle;
}

export interface DomainServices {
    handlers: DomainHandlers;
    /**
     * Releases every owned resource: schedulers, PTYs, watchers, and the database.
     */
    close(): Promise<void>;
    validateRequestContext(context: WorkbenchRequestContext): void;
}
