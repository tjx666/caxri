import type { AgentLaunchSettings, AgentProvider, ServerEvent } from '@caxri/protocol';
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
}
