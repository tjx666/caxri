import type { AgentDelegationService } from './agent-delegation';
import type { createAgentRuntime } from './agent-runtime';
import type { CompactionReadiness } from './agents';
import type { BotTerminalHooks } from './bot';
import type { PullRequestSettlementWiring } from './pull-request';
import type { TerminalSuspensionService } from './terminal';

type AgentRuntimeOptions = Parameters<typeof createAgentRuntime>[0];

/**
 * Late-bound services that the Agent runtime must notify before they exist. The composition root fills `service` once
 * the owner is constructed, so the fan-out below tolerates a signal that arrives during startup.
 */
export interface AgentLifecycleFanOutTargets {
    botHooks: BotTerminalHooks;
    compactionReadiness: CompactionReadiness;
    delegationState: { service?: AgentDelegationService };
    /**
     * Receives Session activity first so a settled turn can refresh its pull request before Caxri Bot sees it.
     */
    settlementWiring: PullRequestSettlementWiring;
    suspensionState: { service?: TerminalSuspensionService };
}

/**
 * Fans the Agent runtime's lifecycle, activity, and interrupt signals out to compaction readiness, delegation, Terminal
 * suspension, pull request settlement, and Caxri Bot's hooks. The call order within each callback is part of the
 * contract.
 */
export function createAgentLifecycleFanOut({
    botHooks,
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
            botHooks.lifecycleApplied(signal);
        },
        onSessionActivityChanged: (transition) => settlementWiring.observeActivity(transition),
        onSignalInterrupt: (terminalId) => {
            suspensionState.service?.observeInterrupt(terminalId);
            botHooks.interrupted(terminalId);
        },
    };
}
