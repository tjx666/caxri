import type {
    AgentLaunchSettings,
    AgentProvider,
    ServerEvent,
    TerminalRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from '../terminal';
import type { DispatchChats } from './chat-target';

export interface AgentDispatchServiceOptions {
    logger: StructuredLogger;
    database: CaxriDatabase;
    endpoints?: AgentEndpointLifecycle;
    coordinator: AgentCoordinator;
    terminals: TerminalManager;
    /**
     * Drives a Chat Terminal target (`resume`, `wake`, `terminal.sendInternal`, interrupt, stop). Without it a Chat
     * target is refused as a PTY-only operation.
     */
    agentChat?: DispatchChats;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    terminalDirectoryIdentity(path: string): Promise<TerminalWorkingDirectoryIdentity>;
    terminalWorkingDirectory(options: {
        authorizedRoots: readonly string[];
        defaultRoot: string;
        requestedCwd?: string;
    }): Promise<string>;
    emit(event: ServerEvent): void;
    now?: () => number;
}

export interface AgentDispatchStartOptions {
    delegationId?: string;
    assignedAgentSessionId?: string;
    initialPrompt?: string;
    launch: AgentLaunchSettings;
    /**
     * `chat` opens the new Agent as an Agent Chat instead of a PTY Terminal: the Chat starts with `launch` (see
     * `ChatDelegationLinks`) and receives `initialPrompt` as its first message. Requires `agentChat`.
     */
    surface?: 'chat';
    shouldStart?: () => boolean;
    cwd?: string;
    /**
     * Checks current layout capacity after async path validation, immediately before durable creation.
     */
    beforeCreate?(): void;
    /**
     * Runs after durable Terminal creation and before any provider process can start.
     */
    prepared(terminal: TerminalRecord): void;
}

/**
 * Delegation-only recovery of one frozen native session; ordinary dispatch cannot replace a running Agent.
 */
export interface AgentDispatchResumeOptions {
    delegationId?: string;
    launch: AgentLaunchSettings;
    initialPrompt: string;
    replaceLaunchId?: string;
    shouldStart?: () => boolean;
    beforeResume(): void;
}
