/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { agentChatImplementablePlanId, agentChatProposedPlanRequest } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { agentChatRequestBlockedReason } from './agent-chat-model';
import { dismissAgentChatPlan, dismissedAgentChatPlanId } from './agent-chat-plan-dismissals';
import { AgentChatRequestCard } from './agent-chat-request-card';
import { agentChatRequestDock } from './agent-chat-request-flow';
import type { AgentChatController } from './use-agent-chat';

/**
 * The approval card for the Chat's latest proposed plan (Codex's plan-mode reply): the same `Start with this plan?`
 * card Claude Code's `ExitPlanMode` request shows, and Desktop's. Start Building leaves plan mode and starts the build
 * in one Server step; Keep Planning only hides the card, since plan mode stays on.
 */
const AgentChatPlanApproval = ({
    blockedReason,
    chat,
    isExpanded,
    provider,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    chat: AgentChatController;
    isExpanded: boolean;
    provider: string;
    theme: MobileTheme;
}) => {
    const { pendingKey, snapshot } = chat;
    const [, setVersion] = useState(0);
    const itemId = snapshot && agentChatImplementablePlanId(snapshot);
    // A real request takes the dock first; the plan's card comes back when it is answered.
    if (!itemId || !pendingKey || snapshot.requests.length > 0) return null;
    if (dismissedAgentChatPlanId(pendingKey) === itemId) return null;
    const hide = () => {
        dismissAgentChatPlan(pendingKey, itemId);
        setVersion((version) => version + 1);
    };
    return (
        <View
            key={itemId}
            style={[styles.dock, isExpanded && styles.dockExpanded]}
            testID="agent-chat-plan-approval"
        >
            <AgentChatRequestCard
                blockedReason={blockedReason}
                items={[]}
                onRespond={async (_target, response) => {
                    if (response.kind !== 'decision') return;
                    if (response.decision === 'accept') {
                        await chat.implementPlan(itemId);
                        // The snapshot catches up a moment later; keep the card from coming back meanwhile.
                    }
                    hide();
                }}
                provider={provider}
                request={agentChatProposedPlanRequest(itemId)}
                theme={theme}
            />
        </View>
    );
};

/**
 * The pending requests docked above the composer, one card at a time (`agentChatRequestDock`), so a phone never scrolls
 * several whole cards as one block and loses a question's title. The dock is capped at 80% of the Chat, like the Chat's
 * sheets, so the timeline keeps the sent message in view; inside it the card's options or approval text scroll while
 * its title and buttons stay put. A 60% cap left a two-option question on a phone with one and a sliver of rows.
 *
 * Every request's card stays mounted, the ones not shown hidden: an answered card waits hidden while its answer is on
 * its way, so a refused answer brings it back with its choices and the card's own error instead of a blank card.
 */
export const AgentChatRequests = ({
    blockedReason,
    chat,
    isExpanded,
    provider,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    chat: AgentChatController;
    /**
     * The keyboard is up beside this dock, so the card may take the timeline's whole share of the screen.
     */
    isExpanded: boolean;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { pending, respond, snapshot } = chat;
    const { answeredRequestIds } = pending;
    const requests = snapshot?.requests ?? [];
    if (requests.length === 0)
        return (
            <AgentChatPlanApproval
                blockedReason={blockedReason}
                chat={chat}
                isExpanded={isExpanded}
                provider={provider}
                theme={theme}
            />
        );
    const dock = agentChatRequestDock(requests, answeredRequestIds, t);
    return (
        <View
            style={[
                styles.dock,
                isExpanded && styles.dockExpanded,
                dock.currentId === undefined && styles.hidden,
            ]}
            testID="agent-chat-requests"
        >
            {requests.map((request) => (
                <View
                    key={request.id}
                    style={request.id === dock.currentId ? styles.dockCard : styles.hidden}
                >
                    <AgentChatRequestCard
                        blockedReason={blockedReason}
                        items={snapshot?.items ?? []}
                        onRespond={respond}
                        positionLabel={dock.positionLabel}
                        provider={provider}
                        request={request}
                        theme={theme}
                    />
                </View>
            ))}
        </View>
    );
};

const styles = StyleSheet.create({
    /**
     * The card carries its own border and the 16dp dock gutter, so the dock adds no rule of its own.
     */
    dock: {
        flexShrink: 1,
        maxHeight: '80%',
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.sm,
    },
    dockExpanded: { maxHeight: '100%' },
    dockCard: { flexShrink: 1 },
    hidden: { display: 'none' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
