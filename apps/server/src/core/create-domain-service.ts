import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointControl } from '../domains/agent-endpoints';
import { AgentEndpointLifecycle } from '../domains/agent-endpoints';
import { defaultAgentEnvironment, resolveE2EAgentUnknownRecoveryMs } from '../domains/agents';
import type { SearchWorkers } from '../domains/domain-services';
import type { TerminalExecutionPort } from '../domains/terminal';
import type { CreateDomainServices } from './domain-service';
import { ServerDomainService } from './domain-service';

export interface ServerDomainServiceOptions {
    hasMobileAttentionRecipient?: (projectId: string) => boolean;
    agentEndpointControl: AgentEndpointControl;
    agentHooksPath?: string;
    executable?: string;
    createServices?: CreateDomainServices;
    logger: StructuredLogger;
    searchWorkers?: SearchWorkers;
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
            hasMobileAttentionRecipient: options.hasMobileAttentionRecipient,
            agentEndpoints: new AgentEndpointLifecycle(
                options.agentEndpointControl,
                options.userDataPath,
            ),
            agentEnvironment: defaultAgentEnvironment(process.env),
            agentHooksPath: options.agentHooksPath,
            agentUnknownRecoveryMs: resolveE2EAgentUnknownRecoveryMs(process.env),
            logger: options.logger,
            hookExecutable: options.executable ?? process.execPath,
            searchWorkers: options.searchWorkers,
            terminalExecution: options.terminalExecution,
            userDataPath: options.userDataPath,
        },
        options.createServices,
    );
}
