import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointControl } from '../domains/agent-endpoints';
import { AgentEndpointLifecycle } from '../domains/agent-endpoints';
import { defaultAgentEnvironment } from '../domains/agents';
import type { TerminalExecutionPort } from '../domains/terminal';
import type { CreateDomainServices } from './domain-service';
import { ServerDomainService } from './domain-service';

export interface ServerDomainServiceOptions {
    agentEndpointControl: AgentEndpointControl;
    agentHooksPath?: string;
    executable?: string;
    createServices?: CreateDomainServices;
    logger: StructuredLogger;
    projectSearch?: { executablePath: string; workerPath: string };
    terminalExecution: TerminalExecutionPort;
    userDataPath: string;
}

/**
 * Composes the environment-owned seams for Server domain services inside Server Core.
 */
export function createServerDomainService(
    options: ServerDomainServiceOptions,
): ServerDomainService {
    return new ServerDomainService(
        {
            agentEndpoints: new AgentEndpointLifecycle(
                options.agentEndpointControl,
                options.userDataPath,
            ),
            agentEnvironment: defaultAgentEnvironment(process.env),
            agentHooksPath: options.agentHooksPath,
            logger: options.logger,
            hookExecutable: options.executable ?? process.execPath,
            projectSearch: options.projectSearch,
            terminalExecution: options.terminalExecution,
            userDataPath: options.userDataPath,
        },
        options.createServices,
    );
}
