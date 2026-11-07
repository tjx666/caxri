import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { AgentChatEditTarget } from '../../agent-chat/agent-chat-message-edit';
import { AgentChatView } from '../../agent-chat/agent-chat-view';
import type { SessionAgentChat } from '../../agent-chat/use-session-agent-chat';
import { AttentionCards } from '../../conversation/attention-cards';
import { ConversationFileOpener } from '../../conversation/conversation-file-opener';
import { ConversationView } from '../../conversation/conversation-view';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { useOpenSessionFile } from '../../file-viewer/use-open-session-file';
import { primaryTerminalExitPresentation } from '../../terminal/terminal-exit-presentation';
import { TerminalLiveView } from '../../terminal/terminal-live-view';
import { useSegmentEntering } from '../hooks/use-segment-entering';
import type { MobileSessionItem } from '../session-model';
import { isMobileTerminalStopped } from '../session-model';
import type { ContentSessionSegment, SessionSegment } from '../session-ui-state';
import { sessionDetailStyles as styles } from './session-detail-styles';

/**
 * Splits a content switch's motion between the body wrapper and the Conversation list. A populated Conversation stays
 * transparent until its list has scrolled to the latest message, which outlasts the wrapper's entering animation, so
 * the list plays the switch motion itself once it is positioned and the wrapper stays still to keep the two from
 * stacking. Opening or closing the side panel never switches the content, so neither moves then.
 */
const conversationAwareEntering = (
    segment: ContentSessionSegment,
    hasConversationItems: boolean,
    { direction, entering }: ReturnType<typeof useSegmentEntering>,
) => {
    if (segment !== 'conversation') return { bodyEntering: entering, conversationEnterFrom: null };
    return {
        bodyEntering: hasConversationItems ? undefined : entering,
        conversationEnterFrom: direction,
    };
};

const hasConversationItems = (
    chat: SessionAgentChat | null,
    timeline: ReturnType<typeof useConversationTimeline>,
): boolean => chat?.hasItems ?? timeline.items.length > 0;

/**
 * The Conversation tab: a Chat renders its own view, which replaces both the transcript and the Terminal.
 */
const SessionConversationPane = ({
    attention,
    chat,
    deviceRole,
    enterFrom,
    isConnected,
    onEditMessage,
    onEditQueued,
    session,
    theme,
    timeline,
}: {
    attention: ReactNode;
    chat: SessionAgentChat | null;
    deviceRole: 'view' | 'reply' | 'control' | null;
    enterFrom: -1 | 0 | 1 | null;
    isConnected: boolean;
    onEditMessage: (target: AgentChatEditTarget, text: string) => void;
    onEditQueued: (text: string) => void;
    session: Pick<MobileSessionItem, 'id' | 'projectId'>;
    theme: MobileTheme;
    timeline: ReturnType<typeof useConversationTimeline>;
}) =>
    chat ? (
        <AgentChatView
            chat={chat.controller}
            deviceRole={deviceRole}
            enterFrom={enterFrom}
            handoffSource={{
                projectId: session.projectId,
                providerId: chat.providerId,
                sessionId: session.id,
            }}
            isConnected={isConnected}
            isHandedOff={chat.isHandedOff}
            onEditMessage={onEditMessage}
            onEditQueued={onEditQueued}
            provider={chat.provider}
            theme={theme}
        />
    ) : (
        <View style={{ flex: 1 }}>
            <ConversationView
                canSend={deviceRole === 'reply' || deviceRole === 'control'}
                enterFrom={enterFrom}
                isConnected={isConnected}
                onRetry={timeline.refresh}
                theme={theme}
                timeline={timeline}
            />
            {attention}
        </View>
    );

export const SessionDetailBody = ({
    chat,
    contentSegment,
    contentSegments,
    conversationTimeline,
    deviceRole,
    dockedSidePanel,
    isConnected,
    isVisible,
    onEditMessage,
    onEditQueued,
    onSegmentChange,
    session,
    theme,
}: {
    /**
     * Present when the primary Terminal is a Chat, which replaces both the Conversation and the Terminal.
     */
    chat: SessionAgentChat | null;
    /**
     * The content segment on screen, which stays mounted while the side panel is open over or beside it.
     */
    contentSegment: ContentSessionSegment;
    /**
     * The content segments this Session offers, in order, so a switch between them slides from the matching side.
     */
    contentSegments: readonly SessionSegment[];
    conversationTimeline: ReturnType<typeof useConversationTimeline>;
    deviceRole: 'view' | 'reply' | 'control' | null;
    /**
     * A wide tablet's side panel, docked beside the content; a phone draws its side panel over the whole Session
     * instead.
     */
    dockedSidePanel: ReactNode;
    isConnected: boolean;
    isVisible: boolean;
    /**
     * Starts "Edit from Here" on an earlier Chat message: its text replaces the composer draft until sent or cancelled.
     */
    onEditMessage: (target: AgentChatEditTarget, text: string) => void;
    /**
     * Puts a queued Chat message taken back for editing into the composer draft and focuses it.
     */
    onEditQueued: (text: string) => void;
    onSegmentChange: (segment: SessionSegment) => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const segmentEntering = useSegmentEntering(contentSegment, contentSegments);
    const openFile = useOpenSessionFile(session.id);
    const { bodyEntering, conversationEnterFrom } = conversationAwareEntering(
        contentSegment,
        hasConversationItems(chat, conversationTimeline),
        segmentEntering,
    );
    // A Chat Session never resolves to the Terminal segment (`resolveSessionConversationSegment`).
    const isShowTerminal = contentSegment === 'terminal';
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
            visible={isVisible && isShowTerminal}
        />
    ) : (
        <View style={styles.placeholder} testID="terminal-unavailable">
            <Text style={[styles.placeholderBody, { color: theme.muted }]}>
                {t('sessions.detail.noTerminal')}
            </Text>
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
        <ConversationFileOpener value={openFile}>
            <SessionConversationPane
                attention={attention(
                    session.agentActivityState === 'waiting' &&
                        session.primaryTerminal?.provider !== 'claude',
                    true,
                )}
                chat={chat}
                deviceRole={deviceRole}
                enterFrom={conversationEnterFrom}
                isConnected={isConnected}
                onEditMessage={onEditMessage}
                onEditQueued={onEditQueued}
                session={session}
                theme={theme}
                timeline={conversationTimeline}
            />
        </ConversationFileOpener>
    );
    /**
     * Keyed by the content segment so each content switch mounts a fresh wrapper and replays its entering animation.
     * Opening the side panel keeps the key, so the Chat or Terminal under it keeps its place.
     */
    return (
        <View style={styles.bodyRow}>
            <Animated.View entering={bodyEntering} key={contentSegment} style={styles.body}>
                {contentSegment === 'conversation' ? conversation : terminalWithAttention}
            </Animated.View>
            {dockedSidePanel}
        </View>
    );
};
