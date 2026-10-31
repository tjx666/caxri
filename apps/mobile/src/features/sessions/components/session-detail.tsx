import { useMemo } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { isPinnedSession } from '@caxri/protocol';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileAgentChatSessionCommand } from '../../agent-chat/agent-chat-app-commands';
import { AgentChatComposer } from '../../agent-chat/agent-chat-composer';
import { useReleaseMessageEdit } from '../../agent-chat/use-release-message-edit';
import { useSessionAgentChat } from '../../agent-chat/use-session-agent-chat';
import { ChangesPanel } from '../../changes/changes-panel';
import { COMMIT_DRAFT } from '../../changes/changes-view';
import { useChangesList } from '../../changes/use-changes';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { ProjectPanelView } from '../../panels/panels-view';
import { useSessionPanels } from '../../panels/use-panels';
import type { SessionMenuActions } from '../session-management-model';
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
    onEditQueued,
    onMarkRead,
    onRequestComposerFocus,
    onRefresh,
    onSegmentChange,
    onSessionCommand,
    savedAt,
    segment,
    session,
    sessionActions,
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
    /**
     * Puts a queued Chat message taken back for editing into the draft and focuses the composer.
     */
    onEditQueued: (text: string) => void;
    onMarkRead: () => Promise<void>;
    /**
     * Focuses the composer once, as a notification reply does.
     */
    onRequestComposerFocus: () => void;
    onRefresh: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    /**
     * Runs the Chat's `/rename`, `/archive`, or `/pin`; absent while the device may not manage Sessions.
     */
    onSessionCommand?: (command: MobileAgentChatSessionCommand) => void;
    /**
     * When `session` comes from the Session list saved on this phone rather than a live read.
     */
    savedAt: number | null;
    segment: SessionSegment;
    session: MobileSessionItem;
    sessionActions?: SessionMenuActions;
    theme: MobileTheme;
    wideChanges: boolean;
    wideBackgroundSegment: 'conversation' | 'terminal';
}) => {
    const { t } = useTranslation();
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
    useReleaseMessageEdit(chat?.controller, session.id, onDraftChange);
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
                deviceRole={deviceRole}
                isCompacting={chat?.controller.snapshot?.operation === 'compacting'}
                isConnected={isConnected}
                onBack={onBack}
                onMarkRead={onMarkRead}
                onSegmentChange={onSegmentChange}
                panels={panels.panels}
                savedAt={savedAt}
                segment={segment}
                segments={segments}
                session={session}
                sessionActions={sessionActions}
                theme={theme}
            />
            {conversationFallback ? (
                <NoticeBanner
                    message={t('sessions.detail.conversationFallback')}
                    testID="conversation-fallback-banner"
                    theme={theme}
                    tone="muted"
                />
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
                onEditMessage={(target, text) => {
                    if (!chat) return;
                    // A second edit keeps the draft held back by the first, so Cancel still restores what was typed.
                    chat.controller.setEditing({
                        ...target,
                        previousDraft: chat.controller.editing?.previousDraft ?? draft,
                    });
                    onDraftChange(text);
                    onRequestComposerFocus();
                }}
                onEditQueued={onEditQueued}
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
                    isPinned={isPinnedSession(session)}
                    isVisible={isVisible}
                    onComposerFocused={onComposerFocused}
                    onDraftChange={onDraftChange}
                    onSessionCommand={onSessionCommand}
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
