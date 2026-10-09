import { CaxriError } from '@caxri/protocol';

import type { AgentDelegationService } from './agent-delegation';
import type { AgentHookManager } from './agents';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import type { TerminalManagerOptions } from './terminal';
import * as provenance from './workbench-provenance';
import type { WorkbenchRootService } from './workbench-roots';

interface LifecycleEnvironmentOptions {
    agentHooks: Pick<AgentHookManager, 'terminalEnvironment'>;
    configuration: Pick<ConfigService, 'getSettings'>;
    database: Pick<CaxriDatabase, 'agentCommanderRows' | 'getSession'>;
    /**
     * Late-bound: the delegation service is constructed after the Terminal manager that calls this.
     */
    delegationState: { service?: Pick<AgentDelegationService, 'bindEnvironment'> };
    endpoints: DomainDependencies['agentEndpoints'];
    workbenchRoots: WorkbenchRootService;
}

/**
 * Builds the generation-scoped environment for a managed PTY launch: hook credentials, Workbench provenance, and the
 * Agent Endpoint variables. A Shell, or a launch without Agent settings, receives only the hook environment.
 */
export function createLifecycleEnvironment({
    agentHooks,
    configuration,
    database,
    delegationState,
    endpoints,
    workbenchRoots,
}: LifecycleEnvironmentOptions): NonNullable<TerminalManagerOptions['lifecycleEnvironment']> {
    return async (terminal, launch, launchId, delegationId) => {
        if (!launchId)
            throw new CaxriError('CONFLICT', 'Managed Agent launch identity is unavailable');
        const hookEnvironment = agentHooks.terminalEnvironment(
            terminal.id,
            terminal.provider,
            launchId,
        );
        delegationState.service?.bindEnvironment(
            terminal.id,
            launchId,
            hookEnvironment,
            delegationId,
        );
        if (!launch || terminal.kind === 'shell') return hookEnvironment;
        const session = database.getSession(terminal.sessionId);
        if (!session) throw new CaxriError('CONFLICT', 'Agent Session no longer exists');
        const providerSettings =
            configuration.getSettings().value['agents.providers'][terminal.kind];
        /**
         * Prime topology only when paired hook events can report a worktree change.
         */
        if (providerSettings.hooks.enabled && hookEnvironment.CAXRI_HOOK_TOKEN)
            await provenance.primeAgentWorkbenchProvenance({
                launchId,
                projectId: session.projectId,
                terminal,
                workbenchRoots,
            });
        if (!endpoints) return hookEnvironment;
        const endpointEnvironment = await endpoints.environment(
            terminal,
            session.projectId,
            providerSettings,
            launchId,
            database.agentCommanderRows()?.terminalId === terminal.id ? 'commander' : undefined,
        );
        if (!endpoints.preparedEndpointForTerminal(terminal.id))
            throw new CaxriError(
                'UNAVAILABLE',
                'Agent Endpoint generation was not prepared before launch',
            );
        return {
            ...hookEnvironment,
            ...endpointEnvironment,
        };
    };
}
