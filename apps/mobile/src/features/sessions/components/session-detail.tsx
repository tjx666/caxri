import { useMemo } from 'react';
import { KeyboardAvoidingView, Platform, Text } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { AgentChatComposer } from '../../agent-chat/agent-chat-composer';
import { useSessionAgentChat } from '../../agent-chat/use-session-agent-chat';
import { ChangesPanel } from '../../changes/changes-panel';
import { COMMIT_DRAFT } from '../../changes/changes-view';
import { useChangesList } from '../../changes/use-changes';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { ProjectPanelView } from '../../panels/panels-view';
import { useSessionPanels } from '../../panels/use-panels';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import {
    isChatSegmentShown,
    isPanelSessionSegment,
    panelIdOfSegment,
    panelSessionSegment,
    sessionSegments,
} from '../session-ui-state';
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
    hasConversation,
    hostId,
    isConnected,
    isVisible,
    onBack,
    onComposerFocused,
    onDraftChange,
    onMarkRead,
    onRefresh,
    onSegmentChange,
    savedAt,
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
    hasConversation: boolean;
    hostId: string;
    isConnected: boolean;
    isVisible: boolean;
    onBack?: () => void;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    onMarkRead: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    /**
     * When `session` comes from the Session list saved on this phone rather than a live read.
     */
    savedAt: number | null;
    segment: SessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
    wideChanges: boolean;
    wideBackgroundSegment: 'conversation' | 'terminal';
}) => {
    const changes = useChangesList(isVisible, session.id);
    const panels = useSessionPanels(session.id);
    /**
     * A Chat stays observed while its tab shows it, or while the wide layout keeps it beside Changes or a Project view.
     */
    const chat = useSessionAgentChat({
        isObserved: isVisible && isChatSegmentShown(segment, wideChanges),
        terminal: session.primaryTerminal,
    });
    const isChat = chat !== null;
    const segments = useMemo<SessionSegment[]>(
        () => [
            ...sessionSegments({ hasConversation, isChat }),
            ...(panels.panels ?? []).map((panel) => panelSessionSegment(panel.id)),
        ],
        [hasConversation, isChat, panels.panels],
    );
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
                panels={panels.panels}
                savedAt={savedAt}
                segment={segment}
                segments={segments}
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
                panelView={
                    isPanelSessionSegment(segment) ? (
                        <ProjectPanelView
                            deviceRole={deviceRole}
                            panelId={panelIdOfSegment(segment)}
                            panels={panels}
                            sessionId={session.id}
                            theme={theme}
                        />
                    ) : null
                }
                chat={chat}
                conversationTimeline={conversationTimeline}
                deviceRole={deviceRole}
                isConnected={isConnected}
                isVisible={isVisible}
                onSegmentChange={onSegmentChange}
                segment={segment}
                segments={segments}
                session={session}
                theme={theme}
                wideBackgroundSegment={wideBackgroundSegment}
                wideChanges={wideChanges}
            />
            {/*
             * Panels only browse, and a control device types into the Terminal directly once it takes over. A reply
             * device keeps the composer on the Terminal because it is that device's only way to answer the Agent.
             */}
            {isPanelSessionSegment(segment) ||
            (segment === 'terminal' && deviceRole === 'control') ? null : chat ? (
                <AgentChatComposer
                    chat={chat.controller}
                    deviceRole={deviceRole}
                    draft={draft}
                    focusComposer={focusComposer}
                    isConnected={isConnected}
                    isHandedOff={chat.isHandedOff}
                    isVisible={isVisible}
                    onComposerFocused={onComposerFocused}
                    onDraftChange={onDraftChange}
                    provider={chat.provider}
                    providerId={chat.providerId}
                    sessionId={session.id}
                    supportsImages={chat.supportsImages}
                    theme={theme}
                />
            ) : (
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
            )}
        </KeyboardAvoidingView>
    );
};
