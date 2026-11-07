import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useRef, useState } from 'react';
import type { HostInstance } from 'react-native';
import { Text, View } from 'react-native';

import {
    ChevronLeft,
    CircleCheck,
    EllipsisVertical,
    MailOpen,
    MessagesSquare,
    SquareTerminal,
} from 'lucide-react-native';

import { AgentGlyph } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import { PopoverAction, PopoverDivider, PopoverMenu } from '../../../components/popover-menu';
import { usePopoverAnchor } from '../../../components/use-popover-anchor';
import type { Translate, TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { isAgentChatTerminal } from '../../agent-chat/agent-chat-model';
import { PreviewChip, PreviewMenuActions } from '../../browser/preview-chip';
import { useOpenPreview } from '../../browser/use-open-preview';
import { useSessionPreviews } from '../../browser/use-session-previews';
import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import { PullRequestChip } from '../../pull-request/pull-request-chip';
import { useSessionPullRequest } from '../../pull-request/use-session-pull-request';
import { useSavedClock } from '../../read-cache/use-saved-age';
import { segmentForAgentSurface } from '../agent-surface-switch';
import { useAgentSurfaceSwitch } from '../hooks/use-agent-surface-switch';
import type { SessionMenuActions } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import { canMarkSessionDone } from '../session-model';
import { sessionStateLabel, sessionTitleForDisplay } from '../session-row-model';
import type { SessionScoped } from '../session-scoped-state';
import { patchSessionScoped, readSessionScoped } from '../session-scoped-state';
import type { ContentSessionSegment, SessionSegment } from '../session-ui-state';
import {
    AgentSurfaceSwitchConfirm,
    AgentSurfaceSwitchMenuAction,
    AgentSurfaceSwitchStatus,
} from './agent-surface-switch-controls';
import { sessionDetailStyles as styles } from './session-detail-styles';
import { SessionMenuActionEntries, SessionMenuActionsError } from './session-menu-actions';
import { SessionSidePanelButton } from './session-side-panel';
import { SessionStatusGlyph } from './session-status-glyph';

/**
 * The menu item that swaps an Agent Terminal's two content segments. It names the one it opens, so the item reads as a
 * destination; the side panel holds every other view.
 */
const ContentSwitchMenuAction = ({
    onPress,
    target,
    theme,
}: {
    onPress: () => void;
    target: ContentSessionSegment;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            <PopoverAction
                icon={target === 'terminal' ? SquareTerminal : MessagesSquare}
                label={t(
                    target === 'terminal'
                        ? 'sessions.detail.showTerminal'
                        : 'sessions.detail.showConversation',
                )}
                onPress={onPress}
                testID={`session-show-${target}`}
                theme={theme}
            />
            <PopoverDivider theme={theme} />
        </>
    );
};

interface MarkReadState {
    message: string | null;
}

const NO_MARK_READ_ERROR: MarkReadState = { message: null };

/**
 * Runs a menu's Mark read or Mark as Done request and keeps its failure beside the Session that raised it: a paired
 * device without reply access reads the forbidden message, any other failure the generic one.
 */
function useMarkAction({
    closeMenu,
    sessionId,
    setMarkReadErrors,
    t,
}: {
    closeMenu: () => void;
    sessionId: string;
    setMarkReadErrors: Dispatch<SetStateAction<SessionScoped<MarkReadState>>>;
    t: Translate;
}) {
    return useCallback(
        async (
            action: () => Promise<void>,
            forbiddenKey: TranslationKey,
            failedKey: TranslationKey,
        ): Promise<void> => {
            closeMenu();
            let message: string | null = null;
            try {
                await action();
            } catch (error) {
                message = t(
                    error instanceof MobileGatewayRequestError && error.code === 'FORBIDDEN'
                        ? forbiddenKey
                        : failedKey,
                );
            }
            setMarkReadErrors((previous) =>
                patchSessionScoped(previous, sessionId, NO_MARK_READ_ERROR, { message }),
            );
        },
        [closeMenu, sessionId, setMarkReadErrors, t],
    );
}

/**
 * The menu's attention items: Mark as Done while the Session holds Pending Attention, and Mark read always.
 */
function AttentionMenuActions({
    canMarkDone,
    isConnected,
    onMarkDone,
    onMarkRead,
    theme,
}: {
    canMarkDone: boolean;
    isConnected: boolean;
    onMarkDone: () => Promise<void>;
    onMarkRead: () => Promise<void>;
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    return (
        <>
            {canMarkDone ? (
                <PopoverAction
                    disabled={!isConnected}
                    icon={CircleCheck}
                    label={t('sessions.detail.markDone')}
                    onPress={onMarkDone}
                    testID="session-mark-done"
                    theme={theme}
                />
            ) : null}
            <PopoverAction
                disabled={!isConnected}
                icon={MailOpen}
                label={t('sessions.detail.markRead')}
                onPress={onMarkRead}
                testID="session-mark-read"
                theme={theme}
            />
        </>
    );
}

export const SessionDetailHeader = ({
    changesCount,
    contentSwitchTarget,
    deviceRole,
    isCompacting,
    isConnected,
    isSidePanelOpen,
    onBack,
    onMarkDone,
    onMarkRead,
    onSegmentChange,
    onToggleSidePanel,
    savedAt,
    session,
    sessionActions,
    theme,
}: {
    changesCount: number | null;
    /**
     * The other content segment an Agent Terminal offers (its Terminal or its Conversation), or `null` when the Session
     * has only one, as a Chat or a plain shell does.
     */
    contentSwitchTarget: ContentSessionSegment | null;
    deviceRole: 'view' | 'reply' | 'control' | null;
    /**
     * Whether the Session's Chat is compacting its context; its timeline shows that, so the title does not spin too.
     */
    isCompacting: boolean;
    isConnected: boolean;
    isSidePanelOpen: boolean;
    onBack?: () => void;
    onMarkDone: () => Promise<void>;
    onMarkRead: () => Promise<void>;
    onSegmentChange: (segment: SessionSegment) => void;
    onToggleSidePanel: () => void;
    /**
     * When `session` comes from the Session list saved on this phone rather than a live read.
     */
    savedAt: number | null;
    session: MobileSessionItem;
    /**
     * Fork, Continue in Another Agent, and Delete; only a control device passes them.
     */
    sessionActions?: SessionMenuActions;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const menuAnchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(menuAnchor);
    const { close: closeMenu } = menu;
    /**
     * Keyed by Session ID: the wide layout keeps this header mounted across selections, so a failure belongs only to
     * the Session whose "Mark read" raised it.
     */
    const [markReadErrors, setMarkReadErrors] = useState<SessionScoped<MarkReadState>>({});
    const markReadError = readSessionScoped(markReadErrors, session.id, NO_MARK_READ_ERROR).message;
    const sessionId = session.id;
    const [isTitleExpanded, setTitleExpanded] = useState(false);
    const [isPullRequestOpen, setPullRequestOpen] = useState(false);
    // The header owns both reads so it can tell which one holds the inline slot: a pull request wins, and the preview
    // entry moves into the menu, which keeps a 360dp header to the back button, title, one chip, and the menu.
    const pullRequest = useSessionPullRequest(session.id, isPullRequestOpen);
    const previews = useSessionPreviews(session.id, deviceRole);
    const openPreview = useOpenPreview(previews);
    const hasPullRequest = Boolean(pullRequest.pullRequest);
    const isChat = isAgentChatTerminal(session.primaryTerminal);
    const now = useSavedClock(savedAt);
    const surfaceSwitch = useAgentSurfaceSwitch(session, (surface) =>
        onSegmentChange(segmentForAgentSurface(surface)),
    );
    /**
     * Reopening the Agent replaces its process and may stop its turn, so only a control device sees it, as with Stop.
     */
    const surfaceTarget = deviceRole === 'control' ? surfaceSwitch.target : null;
    const isSwitchingSurface = surfaceSwitch.pending !== null;
    const handleSwitchSurface = useCallback((): void => {
        closeMenu();
        void surfaceSwitch.switchSurface();
    }, [closeMenu, surfaceSwitch]);
    const runMarkAction = useMarkAction({ closeMenu, sessionId, setMarkReadErrors, t });
    const handleMarkRead = useCallback(
        () =>
            runMarkAction(
                onMarkRead,
                'sessions.detail.markReadForbidden',
                'sessions.detail.markReadFailed',
            ),
        [onMarkRead, runMarkAction],
    );
    const handleMarkDone = useCallback(
        () =>
            runMarkAction(
                onMarkDone,
                'sessions.detail.markDoneForbidden',
                'sessions.detail.markDoneFailed',
            ),
        [onMarkDone, runMarkAction],
    );
    return (
        <>
            <View style={[styles.header, { borderColor: theme.border }]}>
                <View style={styles.headerLine}>
                    {onBack ? (
                        <IconButton
                            accessibilityHint={t('sessions.detail.backHint')}
                            accessibilityLabel={t('sessions.backToSessions')}
                            icon={ChevronLeft}
                            onPress={onBack}
                            size={26}
                            testID="session-detail-back"
                            theme={theme}
                        />
                    ) : null}
                    <View style={styles.titleGroup}>
                        <AgentGlyph kind={session.primaryTerminal?.kind} size={18} theme={theme} />
                        {/* A long title is cut to one line; tapping it reveals the rest, so it is announced as a toggle. */}
                        <Text
                            accessibilityHint={t(
                                isTitleExpanded
                                    ? 'sessions.detail.collapseTitleHint'
                                    : 'sessions.detail.expandTitleHint',
                            )}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: isTitleExpanded }}
                            numberOfLines={isTitleExpanded ? 3 : 1}
                            onPress={() => setTitleExpanded((current) => !current)}
                            style={[styles.title, { color: theme.text }]}
                            testID="session-detail-title"
                        >
                            {sessionTitleForDisplay(session.title, t)}
                        </Text>
                        <SessionStatusGlyph
                            // A Chat's status row already spins for the run, so the title does not spin too. The Chat
                            // stays on screen under the side panel, which covers this header on a phone anyway.
                            isRunShownBelow={isCompacting || isChat}
                            isSaved={savedAt !== null}
                            label={sessionStateLabel(session.stateLabel, savedAt, now, t)}
                            session={session}
                            theme={theme}
                        />
                    </View>
                    {hasPullRequest ? (
                        <PullRequestChip
                            deviceRole={deviceRole}
                            isConnected={isConnected}
                            isOpen={isPullRequestOpen}
                            onOpenChange={setPullRequestOpen}
                            state={pullRequest}
                            theme={theme}
                        />
                    ) : (
                        <PreviewChip onOpen={openPreview} previews={previews} theme={theme} />
                    )}
                    <SessionSidePanelButton
                        changesCount={changesCount}
                        isOpen={isSidePanelOpen}
                        onPress={onToggleSidePanel}
                        theme={theme}
                    />
                    <View collapsable={false} ref={menuAnchor}>
                        <IconButton
                            accessibilityLabel={t('sessions.detail.menu')}
                            expanded={menu.isOpen}
                            icon={EllipsisVertical}
                            onPress={menu.open}
                            testID="session-detail-menu"
                            theme={theme}
                        />
                    </View>
                </View>
                <PopoverMenu
                    closeLabel={t('sessions.detail.closeMenu')}
                    onClose={closeMenu}
                    placement={menu.placement}
                    theme={theme}
                >
                    {contentSwitchTarget ? (
                        <ContentSwitchMenuAction
                            onPress={() => {
                                closeMenu();
                                onSegmentChange(contentSwitchTarget);
                            }}
                            target={contentSwitchTarget}
                            theme={theme}
                        />
                    ) : null}
                    {hasPullRequest && previews.targets.length > 0 ? (
                        <>
                            <PreviewMenuActions
                                onClose={closeMenu}
                                onOpen={openPreview}
                                previews={previews}
                                theme={theme}
                            />
                            <PopoverDivider theme={theme} />
                        </>
                    ) : null}
                    {surfaceTarget ? (
                        <AgentSurfaceSwitchMenuAction
                            isDisabled={!isConnected || isSwitchingSurface}
                            onPress={handleSwitchSurface}
                            target={surfaceTarget}
                            theme={theme}
                        />
                    ) : null}
                    <AttentionMenuActions
                        canMarkDone={canMarkSessionDone(session)}
                        isConnected={isConnected}
                        onMarkDone={handleMarkDone}
                        onMarkRead={handleMarkRead}
                        theme={theme}
                    />
                    <SessionMenuActionEntries
                        actions={sessionActions}
                        isConnected={isConnected}
                        onClose={closeMenu}
                        session={session}
                        theme={theme}
                    />
                    {!isConnected ? (
                        <Text style={[styles.sendState, { color: theme.muted }]}>
                            {t('sessions.detail.reconnectForActions')}
                        </Text>
                    ) : null}
                </PopoverMenu>
                {surfaceSwitch.confirmation ? (
                    <AgentSurfaceSwitchConfirm
                        confirmation={surfaceSwitch.confirmation}
                        onClose={surfaceSwitch.dismissConfirmation}
                        onConfirm={() => {
                            void surfaceSwitch.confirm();
                        }}
                        theme={theme}
                    />
                ) : null}
                <AgentSurfaceSwitchStatus
                    error={surfaceSwitch.error}
                    pending={surfaceSwitch.pending}
                    theme={theme}
                />
                <SessionMenuActionsError actions={sessionActions} theme={theme} />
                {markReadError ? (
                    <Text
                        accessibilityRole="alert"
                        style={[styles.sendState, { color: theme.danger }]}
                    >
                        {markReadError}
                    </Text>
                ) : null}
            </View>
        </>
    );
};
