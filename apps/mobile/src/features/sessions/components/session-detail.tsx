import type { ComponentProps } from 'react';
import { useMemo } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, View } from 'react-native';

import { isPinnedSession } from '@caxri/protocol';

import { NoticeBanner } from '../../../components/notice-banner';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileAgentChatSessionCommand } from '../../agent-chat/agent-chat-app-commands';
import { AgentChatComposer } from '../../agent-chat/agent-chat-composer';
import { AgentChatImageFlights } from '../../agent-chat/agent-chat-image-flights';
import { useReleaseMessageEdit } from '../../agent-chat/use-release-message-edit';
import { useSessionAgentChat } from '../../agent-chat/use-session-agent-chat';
import { ChangesPanel } from '../../changes/changes-panel';
import { COMMIT_DRAFT, OPEN_PULL_REQUEST_DRAFT } from '../../changes/changes-view';
import { useChangesList } from '../../changes/use-changes';
import type { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import { ProjectPanelView } from '../../panels/panels-view';
import { useSessionPanels } from '../../panels/use-panels';
import { useDrawerPresence } from '../hooks/use-drawer-motion';
import type { SessionMenuActions } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import type {
    ContentSessionSegment,
    SessionSegment,
    SideSessionSegment,
} from '../session-ui-state';
import {
    isChatAwaitingBehindSidePanel,
    isChatSegmentShown,
    isPanelSessionSegment,
    isSideSessionSegment,
    panelIdOfSegment,
    panelSessionSegment,
    sessionSegments,
    shownContentSegment,
    sideSegmentToOpen,
} from '../session-ui-state';
import { SessionDetailBody } from './session-detail-body';
import { SessionDetailComposer } from './session-detail-composer';
import { SessionDetailHeader } from './session-detail-header';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionSidePanel } from './session-side-panel';

/**
 * What the side panel shows: one of the Project's panels, or the Session's Changes.
 */
const SessionSidePanelContent = ({
    askAgent,
    changes,
    deviceRole,
    onSegmentChange,
    panels,
    segment,
    session,
    theme,
}: {
    askAgent: (prompt: string) => void;
    changes: ReturnType<typeof useChangesList>;
    deviceRole: 'view' | 'reply' | 'control' | null;
    onSegmentChange: (segment: SessionSegment) => void;
    panels: ReturnType<typeof useSessionPanels>;
    segment: SideSessionSegment;
    session: MobileSessionItem;
    theme: MobileTheme;
}) =>
    isPanelSessionSegment(segment) ? (
        <ProjectPanelView
            deviceRole={deviceRole}
            onOpenChat={() => onSegmentChange('conversation')}
            panelId={panelIdOfSegment(segment)}
            panels={panels}
            sessionId={session.id}
            theme={theme}
        />
    ) : (
        <ChangesPanel
            key={session.id}
            canAskAgent={
                (deviceRole === 'reply' || deviceRole === 'control') &&
                Boolean(session.primaryAgentEndpoint)
            }
            list={changes}
            onAskAgentToCommit={() => askAgent(COMMIT_DRAFT)}
            onAskAgentToOpenPullRequest={() => askAgent(OPEN_PULL_REQUEST_DRAFT)}
            sessionId={session.id}
            theme={theme}
        />
    );

/**
 * The composer under the Chat, Conversation, or Terminal, whether or not the side panel is open: the Chat composer for
 * a Chat Session, and the Terminal composer otherwise. A control device keeps it on the Terminal too, even though it
 * can type into a leased Terminal directly: Changes' Ask Agent drafts land here, and a Session with no Conversation
 * offers no other place for a multi-line prompt, an image, or Stop.
 */
