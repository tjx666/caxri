import type { AgentDelegationService } from './agent-delegation';
import type { createAgentRuntime } from './agent-runtime';
import type { CompactionReadiness } from './agents';
import type { CommanderTerminalHooks } from './commander';
import type { PullRequestSettlementWiring } from './pull-request';
import type { TerminalSuspensionService } from './terminal';

type AgentRuntimeOptions = Parameters<typeof createAgentRuntime>[0];

/**
 * Late-bound services that the Agent runtime must notify before they exist. The composition root fills `service` once
 * the owner is constructed, so the fan-out below tolerates a signal that arrives during startup.
 */
export interface AgentLifecycleFanOutTargets {
    commanderHooks: CommanderTerminalHooks;
    compactionReadiness: CompactionReadiness;
    delegationState: { service?: AgentDelegationService };
    /**
     * Receives Session activity first so a settled turn can refresh its pull request before Commander sees it.
     */
    settlementWiring: PullRequestSettlementWiring;
    suspensionState: { service?: TerminalSuspensionService };
}

/**
 * Fans the Agent runtime's lifecycle, activity, and interrupt signals out to compaction readiness, delegation, Terminal
 * suspension, pull request settlement, and Commander hooks. The call order within each callback is part of the
 * contract.
 */
export function createAgentLifecycleFanOut({
    commanderHooks,
    compactionReadiness,
    delegationState,
    settlementWiring,
    suspensionState,
}: AgentLifecycleFanOutTargets): Pick<
    AgentRuntimeOptions,
    'onLifecycleApplied' | 'onLifecycleSignal' | 'onSessionActivityChanged' | 'onSignalInterrupt'
> {
    return {
        onLifecycleSignal: (signal) => {
            compactionReadiness.observe(signal);
            if (!signal.agentTurnContinues) suspensionState.service?.observeLifecycle(signal);
            delegationState.service?.observe(signal, 'evidence');
        },
        onLifecycleApplied: (signal) => {
            delegationState.service?.observe(signal);
            suspensionState.service?.observeAppliedLifecycle(signal);
            commanderHooks.lifecycleApplied(signal);
        },
        onSessionActivityChanged: (transition) => settlementWiring.observeActivity(transition),
        onSignalInterrupt: (terminalId) => {
            suspensionState.service?.observeInterrupt(terminalId);
            commanderHooks.interrupted(terminalId);
        },
    };
}
