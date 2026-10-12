import { useState } from 'react';

import type { AgentChatModelRequest, AgentChatPendingSelection } from '@caxri/protocol';
import { agentChatSelectionView, isAgentChatSelectionSettled } from '@caxri/protocol';

import type { AgentChatConfigureError } from './agent-chat-model-choice';
import {
    agentChatConfigureFailureMessage,
    agentChatConfigureScope,
    currentAgentChatConfigureError,
} from './agent-chat-model-choice';
import type { AgentChatController } from './use-agent-chat';

/**
 * The model sheet's optimistic switch, the Desktop picker's `useAgentChatModelSelection` on the phone: `configure`
 * shows the choice at once (`snapshot` is the reported one with the pending choice applied, so a new model's efforts
 * list right away), `busy` marks the row whose request is still on its way, and a failed switch drops the choice and
 * leaves an `error` that clears once the Chat's choice or connection changes (`agentChatConfigureScope`).
 */
export const useAgentChatModelSelection = (
    chat: Pick<AgentChatController, 'configure' | 'snapshot' | 'status'>,
    disabledReason: string | undefined,
) => {
    const reported = chat.snapshot;
    const [pending, setPending] = useState<AgentChatPendingSelection>();
    const [busy, setBusy] = useState<AgentChatModelRequest | null>(null);
    const [storedError, setError] = useState<AgentChatConfigureError | null>(null);
    /**
     * Settled during render rather than in an effect, so the confirmed snapshot and the cleared pending choice land in
     * one commit: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
     */
    if (pending && isAgentChatSelectionSettled(pending, reported)) setPending(undefined);
    const scope = agentChatConfigureScope(reported, {
        disabledReason,
        isLive: chat.status === 'ready',
    });
    const error = currentAgentChatConfigureError(storedError, scope);
    if (error !== storedError) setError(error);
    const snapshot = reported && agentChatSelectionView(reported, pending);
    const configure = async (change: AgentChatModelRequest): Promise<void> => {
        /**
         * An effort chosen right after a model joins that model's pending switch, so the sheet keeps showing both until
         * the snapshot reports them.
         */
        const request: AgentChatPendingSelection = {
            change: { ...pending?.change, ...change },
            baseline: pending?.baseline ?? {
                model: reported?.model,
                effort: reported?.effort,
                ultracode: reported?.ultracode,
            },
            isAccepted: false,
        };
        setPending(request);
        setBusy(change);
        setError(null);
        let isConfigured = false;
        try {
            await chat.configure(change);
            isConfigured = true;
        } catch {
            /**
             * Recorded against the scope the request was sent under: if the Chat's choice or connection changed while
             * it was on its way, the failure is already stale and the sheet shows the current state instead.
             */
            setError({ message: agentChatConfigureFailureMessage(change), scope });
        } finally {
            setBusy((current) => (current === change ? null : current));
        }
        setPending((current) => {
            // A later choice replaced this one; it owns the pending state now.
            if (current !== request) return current;
            return isConfigured ? { ...request, isAccepted: true } : undefined;
        });
    };
    return { busy, configure, error: error?.message ?? null, snapshot };
};
