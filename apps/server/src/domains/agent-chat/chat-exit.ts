import type { AgentProvider } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { ChatEndpointLease } from './chat-endpoint-lease';
import { forwardChatLifecycle, logChatProcessExited } from './chat-launch';
import type { AgentChatExit } from './chat-provider';
import type { ChatState, ChatStates } from './chat-states';
import { ChatTaskList } from './chat-tasks';
import type { AgentChatServiceOptions } from './service-options';

/**
 * What ending a Chat's provider process needs from the service that owns it.
 */
export interface ChatExitHost {
    options: AgentChatServiceOptions;
    states: ChatStates;
    endpoint: ChatEndpointLease;
    /**
     * `true` while the service shuts down or a start for this Terminal is in flight; that start reports its own closed
     * failure reason, so the exit is not recorded twice.
     */
    isSettling: (terminalId: string) => boolean;
}

/**
 * Records a provider process exit: ends its running turn for Session Activity, retires its endpoint, stops its
 * background tasks, and marks the Terminal stopped (a requested stop) or failed (an unrequested one). An exit from a
 * superseded launch is ignored.
 */
export function handleChatExit(
    { options, states, endpoint, isSettling }: ChatExitHost,
    terminalId: string,
    provider: AgentProvider,
    state: ChatState,
    launchId: string,
    exit: AgentChatExit,
): void {
    const { database } = options;
    logChatProcessExited(options, terminalId, exit);
    if (state.launchId !== launchId || isSettling(terminalId)) return;
    /**
     * The projection already marked the running turn interrupted; end it for Session Activity too. A requested stop
     * (Restart, close) ends the turn the way an interrupt does; an unrequested one is a provider failure.
     */
    if (exit.activeTurnId)
        forwardChatLifecycle(options, {
            ...(exit.requested
                ? { phase: 'turnFinished', agentTurnId: exit.activeTurnId }
                : {
                      phase: 'turnFailed',
                      agentTurnId: exit.activeTurnId,
                      agentFailure: 'provider_failed',
                  }),
            launchId,
            provider,
            terminalId,
        });
    state.session = undefined;
    state.launchId = undefined;
    endpoint.retire(terminalId);
    // Background work lives inside the provider process and ended with it.
    new ChatTaskList({
        read: () => state.projection.snapshot,
        apply: (operations) => states.apply(terminalId, operations),
    }).stopAll();
    options.coordinator.endTerminalLaunch(terminalId);
    if (!database.getTerminal(terminalId)) return;
    if (exit.requested) states.recordRequestedStop(terminalId, state);
    else {
        // No detail: the closed reason's own copy already says everything Caxri knows about the exit.
        states.setStatus(terminalId, 'failed', { reason: 'process_exited' });
        database.updateTerminalExitState(terminalId, 'dead');
        database.updateAgentProcessExitState(terminalId, 'dead');
        options.onAgentStateChanged?.(terminalId, 'dead');
    }
    states.publish(terminalId);
}

/**
 * Ends a start whose Chat began a teardown before its provider spawned. Nothing ran, so this is not a failure: the
 * Terminal records the stop a running provider's requested exit would have.
 */
export function abandonChatStart(
    { options, states, endpoint }: ChatExitHost,
    isShuttingDown: boolean,
    start: { terminalId: string; state: ChatState; launchId: string; startedAt: number },
): void {
    const { coordinator, database, logger } = options;
    const { terminalId, state, launchId, startedAt } = start;
    if (state.launchId === launchId) state.launchId = undefined;
    endpoint.retire(terminalId);
    coordinator.endTerminalLaunch(terminalId);
    logger.write('info', logEventCatalog.agentChat.processStarted, {
        fields: {
            terminalId,
            outcome: 'abandoned',
            reason: state.retiring ?? 'closed',
            durationMs: Date.now() - startedAt,
        },
    });
    // Shutdown stamps durable state through the shared shutdown path.
    if (isShuttingDown || !database.getTerminal(terminalId)) return;
    states.recordRequestedStop(terminalId, state);
    states.publish(terminalId);
}
