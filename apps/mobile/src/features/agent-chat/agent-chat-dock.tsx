/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { AgentChatDockSummaryRow } from './agent-chat-dock-summary-row';
import { AgentChatGoalBar } from './agent-chat-goal-bar';
import type { agentChatRequestBlockedReason } from './agent-chat-model';
import { AgentChatQueueList } from './agent-chat-queue-list';
import { AgentChatRequests } from './agent-chat-request-dock';
import { AgentChatStatusRow } from './agent-chat-status-row';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatDock } from './use-agent-chat-dock';

/**
 * The goal bar, requests, status row, and queue card above the composer. With the keyboard up and several of them
 * showing, the goal bar, status row, and queue card fold into one summary row (`useAgentChatDock`) that unfolds on a
 * tap; requests never fold, since they block the Agent on the user. Folded rows stay mounted and only hidden, so the
 * queue's edit state and the published task links survive.
 */
export const AgentChatDock = ({
    blockedReason,
    canAct,
    chat,
    deviceRole,
    isConnected,
    isTimelineYielding,
    onEditQueued,
    provider,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    canAct: boolean;
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    isTimelineYielding: boolean;
    onEditQueued: (text: string) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const dock = useAgentChatDock(chat, provider);
    const foldable = dock.isFolded ? styles.folded : undefined;
    return (
        <>
            {dock.isSummaryShown ? (
                <AgentChatDockSummaryRow
                    isExpanded={dock.isExpanded}
                    onToggle={dock.toggle}
                    segments={dock.segments}
                    theme={theme}
                />
            ) : null}
            <View style={foldable}>
                <AgentChatGoalBar canAct={canAct} chat={chat} theme={theme} />
            </View>
            <AgentChatRequests
                blockedReason={blockedReason}
                chat={chat}
                isExpanded={isTimelineYielding}
                provider={provider}
                theme={theme}
            />
            <View style={foldable}>
                <AgentChatStatusRow
                    chat={chat}
                    deviceRole={deviceRole}
                    isConnected={isConnected}
                    provider={provider}
                    theme={theme}
                />
            </View>
            <View style={foldable}>
                <AgentChatQueueList
                    canAct={canAct}
                    chat={chat}
                    onEdit={onEditQueued}
                    theme={theme}
                />
            </View>
        </>
    );
};

const styles = StyleSheet.create({
    folded: { display: 'none' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
