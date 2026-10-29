import type { AgentCoordinator, AgentLifecycleSignal, AgentSignalDecision } from '../agents';
import type { WorkbenchRootService } from './roots';

export function handleAgentLifecycleSignal(
    coordinator: AgentCoordinator,
    workbenchRoots: WorkbenchRootService,
    signal: AgentLifecycleSignal,
    options: { settleAgentCwd?: boolean } = {},
): AgentSignalDecision | Promise<AgentSignalDecision> {
    /**
     * Runs on every phase, ahead of phase routing: the provider reports its own working directory on all of them, so an
     * Agent that moved itself is observable without depending on which tool did it. The check short-circuits on an
     * unchanged directory and never blocks the phase's own handling.
     */
    const settling = workbenchRoots.observeAgentCwd(signal);
    /**
     * A Chat's `EnterWorktree` hook asks to hold its tool result until the reconciliation is durable, so the next read
     * of the Session's root or transcript location sees the new value. Terminal hooks carry `agentCwd` on every phase
     * and stay fire-and-forget.
     */
    if (settling && options.settleAgentCwd)
        return settleThenRoute(coordinator, workbenchRoots, signal, settling);
    return routeLifecycleSignal(coordinator, workbenchRoots, signal);
}

async function settleThenRoute(
    coordinator: AgentCoordinator,
    workbenchRoots: WorkbenchRootService,
    signal: AgentLifecycleSignal,
    settling: Promise<void>,
): Promise<AgentSignalDecision> {
    await settling;
    return routeLifecycleSignal(coordinator, workbenchRoots, signal);
}

function routeLifecycleSignal(
    coordinator: AgentCoordinator,
    workbenchRoots: WorkbenchRootService,
    signal: AgentLifecycleSignal,
): AgentSignalDecision | Promise<AgentSignalDecision> {
    if (signal.phase === 'shellToolStarted')
        return workbenchRoots.observeShellToolStarted(signal, () =>
            coordinator.isCurrentTerminalLaunch(signal.terminalId, signal.launchId),
        );
    if (signal.phase === 'shellToolFinished')
        return workbenchRoots.observeShellToolFinished(signal);
    if (signal.phase === 'shellToolFailed') return workbenchRoots.observeShellToolFailed(signal);
    return coordinator.observeLifecycleSignal(signal);
}
