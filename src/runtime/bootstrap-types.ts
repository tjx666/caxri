import type { RuntimeEvent } from '../shared/ipc/events';
import type { StructuredLogger } from '../shared/node/logger';
import type { AgentProvider } from '../shared/types';
import type { AgentAdapter, AgentEnvironment } from './agents';
import type { RuntimeAgentEndpointLifecycle } from './agent-endpoints';
import type { RuntimeHandlers } from './dispatch';
import type { TerminalManagerOptions } from './terminal';

/** Environment-owned seams supplied to the Runtime composition root. */
export interface RuntimeDeps {
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

export interface Runtime {
    handlers: RuntimeHandlers;
    /** Releases every owned resource: schedulers, PTYs, watchers, and the database. */
    close(): Promise<void>;
}
