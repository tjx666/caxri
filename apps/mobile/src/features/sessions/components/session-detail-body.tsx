import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import type { MobileTheme } from '../../../theme/tokens';
import { AttentionCards } from '../../conversation/attention-cards';
import { ConversationView } from '../../conversation/conversation-view';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { primaryTerminalExitPresentation } from '../../terminal/terminal-exit-presentation';
import { TerminalLiveView } from '../../terminal/terminal-live-view';
import { useSegmentEntering } from '../hooks/use-segment-entering';
import type { MobileSessionItem } from '../session-model';
import { isMobileTerminalStopped } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { isPanelSessionSegment, isSideSessionSegment } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';

/**
 * Splits a tab switch's motion between the body wrapper and the Conversation list. A populated Conversation stays
 * transparent until its list has scrolled to the latest message, which outlasts the wrapper's entering animation, so
 * the list plays the switch motion itself once it is positioned and the wrapper stays still to keep the two from
 * stacking. Only the selected Conversation slides; the wide layout's background Conversation never follows a side panel
 * switch.
 */
const conversationAwareEntering = (
    segment: SessionSegment,
    hasConversationItems: boolean,
    { direction, entering }: ReturnType<typeof useSegmentEntering>,
) => {
    if (segment !== 'conversation') return { bodyEntering: entering, conversationEnterFrom: null };
    return {
        bodyEntering: hasConversationItems ? undefined : entering,
        conversationEnterFrom: direction,
    };
};

export const SessionDetailBody = ({
    changesPanel,
    panelView,
    conversationTimeline,
    deviceRole,
    isConnected,
    isVisible,
    onSegmentChange,
    segment,
    segments,
    session,
    theme,
    wideBackgroundSegment,
    wideChanges,
}: {
    changesPanel: ReactNode;
    /**
     * The selected Project view, when a panel tab is open.
     */
    panelView: ReactNode;
    conversationTimeline: ReturnType<typeof useConversationTimeline>;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    isVisible: boolean;
    onSegmentChange: (segment: SessionSegment) => void;
    segment: SessionSegment;
    segments: readonly SessionSegment[];
    session: MobileSessionItem;
    theme: MobileTheme;
    wideBackgroundSegment: 'conversation' | 'terminal';
    wideChanges: boolean;
}) => {
    const segmentEntering = useSegmentEntering(segment, segments);
    const { bodyEntering, conversationEnterFrom } = conversationAwareEntering(
        segment,
        conversationTimeline.items.length > 0,
        segmentEntering,
    );
    const showTerminal =
        segment === 'terminal' ||
        (isSideSessionSegment(segment) && wideChanges && wideBackgroundSegment === 'terminal');
    const terminalId = session.primaryTerminal?.id ?? session.primaryAgentTerminalId;
    const terminal = terminalId ? (
        <TerminalLiveView
            key={terminalId}
            exitPresentation={primaryTerminalExitPresentation(session.primaryTerminal)}
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
    const attention = (shouldFallbackToTerminal: boolean, canOpenTerminal: boolean) => (
        <AttentionCards
            fallbackToTerminal={shouldFallbackToTerminal}
            onOpenTerminal={canOpenTerminal ? () => onSegmentChange('terminal') : undefined}
            role={deviceRole}
            sessionId={session.id}
            theme={theme}
        />
    );
    /**
     * A native Agent request can arrive before its first transcript makes Conversation available. "Open Terminal" is
     * pointless here: this pane already is the Terminal.
     */
    const terminalWithAttention = (
        <View style={{ flex: 1 }}>
            {terminal}
            {attention(false, false)}
        </View>
    );
    const conversation = (
        <View style={{ flex: 1 }}>
            <ConversationView
                enterFrom={conversationEnterFrom}
                onRetry={conversationTimeline.refresh}
                theme={theme}
                timeline={conversationTimeline}
            />
            {attention(
                session.lastActivityState === 'waiting' &&
                    session.primaryTerminal?.provider !== 'claude',
                true,
            )}
        </View>
    );
    const side = isPanelSessionSegment(segment) ? panelView : changesPanel;
    if (wideChanges && isSideSessionSegment(segment)) {
        return (
            <View style={styles.bodyRow}>
                {wideBackgroundSegment === 'conversation' ? conversation : terminalWithAttention}
                <View
                    style={[styles.wideChanges, { borderColor: theme.border }]}
                    testID="changes-right-pane"
                >
                    <Animated.View
                        entering={segmentEntering.entering}
                        key={segment}
                        style={styles.body}
                    >
                        {side}
                    </Animated.View>
                </View>
            </View>
        );
    }
    /**
     * Keyed by segment so each tab switch mounts a fresh wrapper and replays its entering animation. The panels already
     * remounted on every switch because each segment renders a different tree.
     */
    return (
        <Animated.View entering={bodyEntering} key={segment} style={styles.body}>
            {segment === 'conversation'
                ? conversation
                : segment === 'terminal'
                  ? terminalWithAttention
                  : side}
        </Animated.View>
    );
};
