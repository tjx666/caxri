import { useState } from 'react';

import type {
    AgentChatPendingPermission,
    AgentChatPermissionRequest,
    AgentChatSnapshot,
    AgentProvider,
} from '@caxri/protocol';
import {
    agentChatPermissionSelectionView,
    isAgentChatPermissionNextTurnOnly,
    isAgentChatPermissionSettled,
} from '@caxri/protocol';

import { didConfigureAgentChatPermission } from '../agent-chat-permission-commands';
import type { AgentChatPermissionTurnBaseline } from '../agent-chat-permissions';
import {
    isAgentChatPermissionDeferred,
    nextAgentChatPermissionTurnBaseline,
} from '../agent-chat-permissions';

type ReportedPermission = Pick<AgentChatSnapshot, 'activeTurnId' | 'permissionMode' | 'planMode'>;

/**
 * The permission picker's optimistic switch, the same pattern as `useAgentChatModelSelection`: `configure` shows the
 * choice at once (`snapshot` is the reported one with the pending choice applied), `isPending` holds a spinner until
 * the reported snapshot confirms it, and a failed switch drops it. For a provider that applies a switch only with the
 * next turn (`appliesOnNextTurn`), `isDeferred` says the shown choice is not yet what the running turn uses.
 */
export function useAgentChatPermissionSelection(
    reported: ReportedPermission | undefined,
    provider: AgentProvider | undefined,
    terminalId: string,
) {
    const [pending, setPending] = useState<AgentChatPendingPermission>();
    const [turnBaseline, setTurnBaseline] = useState<AgentChatPermissionTurnBaseline>();
    const activeTurnId = reported?.activeTurnId;
    /**
     * Settled during render rather than in an effect, so the confirmed snapshot and the cleared spinner land in one
     * commit: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
     */
    if (pending && isAgentChatPermissionSettled(pending, reported)) setPending(undefined);
    // The turn the baseline described ended, and the next turn picked the choice up.
    if (turnBaseline && turnBaseline.turnId !== activeTurnId) setTurnBaseline(undefined);
    const snapshot = reported && agentChatPermissionSelectionView(reported, pending);
    const configure = (change: AgentChatPermissionRequest): void => {
        if (!reported) return;
        setTurnBaseline((current) =>
            nextAgentChatPermissionTurnBaseline(current, {
                activeTurnId,
                appliesOnNextTurn:
                    provider !== undefined && isAgentChatPermissionNextTurnOnly(provider),
                reported,
            }),
        );
        const request: AgentChatPendingPermission = {
            change: { ...pending?.change, ...change },
            baseline: pending?.baseline ?? {
                permissionMode: reported.permissionMode,
                planMode: reported.planMode,
            },
            isAccepted: false,
        };
        setPending(request);
        // eslint-disable-next-line no-void -- didConfigureAgentChatPermission reports a failed switch through the toast
        void didConfigureAgentChatPermission(terminalId, change).then((isConfigured) =>
            setPending((current) => {
                // A later choice replaced this one; it owns the pending state now.
                if (current !== request) return current;
                return isConfigured ? { ...request, isAccepted: true } : undefined;
            }),
        );
    };
    return {
        configure,
        isDeferred:
            snapshot !== undefined &&
            isAgentChatPermissionDeferred(turnBaseline, snapshot, activeTurnId),
        /**
         * The running turn keeps its choice: the provider applies a switch only from the next turn.
         */
        isNextTurnOnly:
            activeTurnId !== undefined &&
            provider !== undefined &&
            isAgentChatPermissionNextTurnOnly(provider),
        isPending: pending !== undefined,
        snapshot,
    };
}
