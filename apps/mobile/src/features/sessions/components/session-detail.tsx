import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { ConversationView } from '../../conversation/conversation-view';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { TerminalLiveView } from '../../terminal/terminal-live-view';
import type { MobileSessionItem } from '../session-model';
import { isMobileTerminalStopped } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { SessionDetailComposer } from './session-detail-composer';
import { SessionDetailHeader } from './session-detail-header';
import { sessionDetailStyles as styles } from './session-detail-styles';

const segmentLabels: Record<SessionSegment, string> = {
    conversation: 'Conversation',
    terminal: 'Terminal',
    changes: 'Changes',
};

const SessionSegmentPlaceholder = ({ kind, theme }: { kind: 'changes'; theme: MobileTheme }) => (
    <View style={styles.placeholder} testID={`${kind}-placeholder`}>
        <Text accessibilityRole="header" style={[styles.placeholderTitle, { color: theme.text }]}>
            {segmentLabels[kind]}
        </Text>
        <Text style={[styles.placeholderBody, { color: theme.muted }]}>
            Changes review is coming soon. Review files on your computer for now.
        </Text>
    </View>
);

export const SessionDetail = ({
    deviceRole,
    draft,
    conversationFallback,
    conversationTimeline,
    focusComposer,
    hostId,
    isConnected,
    isVisible,
    onBack,
    onComposerFocused,
    onDraftChange,
    onMarkRead,
    onRefresh,
    onSegmentChange,
    segment,
    session,
    theme,
    wideChanges,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    conversationFallback: boolean;
    conversationTimeline: ReturnType<typeof useConversationTimeline>;
    focusComposer?: boolean;
    hostId: string;
    isConnected: boolean;
    isVisible: boolean;
    onBack?: () => void;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    onMarkRead: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    segment: SessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
    wideChanges: boolean;
}) => {
    const showTerminal = segment === 'terminal' || (segment === 'changes' && wideChanges);
    const terminal = session.primaryAgentTerminalId ? (
        <TerminalLiveView
            key={session.primaryAgentTerminalId}
            isConnected={isConnected}
            isStopped={isMobileTerminalStopped(session)}
            role={deviceRole}
            terminalId={session.primaryAgentTerminalId}
            theme={theme}
            visible={isVisible && showTerminal}
        />
    ) : (
        <View style={styles.placeholder} testID="terminal-unavailable">
            <Text style={{ color: theme.muted }}>No active Terminal for this Session.</Text>
        </View>
    );
    const body =
        segment === 'terminal' ? (
            terminal
        ) : segment === 'conversation' ? (
            <ConversationView
                onRetry={conversationTimeline.refresh}
                theme={theme}
                timeline={conversationTimeline}
            />
        ) : (
            <SessionSegmentPlaceholder kind="changes" theme={theme} />
        );
    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="session-detail"
        >
            <SessionDetailHeader
                isConnected={isConnected}
                onBack={onBack}
                onMarkRead={onMarkRead}
                onSegmentChange={onSegmentChange}
                segment={segment}
                session={session}
                theme={theme}
            />
            {conversationFallback ? (
                <Text
                    accessibilityRole="alert"
                    style={[
                        styles.fallbackBanner,
                        { color: theme.muted, borderColor: theme.border },
                    ]}
                    testID="conversation-fallback-banner"
                >
                    Conversation view isn't available for this Agent. Showing the Terminal.
                </Text>
            ) : null}
            {segment === 'changes' && wideChanges ? (
                <View style={styles.bodyRow}>
                    {terminal}
                    <View style={[styles.wideChanges, { borderColor: theme.border }]}>
                        <SessionSegmentPlaceholder kind="changes" theme={theme} />
                    </View>
                </View>
            ) : (
                <View style={styles.body}>{body}</View>
            )}
            <SessionDetailComposer
                deviceRole={deviceRole}
                draft={draft}
                focusComposer={focusComposer}
                hostId={hostId}
                isConnected={isConnected}
                isVisible={isVisible}
                onComposerFocused={onComposerFocused}
                onDraftChange={onDraftChange}
                onRefresh={onRefresh}
                session={session}
                theme={theme}
            />
        </KeyboardAvoidingView>
    );
};
