import type { AgentLaunchSettings, AgentProvider, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from '../terminal';

export interface AgentDispatchServiceOptions {
    logger: StructuredLogger;
    database: CaxriDatabase;
    endpoints?: AgentEndpointLifecycle;
    coordinator: AgentCoordinator;
    terminals: TerminalManager;
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
