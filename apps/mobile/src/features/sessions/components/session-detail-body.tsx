import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { AttentionCards } from '../../conversation/attention-cards';
import { ConversationView } from '../../conversation/conversation-view';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { TerminalLiveView } from '../../terminal/terminal-live-view';
import type { MobileSessionItem } from '../session-model';
import { isMobileTerminalStopped } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { isSideSessionSegment } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';

export const SessionDetailBody = ({
    changesPanel,
    panels,
    conversationTimeline,
    deviceRole,
    isConnected,
    isVisible,
    segment,
    session,
    theme,
    wideBackgroundSegment,
    wideChanges,
}: {
    changesPanel: ReactNode;
    panels: ReactNode;
    conversationTimeline: ReturnType<typeof useConversationTimeline>;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    isVisible: boolean;
    segment: SessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
    wideBackgroundSegment: 'conversation' | 'terminal';
    wideChanges: boolean;
}) => {
    const showTerminal =
        segment === 'terminal' ||
        (isSideSessionSegment(segment) && wideChanges && wideBackgroundSegment === 'terminal');
    const terminalId = session.primaryTerminal?.id ?? session.primaryAgentTerminalId;
    const terminal = terminalId ? (
        <TerminalLiveView
            key={terminalId}
            isConnected={isConnected}
            isStopped={isMobileTerminalStopped(session)}
            role={deviceRole}
            terminalId={terminalId}
            theme={theme}
            visible={isVisible && showTerminal}
        />
    ) : (
        <View style={styles.placeholder} testID="terminal-unavailable">
            <Text style={{ color: theme.muted }}>No active Terminal for this Session.</Text>
        </View>
    );
    const attention = (shouldFallbackToTerminal: boolean) => (
        <AttentionCards
            fallbackToTerminal={shouldFallbackToTerminal}
            role={deviceRole}
            sessionId={session.id}
            theme={theme}
        />
    );
    /**
     * A native Agent request can arrive before its first transcript makes Conversation available.
     */
    const terminalWithAttention = (
        <View style={{ flex: 1 }}>
            {terminal}
            {attention(false)}
        </View>
    );
    const conversation = (
        <View style={{ flex: 1 }}>
            <ConversationView
                onRetry={conversationTimeline.refresh}
                theme={theme}
                timeline={conversationTimeline}
            />
            {attention(
                session.lastActivityState === 'waiting' &&
                    session.primaryTerminal?.provider !== 'claude',
            )}
        </View>
    );
    const side = segment === 'panels' ? panels : changesPanel;
    if (wideChanges && isSideSessionSegment(segment)) {
        return (
            <View style={styles.bodyRow}>
                {wideBackgroundSegment === 'conversation' ? conversation : terminalWithAttention}
                <View
                    style={[styles.wideChanges, { borderColor: theme.border }]}
                    testID="changes-right-pane"
                >
                    {side}
                </View>
            </View>
        );
    }
    return (
        <View style={styles.body}>
            {segment === 'conversation'
                ? conversation
                : segment === 'terminal'
                  ? terminalWithAttention
                  : side}
        </View>
    );
};
