import process from 'node:process';

import { StructuredLogger } from '@caxri/system';

import type { RuntimeAgentEndpointControl } from '../domains/agent-endpoints';
import { RuntimeAgentEndpointLifecycle } from '../domains/agent-endpoints';
import { defaultAgentEnvironment } from '../domains/agents';
import { resolveE2ETerminalOutputFlushDelay } from '../domains/terminal';
import type { CreateDomainServices } from './domain-service';
import { ServerDomainService } from './domain-service';

export interface ServerDomainServiceOptions {
    agentEndpointControl: RuntimeAgentEndpointControl;
    agentHooksPath?: string;
    executable?: string;
    createServices?: CreateDomainServices;
    logDirectory: string;
    userDataPath: string;
}

/**
 * Composes the environment-owned seams for Server domain services inside Server Core.
 */
export function createServerDomainService(
    options: ServerDomainServiceOptions,
): ServerDomainService {
    const outputFlushMs = resolveE2ETerminalOutputFlushDelay(process.env);
    return new ServerDomainService(
        {
            agentEndpoints: new RuntimeAgentEndpointLifecycle(
                options.agentEndpointControl,
                options.userDataPath,
            ),
            agentEnvironment: defaultAgentEnvironment(process.env),
            agentHooksPath: options.agentHooksPath,
            logger: new StructuredLogger(options.logDirectory, 'runtime', 'info'),
            runtimeExecutable: options.executable ?? process.execPath,
            terminal: { ...(outputFlushMs !== undefined && { outputFlushMs }) },
            userDataPath: options.userDataPath,
        },
        options.createServices,
    );
}
