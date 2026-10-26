import type {
    AgentLaunchSettings,
    AgentProvider,
    AgentThroughput,
    ProcessState,
    ServerEvent,
    TerminalRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment, AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManagerOptions } from '../terminal';
import type { ChatDelegationHooks } from './chat-delegation';
import type { SpawnChatProcess } from './chat-provider';
import type { ChatUsageContinuation } from './continuation/chat-usage-continuation';

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
    /**
     * The provider's launch settings for this Chat's Terminal; the Terminal lets a role such as the Agent Commander add
     * its own arguments on either surface.
     */
    launchSettings(provider: AgentProvider, terminal: TerminalRecord): AgentLaunchSettings;
    /**
     * The current `agents.longRunningShellCommands`, read by each Chat when a turn finishes.
     */
    longRunningShellCommands?: () => readonly string[];
    /**
     * Runs once a Chat's provider is ready, after its state is persisted as running. The Agent Commander uses it to
     * send what a restart cut off, the Chat equivalent of a PTY launch prompt.
     */
    onReady?(terminalId: string): void;
    /**
     * Runs after a Chat's provider process state is durably written (`starting`, `running`, `stopped`, `suspended`,
     * `detached`, `failed`, `dead`), the Chat counterpart of `TerminalManagerOptions.onAgentStateChanged`, so Agent
     * dispatch receipts settle when a dispatched Chat stops or fails. Clearing a hand-over marker is not reported: no
     * process changed state.
     */
    onAgentStateChanged?(terminalId: string, state: ProcessState): void;
    resolveExecutable?: TerminalManagerOptions['resolveExecutable'];
    coordinator: {
        beginTerminalLaunch(terminalId: string, launchId: string): void;
        endTerminalLaunch(terminalId: string): void;
        probeTerminal(terminalId: string): void;
        /**
         * Drops the Terminal's Agent Session binding, so its next start opens a new conversation.
         */
        prepareTerminalStart(terminalId: string): void;
    };
    observeLifecycleSignal(signal: AgentLifecycleSignal): Promise<unknown>;
    clientVersion: string;
    spawnProcess?: SpawnChatProcess;
    /**
     * Overrides how long a request that starts or steers a turn may take, so tests can exercise a late answer.
     */
    turnRequestTimeoutMs?: number;
    /**
     * The Agent Endpoint a Chat process carries (see `agentChatEndpoint`), so its `caxri` commands authenticate as that
     * Agent on either surface. `environment` prepares the generation before spawn, `activate` admits it once the
     * provider is ready, and `retire` ends it when the process exits or never started. Each is a no-op for a Terminal
     * without a prepared Endpoint.
     */
    endpoint?: AgentChatEndpoint;
    /**
     * Reads the Terminal's transcript throughput (`AgentThroughputService.read`), so a finished turn can record how
     * fast its replies were generated. Optional so a test can omit it; the turn then records its cost alone.
     */
    readThroughput?(terminalId: string): Promise<AgentThroughput | null>;
    /**
     * Reports Chat launches, exits, and human input to Agent delegation; see {@link ChatDelegationHooks}. Optional so a
     * test can omit it.
     */
    delegation?: ChatDelegationHooks;
    /**
     * The weekly usage guard and cross-Agent continuation (issues #2580, #2581). Optional so a test can build the
     * service without it.
     */
    usage?: ChatUsageContinuation;
}

export interface AgentChatEndpoint {
    activate(terminalId: string): Promise<void>;
    environment(terminal: TerminalRecord, launchId: string): Promise<NodeJS.ProcessEnv>;
    retire(terminalId: string): Promise<void>;
}
