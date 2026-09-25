import { KeyboardAvoidingView, Platform, Text } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { ChangesPanel } from '../../changes/changes-panel';
import { COMMIT_DRAFT } from '../../changes/changes-view';
import { useChangesList } from '../../changes/use-changes';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { SessionDetailBody } from './session-detail-body';
import { SessionDetailComposer } from './session-detail-composer';
import { SessionDetailHeader } from './session-detail-header';
import { sessionDetailStyles as styles } from './session-detail-styles';

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
    wideBackgroundSegment,
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
    wideBackgroundSegment: 'conversation' | 'terminal';
}) => {
    const changes = useChangesList(isVisible, session.id);
    const changesPanel = (
        <ChangesPanel
            key={session.id}
            canAskAgent={
                (deviceRole === 'reply' || deviceRole === 'control') &&
                Boolean(session.primaryAgentEndpoint)
            }
            list={changes}
            onAskAgentToCommit={() => onDraftChange(COMMIT_DRAFT)}
            sessionId={session.id}
            theme={theme}
        />
    );
    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="session-detail"
        >
            <SessionDetailHeader
                changesCount={changes.state.snapshot?.changedFileCount ?? null}
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
            <SessionDetailBody
                changesPanel={changesPanel}
                conversationTimeline={conversationTimeline}
                deviceRole={deviceRole}
                isConnected={isConnected}
                isVisible={isVisible}
                segment={segment}
                session={session}
                theme={theme}
                wideBackgroundSegment={wideBackgroundSegment}
                wideChanges={wideChanges}
            />
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
