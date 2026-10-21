import { useState } from 'react';

import type {
    AgentChatModelRequest,
    AgentChatPendingSelection,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { agentChatSelectionView, isAgentChatSelectionSettled } from '@caxri/protocol';

import { didConfigureAgentChat } from '../agent-chat-commands';

type ReportedSelection = Pick<
    AgentChatSnapshot,
    'effort' | 'fast' | 'model' | 'models' | 'ultracode'
>;

/**
 * The model picker's optimistic switch: `configure` shows the choice at once (`snapshot` is the reported one with the
 * pending choice applied), `pending` holds it until the reported snapshot confirms it, and a failed switch drops it.
 */
export function useAgentChatModelSelection(
    reported: ReportedSelection | undefined,
    terminalId: string,
) {
    const [pending, setPending] = useState<AgentChatPendingSelection>();
    /**
     * Settled during render rather than in an effect, so the confirmed snapshot and the cleared spinner land in one
     * commit: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
     */
    if (pending && isAgentChatSelectionSettled(pending, reported)) setPending(undefined);
    const snapshot = reported && agentChatSelectionView(reported, pending);
    const configure = (change: AgentChatModelRequest): void => {
        /**
         * An effort chosen right after a model joins that model's pending switch, so the picker keeps showing both
         * until the snapshot reports them.
         */
        const request: AgentChatPendingSelection = {
            change: { ...pending?.change, ...change },
            baseline: pending?.baseline ?? {
                model: reported?.model,
                effort: reported?.effort,
                ultracode: reported?.ultracode,
                fast: reported?.fast,
            },
            isAccepted: false,
        };
        setPending(request);
        // eslint-disable-next-line no-void -- didConfigureAgentChat reports a failed switch through the toast
        void didConfigureAgentChat(terminalId, change).then((isConfigured) =>
            setPending((current) => {
                // A later choice replaced this one; it owns the pending state now.
                if (current !== request) return current;
                return isConfigured ? { ...request, isAccepted: true } : undefined;
            }),
        );
    };
    return { configure, isPending: pending !== undefined, snapshot };
}