const SessionComposer = ({
    chat,
    deviceRole,
    draft,
    focusComposer,
    hostId,
    isConnected,
    isVisible,
    onComposerFocused,
    onDraftChange,
    onRefresh,
    onSessionCommand,
    session,
    theme,
}: {
    chat: ReturnType<typeof useSessionAgentChat>;
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    focusComposer?: boolean;
    hostId: string;
    isConnected: boolean;
    isVisible: boolean;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    onRefresh: () => Promise<void>;
    onSessionCommand?: (command: MobileAgentChatSessionCommand) => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) =>
    chat ? (
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
    );

export const SessionDetail = ({
    contentSegment: rememberedContentSegment,
    deviceRole,
    draft,
    conversationFallback,
    conversationTimeline,
    focusComposer,
    hasConversation,
    hostId,
    isConnected,
    isSidePanelDocked,
    isVisible,
    lastSideSegment,
    onBack,
    onComposerFocused,
    onDraftChange,
    onEditQueued,
    onMarkDone,
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
}: {
    /**
     * The content segment the user last chose, which stays on screen while a side segment is open.
     */
    contentSegment: ContentSessionSegment;
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    conversationFallback: boolean;
    conversationTimeline: ReturnType<typeof useConversationTimeline>;
    focusComposer?: boolean;
    hasConversation: boolean;
    hostId: string;
    isConnected: boolean;
    /**
     * A wide tablet docks the side panel beside the content; any narrower layout draws it as a drawer over the Session.
     */
    isSidePanelDocked: boolean;
    isVisible: boolean;
    /**
     * The side segment this Session last showed, which the side panel button reopens.
     */
    lastSideSegment: SideSessionSegment | undefined;
    onBack?: () => void;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    /**
     * Puts a queued Chat message taken back for editing into the draft and focuses the composer.
     */
    onEditQueued: (text: string) => void;
    onMarkDone: () => Promise<void>;
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
}) => {
    const { t } = useTranslation();
    const changes = useChangesList(isVisible, session.id);
    const panels = useSessionPanels(session.id);
    /**
     * A Chat stays observed while it is on screen: its own segment, or under or beside the side panel.
     */
    const chat = useSessionAgentChat({
        isObserved: isVisible && isChatSegmentShown(segment),
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
    const contentSegments = segments.filter((option) => !isSideSessionSegment(option));
    const sideSegments = segments.filter(isSideSessionSegment);
    const contentSegment = shownContentSegment(segment, rememberedContentSegment, isChat);
    const sideSegment = isSideSessionSegment(segment) ? segment : null;
    const changesCount = changes.state.snapshot?.changedFileCount ?? null;
    const closeSidePanel = (): void => onSegmentChange(contentSegment);
    const toggleSidePanel = (): void => {
        if (sideSegment) {
            closeSidePanel();
            return;
        }
        // The drawer covers the composer, so a keyboard left open would only shrink it.
        Keyboard.dismiss();
        onSegmentChange(sideSegmentToOpen(lastSideSegment, segments));
    };
    /**
     * Asking the Agent puts a prompt in the composer; a phone's drawer covers the composer, so it closes to show it.
     */
    const askAgent = (prompt: string): void => {
        onDraftChange(prompt);
        if (!isSidePanelDocked) closeSidePanel();
    };
    const isDrawerOpen = sideSegment !== null && !isSidePanelDocked;
    /**
     * The other content segment, which the ⋮ menu switches to.
     */
    const contentSwitchTarget =
        contentSegments.find(
            (option): option is ContentSessionSegment => option !== contentSegment,
        ) ?? null;
    const editMessage: ComponentProps<typeof SessionDetailBody>['onEditMessage'] = (
        target,
        text,
    ) => {
        if (!chat) return;
        // A second edit keeps the draft held back by the first, so Cancel still restores what was typed.
        chat.controller.setEditing({
            ...target,
            previousDraft: chat.controller.editing?.previousDraft ?? draft,
        });
        onDraftChange(text);
        onRequestComposerFocus();
    };
    /**
     * A phone's drawer stays mounted on the segment it showed while it slides out after closing.
     */
    const drawer = useDrawerPresence(isDrawerOpen ? sideSegment : null);
    /**
     * The drawer passes `isDocked` false even if the window just widened, so a drawer still sliding out stays an
     * overlay instead of rendering beside the docked panel that replaces it.
     */
    const renderSidePanel = (shown: SideSessionSegment, isOpen: boolean, isDocked: boolean) => (
        <SessionSidePanel
            changesCount={changesCount}
            isAwaitingAnswer={isChatAwaitingBehindSidePanel({
                agentActivityState: session.agentActivityState,
                isChat,
                isCovered: isDrawerOpen,
            })}
            isDocked={isDocked}
            isOpen={isOpen}
            onClose={closeSidePanel}
            onExited={drawer.onExited}
            onSegmentChange={onSegmentChange}
            panels={panels.panels}
            segment={shown}
            segments={sideSegments}
            theme={theme}
        >
            <SessionSidePanelContent
                askAgent={askAgent}
                changes={changes}
                deviceRole={deviceRole}
                onSegmentChange={onSegmentChange}
                panels={panels}
                segment={shown}
                session={session}
                theme={theme}
            />
        </SessionSidePanel>
    );
    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="session-detail"
        >
            {/* The drawer is modal: a screen reader skips the Session it covers. */}
            <View
                accessibilityElementsHidden={isDrawerOpen}
                importantForAccessibility={isDrawerOpen ? 'no-hide-descendants' : 'auto'}
                style={styles.root}
            >
                <SessionDetailHeader
                    changesCount={changesCount}
                    contentSwitchTarget={contentSwitchTarget}
                    deviceRole={deviceRole}
                    isCompacting={chat?.controller.snapshot?.operation === 'compacting'}
                    isConnected={isConnected}
                    isSidePanelOpen={sideSegment !== null}
                    onBack={onBack}
                    onMarkDone={onMarkDone}
                    onMarkRead={onMarkRead}
                    onSegmentChange={onSegmentChange}
                    onToggleSidePanel={toggleSidePanel}
                    savedAt={savedAt}
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
                    chat={chat}
                    contentSegment={contentSegment}
                    contentSegments={contentSegments}
                    conversationTimeline={conversationTimeline}
                    deviceRole={deviceRole}
                    dockedSidePanel={
                        isSidePanelDocked && sideSegment
                            ? renderSidePanel(sideSegment, true, true)
                            : null
                    }
                    isConnected={isConnected}
                    isVisible={isVisible}
                    onEditMessage={editMessage}
                    onEditQueued={onEditQueued}
                    onSegmentChange={onSegmentChange}
                    session={session}
                    theme={theme}
                />
                <SessionComposer
                    chat={chat}
                    deviceRole={deviceRole}
                    draft={draft}
                    focusComposer={focusComposer}
                    hostId={hostId}
                    isConnected={isConnected}
                    isVisible={isVisible}
                    onComposerFocused={onComposerFocused}
                    onDraftChange={onDraftChange}
                    onRefresh={onRefresh}
                    onSessionCommand={onSessionCommand}
                    session={session}
                    theme={theme}
                />
                <AgentChatImageFlights isVisible={isVisible} />
            </View>
            {drawer.shown ? renderSidePanel(drawer.shown, isDrawerOpen, false) : null}
        </KeyboardAvoidingView>
    );
};
