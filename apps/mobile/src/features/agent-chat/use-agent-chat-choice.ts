import { useState } from 'react';

import type {
    AgentChatModelRequest,
    AgentChatPermissionRequest,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    agentChatPermissionSelectionView,
    agentChatSelectionView,
    isAgentChatPermissionSettled,
    isAgentChatSelectionSettled,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { AgentChatConfigureError } from './agent-chat-model-choice';
import {
    agentChatConfigureFailureMessage,
    agentChatConfigureScope,
    currentAgentChatConfigureError,
} from './agent-chat-model-choice';
import { agentChatPermissionFailureMessage } from './agent-chat-permission-choice';
import type { AgentChatController } from './use-agent-chat';

/**
 * A switch the sheet already shows, the shape of the protocol's `AgentChatPendingSelection` and
 * `AgentChatPendingPermission`.
 */
interface PendingChoice<Change, Baseline> {
    change: Change;
    baseline: Baseline;
    isAccepted: boolean;
}

/**
 * The optimistic switch behind the composer's model and permission sheets, the phone's form of the Desktop pickers'
 * `useAgentChatModelSelection` and `useAgentChatPermissionSelection`. `didConfigure` shows the choice at once
 * (`snapshot` is the reported one with the pending choice applied by `view`, so a new model's efforts list right away),
 * `busy` marks the row whose request is still on its way, and a failed switch drops the choice and leaves an `error`
 * that clears once the Chat's choice or connection changes (`agentChatConfigureScope`).
 */
const useAgentChatChoice = <
    Change extends AgentChatModelRequest | AgentChatPermissionRequest,
    Baseline,
>({
    baselineOf,
    chat,
    disabledReason,
    failureMessage,
    isSettled,
    view,
}: {
    /**
     * What the snapshot reported when a switch was requested, so an accepted switch settles on any change from it.
     */
    baselineOf: (reported: AgentChatSnapshot | undefined) => Baseline;
    chat: Pick<AgentChatController, 'configure' | 'snapshot' | 'status'>;
    disabledReason: string | undefined;
    failureMessage: (change: Change, t: Translate) => string;
    isSettled: (
        pending: PendingChoice<Change, Baseline>,
        reported: AgentChatSnapshot | undefined,
    ) => boolean;
    view: (
        reported: AgentChatSnapshot,
        pending: PendingChoice<Change, Baseline> | undefined,
    ) => AgentChatSnapshot;
}) => {
    const { t } = useTranslation();
    const reported = chat.snapshot;
    const [pending, setPending] = useState<PendingChoice<Change, Baseline>>();
    const [busy, setBusy] = useState<Change | null>(null);
    const [storedError, setError] = useState<AgentChatConfigureError | null>(null);
    /**
     * Settled during render rather than in an effect, so the confirmed snapshot and the cleared pending choice land in
     * one commit: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
     */
    if (pending && isSettled(pending, reported)) setPending(undefined);
    const scope = agentChatConfigureScope(reported, {
        disabledReason,
        isLive: chat.status === 'ready',
    });
    const error = currentAgentChatConfigureError(storedError, scope);
    if (error !== storedError) setError(error);
    const snapshot = reported && view(reported, pending);
    /**
     * Resolves `true` once the Server accepted the switch, and `false` after a failure the sheet already shows.
     */
    const didConfigure = async (change: Change): Promise<boolean> => {
        /**
         * A switch made right after another joins it (an effort chosen right after a model), so the sheet keeps showing
         * both until the snapshot reports them.
         */
        const request: PendingChoice<Change, Baseline> = {
            change: { ...pending?.change, ...change },
            baseline: pending?.baseline ?? baselineOf(reported),
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
            setError({ message: failureMessage(change, t), scope });
        } finally {
            setBusy((current) => (current === change ? null : current));
        }
        setPending((current) => {
            // A later choice replaced this one; it owns the pending state now.
            if (current !== request) return current;
            return isConfigured ? { ...request, isAccepted: true } : undefined;
        });
        return isConfigured;
    };
    return { busy, didConfigure, error: error?.message ?? null, snapshot };
};

type ChoiceChat = Pick<AgentChatController, 'configure' | 'snapshot' | 'status'>;

/**
 * The model sheet's model, effort, and ultracode choice.
 */
export const useAgentChatModelSelection = (chat: ChoiceChat, disabledReason: string | undefined) =>
    useAgentChatChoice({
        baselineOf: (reported) => ({
            model: reported?.model,
            effort: reported?.effort,
            ultracode: reported?.ultracode,
            fast: reported?.fast,
        }),
        chat,
        disabledReason,
        failureMessage: agentChatConfigureFailureMessage,
        isSettled: isAgentChatSelectionSettled,
        view: agentChatSelectionView,
    });

/**
 * The permission sheet's level and plan mode choice.
 */
export const useAgentChatPermissionSelection = (
    chat: ChoiceChat,
    disabledReason: string | undefined,
) =>
    useAgentChatChoice({
        baselineOf: (reported) => ({
            permissionMode: reported?.permissionMode,
            planMode: reported?.planMode,
        }),
        chat,
        disabledReason,
        failureMessage: agentChatPermissionFailureMessage,
        isSettled: isAgentChatPermissionSettled,
        view: agentChatPermissionSelectionView,
    });
