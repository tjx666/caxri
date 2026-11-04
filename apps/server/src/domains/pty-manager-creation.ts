import type { StructuredLogger } from '@caxri/system';

import type { AgentDelegationService } from './agent-delegation';
import type { createAgentRuntime } from './agent-runtime';
import type { CompactionReadiness } from './agents';
import type { BotTerminalHooks } from './bot';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import type { createRootServices } from './root-services';
import type { TerminalSuspensionService } from './terminal';
import { createLifecycleEnvironment, createShellIntegration, TerminalManager } from './terminal';
import type { SystemAppearance } from './theme';
import * as provenance from './workbench';

/**
 * Composes the PTY Terminal manager with the lifecycle hooks of the services around it. Delegation and suspension are
 * composed after the manager, so it reaches them through late-bound holders.
 */
export async function createDomainTerminalManager({
    agentRuntime,
    botHooks,
    compactionReadiness,
    configuration,
    database,
    delegationState,
    dependencies,
    logger,
    send,
    suspensionState,
    systemAppearance,
    workbenchRoots,
}: {
    agentRuntime: Pick<
        Awaited<ReturnType<typeof createAgentRuntime>>,
        | 'agentHooks'
        | 'agentLaunchSettings'
        | 'agentOutputRecoverySettings'
        | 'coordinator'
        | 'dispatchState'
        | 'hookLaunchEnvironment'
    >;
    botHooks: Pick<BotTerminalHooks, 'input' | 'launchArguments' | 'launchPrompt' | 'launched'>;
    compactionReadiness: Pick<CompactionReadiness, 'forget' | 'input'>;
    configuration: ConfigService;
    database: CaxriDatabase;
    delegationState: { service?: AgentDelegationService };
    dependencies: DomainDependencies;
    logger: StructuredLogger;
    send: DomainDependencies['send'];
    suspensionState: { service?: TerminalSuspensionService };
    systemAppearance: Pick<SystemAppearance, 'terminalColors'>;
    workbenchRoots: Awaited<ReturnType<typeof createRootServices>>['workbenchRoots'];
}): Promise<TerminalManager> {
    const {
        agentHooks,
        agentLaunchSettings,
        agentOutputRecoverySettings,
        coordinator,
        dispatchState,
        hookLaunchEnvironment,
    } = agentRuntime;
    const shellIntegration = await createShellIntegration(dependencies.userDataPath, logger);
    const terminals = new TerminalManager(database, send, logger, {
        ...dependencies.terminal,
        execution: dependencies.terminalExecution,
        agentLaunchArguments: botHooks.launchArguments,
        agentLaunchPrompt: botHooks.launchPrompt,
        agentLaunchSettings: dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        agentOutputRecoverySettings:
            dependencies.terminal?.agentOutputRecoverySettings ?? agentOutputRecoverySettings,
        shellEnvironment: (terminal) => hookLaunchEnvironment.shellEnvironment(terminal.id),
        onShellRetired: (terminalId) => agentHooks.endShellLaunch(terminalId),
        lifecycleEnvironment: createLifecycleEnvironment({
            agentHooks: hookLaunchEnvironment,
            configuration,
            database,
            delegationState,
            endpoints: dependencies.agentEndpoints,
            workbenchRoots,
        }),
        onLaunched: (terminal) => {
            botHooks.launched(terminal.id, terminals.agentLaunchId(terminal.id));
            return suspensionState.service?.parkLaunch(terminal);
        },
        onLifecycleStarted: (terminal) => {
            suspensionState.service?.observeLaunch(terminal.id);
            return dependencies.agentEndpoints?.activate(terminal.id);
        },
        onLifecycleRetired: async (terminalId, launchId) => {
            compactionReadiness.forget(terminalId);
            delegationState.service?.interruptTerminal(terminalId, false, launchId);
            suspensionState.service?.forgetTerminal(terminalId);
            agentHooks.endTerminalLaunch(terminalId, launchId);
            await provenance.retireAgentWorkbenchProvenance({
                endpoints: dependencies.agentEndpoints,
                logger,
                terminalId,
                workbenchRoots,
            });
        },
        onOutputActivity: (terminalId, processId) =>
            coordinator.observeOutput(terminalId, processId),
        onInput: (terminalId, data, origin) => {
            compactionReadiness.input(terminalId, data);
            suspensionState.service?.observeInput(terminalId, data);
            if (origin === 'human') botHooks.input(terminalId, data);
            if (origin === 'human') coordinator.maintenanceTurns.end(terminalId, 'humanInput');
            delegationState.service?.interruptTerminal(terminalId, true);
        },
        onAgentStateChanged: dispatchState.observe,
        shellIntegration: (executable, environment) =>
            shellIntegration?.resolve(executable, environment),
        terminalColors: dependencies.terminal?.terminalColors ?? systemAppearance.terminalColors,
    });
    return terminals;
}
