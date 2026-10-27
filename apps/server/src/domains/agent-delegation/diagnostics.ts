import type { AgentDelegationCreate, AgentDelegationReceipt } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Records one receipt transition. `isRecovery` marks a transition Server startup applied to a task the previous Server
 * left active, which is never announced to Caxri Bot.
 */
export function logDelegationTransition(
    logger: StructuredLogger | undefined,
    receipt: AgentDelegationReceipt,
    previous: AgentDelegationReceipt | undefined,
    isRecovery: boolean,
): void {
    logger?.write('info', logEventCatalog.agentDelegation.transitioned, {
        fields: {
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            terminalId: receipt.terminalId ?? null,
            provider: receipt.provider,
            previousStatus: previous?.status ?? null,
            status: receipt.status,
            failure: receipt.failure ?? null,
            isRecovery,
            ageMs: receipt.updatedAt - receipt.createdAt,
        },
    });
}

/**
 * Records an admitted task and how it continues its chain, before its Agent launches.
 */
export function logDelegationRequested(
    logger: StructuredLogger | undefined,
    receipt: AgentDelegationReceipt,
    input: AgentDelegationCreate,
    caller: {
        isBot: boolean;
        parentDelegationId: string | undefined;
        terminalId: string | undefined;
    },
): void {
    logger?.write('info', logEventCatalog.agentDelegation.requested, {
        fields: {
            delegationId: receipt.delegationId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            provider: receipt.provider,
            mode: input.continueFromHandover
                ? 'handover'
                : input.resumeFrom
                  ? 'resume'
                  : input.followUpOf
                    ? 'follow_up'
                    : 'new',
            parentDelegationId: caller.parentDelegationId ?? null,
            isBotCaller: caller.isBot,
            callerTerminalId: caller.terminalId ?? null,
        },
    });
}
