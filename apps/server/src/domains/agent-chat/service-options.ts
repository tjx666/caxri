import type {
    AgentLaunchSettings,
    AgentProvider,
    ServerEvent,
    TerminalRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment, AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManagerOptions } from '../terminal';
import type { SpawnChatProcess } from './chat-provider';

/**
 * Dependencies of `AgentChatService`, injected so tests can swap the provider process, environment, and executable.
 */
export interface AgentChatServiceOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    /**
     * Locates provider state such as Claude Code's on-disk transcript, and seeds the provider process environment.
     */
    agentEnvironment: AgentEnvironment;
    /**
     * Overrides the provider process environment derived from `agentEnvironment`, so tests can point it at fakes.
     */
    environment?: () => Promise<NodeJS.ProcessEnv>;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    resolveExecutable?: TerminalManagerOptions['resolveExecutable'];
    coordinator: {
        beginTerminalLaunch(terminalId: string, launchId: string): void;
        endTerminalLaunch(terminalId: string): void;
        probeTerminal(terminalId: string): void;
    };
    observeLifecycleSignal(signal: AgentLifecycleSignal): Promise<unknown>;
    clientVersion: string;
    spawnProcess?: SpawnChatProcess;
    /**
     * Overrides how long a request that starts or steers a turn may take, so tests can exercise a late answer.
     */
    turnRequestTimeoutMs?: number;
    /**
     * The Agent Endpoint a Chat process carries, for a Terminal that gets one; only the Agent Commander's Chat does
     * today, so its `caxri` commands keep the Commander role on either surface. `environment` prepares the generation
     * before spawn and returns no variables for a Terminal without an Endpoint, `activate` admits it once the provider
     * is ready, and `retire` ends it when the process exits or never started. Each is a no-op for a Terminal without a
     * prepared Endpoint.
     */
    endpoint?: AgentChatEndpoint;
}

export interface AgentChatEndpoint {
    activate(terminalId: string): Promise<void>;
    environment(terminal: TerminalRecord, launchId: string): Promise<NodeJS.ProcessEnv>;
    retire(terminalId: string): Promise<void>;
}
