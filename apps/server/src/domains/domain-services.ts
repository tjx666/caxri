import type {
    AgentProvider,
    RuntimeEvent,
    RuntimeMethod,
    RuntimeMethodParams as RuntimeMethodParameters,
    RuntimeMethodResult,
    RuntimeWorkbenchContext,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { RuntimeAgentEndpointLifecycle } from './agent-endpoints';
import type { AgentAdapter, AgentEnvironment } from './agents';
import type { TerminalManagerOptions } from './terminal';

export type DomainHandlers = {
    [M in RuntimeMethod]: (
        parameters: RuntimeMethodParameters<M>,
        signal?: AbortSignal,
    ) => Promise<RuntimeMethodResult<M>> | RuntimeMethodResult<M>;
};

/**
 * Environment-owned seams supplied to the domain-service composition root.
 */
export interface DomainDependencies {
    userDataPath: string;
    logger: StructuredLogger;
    send: (event: RuntimeEvent) => void;
    startedAt?: number;
    pid?: number;
    agentRefreshDelayMs?: number;
    terminal?: TerminalManagerOptions;
    terminalRestoreGridWaitMs?: number;
    agentAdapters?: Record<AgentProvider, AgentAdapter>;
    agentEnvironment?: AgentEnvironment;
    agentHooksPath?: string;
    runtimeExecutable?: string;
    agentEndpoints?: RuntimeAgentEndpointLifecycle;
}

export interface DomainServices {
    handlers: DomainHandlers;
    /**
     * Releases every owned resource: schedulers, PTYs, watchers, and the database.
     */
    close(): Promise<void>;
    validateRequestContext(context: RuntimeWorkbenchContext): void;
}
