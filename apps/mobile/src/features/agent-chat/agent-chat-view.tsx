/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
    agentChatDockedPlan,
    agentChatFailureMessage,
    sentenceStartProvider,
} from '@caxri/protocol';

import { NoticeBanner } from '../../components/notice-banner';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { ConversationMessageTarget } from '../conversation/conversation-message-actions';
import { ConversationMessageActions } from '../conversation/conversation-message-actions';
import { ConversationMessageSheet } from '../conversation/conversation-message-sheet';
import { ConversationUserAttachments } from '../conversation/conversation-user-attachments';
import { ConversationList } from '../conversation/conversation-view';
import { SavedCopyNote } from '../read-cache/saved-copy-note';
import { AgentChatGoalBar } from './agent-chat-goal-bar';
import { AgentChatMcpServersContext } from './agent-chat-mcp-icons';
import type { AgentChatEditTarget } from './agent-chat-message-edit';
import {
    agentChatMessageEditAvailability,
    isAgentChatMessageClipped,
} from './agent-chat-message-edit';
import { AgentChatMessageImages } from './agent-chat-message-images';
import {
    agentChatComposerAvailability,
    agentChatEmptyMessage,
    agentChatHandedOffBanner,
    agentChatImageCounts,
    agentChatRequestBlockedReason,
    isAgentChatFailureRetryable,
    shouldShowAgentChatStaleNotice,
} from './agent-chat-model';
import { AgentChatPlanCard } from './agent-chat-plan-card';
import { AgentChatQueueList } from './agent-chat-queue-list';
import { AgentChatRequestCard } from './agent-chat-request-card';
import { agentChatRequestDock } from './agent-chat-request-flow';
import { createAgentChatEntryStabilizer } from './agent-chat-stable-entries';
import { AgentChatStatusRow } from './agent-chat-status-row';
import type { AgentChatTimelineEntry as TimelineEntry } from './agent-chat-timeline';
import {
    agentChatRunningTurnIds,
    buildAgentChatTimeline,
    holdEndedTurnsOpen,
    isAgentChatTurnStart,
    toggleAgentChatExpansion,
    withAgentChatAwaitingReply,
    withAgentChatPendingEntries,
} from './agent-chat-timeline';
import { AgentChatTimelineEntry } from './agent-chat-timeline-entry';
import { AgentChatUsageGuardBanner } from './agent-chat-usage-guard-banner';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatHistory } from './use-agent-chat-history';
import { useIsKeyboardShown } from './use-keyboard-shown';

/**
 * About three lines of the timeline, kept visible however much is docked above the composer.
 */
const TIMELINE_MIN_HEIGHT = 96;

const AgentChatBody = ({
    canSend,
    chat,
    enterFrom,
    isConnected,
    isHandedOff,
    onEditMessage,
    provider,
    theme,
}: {
    /**
     * A view-only device cannot message the Chat, so its empty state does not invite it to.
     */
    canSend: boolean;
    chat: AgentChatController;
    enterFrom: -1 | 0 | 1 | null;
    isConnected: boolean;
    isHandedOff: boolean;
    onEditMessage: (target: AgentChatEditTarget, text: string) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { pending } = chat;
    const [actionTarget, setActionTarget] = useState<ConversationMessageTarget>();
    /**
     * The window with the older pages the reader loaded in front of it; turn folds and artifacts build over both.
     */
    const { snapshot, timeline } = useAgentChatHistory(
        chat.snapshot,
        isConnected && chat.status === 'ready' && chat.savedAt === undefined,
    );
    const { retryConnection } = useMobileClient();
    /**
     * The finished turns the user unfolded, by turn id. The list owns it so FlashList can recycle a row for any turn.
     */
    const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
    const toggleExpansion = useCallback(
        (turnId: string) => setExpandedIds((current) => toggleAgentChatExpansion(current, turnId)),
        [],
    );
    /**
     * Whether the list follows its end. A turn that ends while the reader is parked on earlier content stays open, so
     * finishing never folds away the work they were reading (`holdEndedTurnsOpen`).
     */
    const [isFollowing, setFollowing] = useState(true);
    const [runningTurnIds, setRunningTurnIds] = useState<ReadonlySet<string>>(() => new Set());
    if (snapshot) {
        const running = agentChatRunningTurnIds(snapshot);
        if (
            running.size !== runningTurnIds.size ||
            [...running].some((id) => !runningTurnIds.has(id))
        ) {
            setRunningTurnIds(running);
            setExpandedIds(holdEndedTurnsOpen(expandedIds, runningTurnIds, snapshot, isFollowing));
        }
    }
    const built = useMemo(
        () => (snapshot ? buildAgentChatTimeline(snapshot, expandedIds, t) : []),
        [expandedIds, snapshot, t],
    );
    /**
     * Every streamed patch rebuilds the timeline; the stabilizer hands back last render's object for each unchanged row
     * so only the rows a patch touched redraw.
     */
    const [stabilizeEntries] = useState(() => createAgentChatEntryStabilizer<TimelineEntry>());
    const entries = useMemo(
        () =>
            stabilizeEntries(
                withAgentChatPendingEntries(
                    withAgentChatAwaitingReply(built, snapshot),
                    pending,
                    t,
                ),
            ),
        [built, pending, snapshot, stabilizeEntries, t],
    );
    const renderEntry = useCallback(
        (entry: TimelineEntry) => (
            <AgentChatTimelineEntry entry={entry} onToggle={toggleExpansion} theme={theme} />
        ),
        [theme, toggleExpansion],
    );
    /**
     * Keyed on the messages that carry images, not the snapshot, so a streamed reply does not redraw every entry.
     */
    const imageCounts = agentChatImageCounts(snapshot);
    const terminalId = snapshot?.terminalId;
    const serverList = snapshot?.mcpServers;
    const mcpServers = useMemo(
        () => (serverList ? new Map(serverList.map((server) => [server.name, server])) : undefined),
        [serverList],
    );
    const renderImages = useMemo(() => {
        const counts = new Map<string, number>(
            imageCounts ? (JSON.parse(imageCounts) as Array<[string, number]>) : [],
        );
        return (itemId: string): ReactNode => {
            const count = counts.get(itemId);
            return count && terminalId ? (
                <AgentChatMessageImages
                    count={count}
                    itemId={itemId}
                    terminalId={terminalId}
                    theme={theme}
                />
            ) : null;
        };
    }, [imageCounts, terminalId, theme]);
    if (entries.length > 0)
        return (
            <ConversationUserAttachments value={renderImages}>
                <AgentChatMcpServersContext value={mcpServers}>
                    <ConversationMessageActions value={setActionTarget}>
                        <ConversationList
                            entries={entries}
                            enterFrom={enterFrom}
                            followKey={pending.sendCount}
                            isConnected={isConnected}
                            isTurnStart={isAgentChatTurnStart}
                            onFollowingChange={setFollowing}
                            onRetry={chat.refresh}
                            renderEntry={renderEntry}
                            theme={theme}
                            timeline={timeline}
                        />
                    </ConversationMessageActions>
                </AgentChatMcpServersContext>
                {actionTarget ? (
                    <AgentChatMessageSheet
                        canSend={canSend}
                        chat={chat}
                        isConnected={isConnected}
                        message={actionTarget}
                        onClose={() => setActionTarget(undefined)}
                        onEditMessage={onEditMessage}
                        snapshot={snapshot}
                        theme={theme}
                    />
                ) : null}
            </ConversationUserAttachments>
        );
    if (chat.status === 'error')
        return (
            <View style={styles.status} testID="agent-chat-status-error">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {t('chat.loadFailed')}
                </Text>
                <Pressable
                    accessibilityRole="button"
                    onPress={chat.refresh}
                    style={[styles.bannerButton, { backgroundColor: theme.surface }]}
                    testID="agent-chat-reload"
                >
                    <Text style={[styles.bannerButtonText, { color: theme.text }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </View>
        );
    // Offline with no saved copy, the read cannot start; say so instead of spinning until the connection returns.
    // Retry starts a foreground reconnect now, the same step the Conversation's Retry takes while disconnected, instead
    // of leaving the reader to wait out the backoff.
    if (!snapshot && !isConnected)
        return (
            <View style={styles.status} testID="agent-chat-status-offline">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {t('chat.reconnectToLoad')}
                </Text>
                <Pressable
                    accessibilityHint={t('chat.reconnectHint')}
                    accessibilityRole="button"
                    onPress={retryConnection}
                    style={[styles.bannerButton, { backgroundColor: theme.surface }]}
                    testID="agent-chat-reconnect"
                >
                    <Text style={[styles.bannerButtonText, { color: theme.text }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </View>
        );
    if (!snapshot || snapshot.status === 'starting')
        return (
            <View style={styles.status} testID="agent-chat-status-loading">
                <Spinner color={theme.muted} />
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {snapshot ? t('chat.starting', { provider }) : t('chat.loading')}
                </Text>
            </View>
        );
    return (
        <View style={styles.status} testID="agent-chat-status-empty">
            <Text style={[styles.statusText, { color: theme.muted }]}>
                {agentChatEmptyMessage({ canSend, isHandedOff, provider }, t)}
            </Text>
        </View>
    );
};

/**
 * A long-pressed Chat message's actions. Its whole text comes from Server Core while the Chat is live, so a long
 * message the phone holds only the tail of copies whole and an edit starts from exactly what was sent; a saved copy, or
 * a message that left Core's projection, copies the text the phone holds unless that is only a tail.
 */
const AgentChatMessageSheet = ({
    canSend,
    chat,
    isConnected,
    message,
    onClose,
    onEditMessage,
    snapshot,
    theme,
}: {
    canSend: boolean;
    chat: AgentChatController;
    isConnected: boolean;
    message: ConversationMessageTarget;
    onClose: () => void;
    onEditMessage: (target: AgentChatEditTarget, text: string) => void;
    /**
     * The window with the older pages the reader loaded, so a message from those pages finds its turn.
     */
    snapshot: AgentChatController['snapshot'];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isLive = isConnected && chat.savedAt === undefined;
    const readText = async (): Promise<string> => {
        const isClipped = isAgentChatMessageClipped(message.text);
        if (!isLive) {
            if (isClipped) throw new Error('Only the tail of this message is on the phone');
            return message.text;
        }
        try {
            return await chat.readMessage(message.id);
        } catch (error) {
            if (isClipped) throw error;
            return message.text;
        }
    };
    const availability = isLive
        ? agentChatMessageEditAvailability(snapshot, message.id, t)
        : { canEdit: false as const, reason: t('chat.disabled.send.offline') };
    return (
        <ConversationMessageSheet
            edit={
                canSend && message.role === 'user'
                    ? {
                          availability,
                          onEdit: (text) => {
                              if (availability.canEdit)
                                  onEditMessage(
                                      {
                                          itemId: message.id,
                                          removedTurns: availability.removedTurns,
                                      },
                                      text,
                                  );
                          },
                      }
                    : undefined
            }
            onClose={onClose}
            readText={readText}
            theme={theme}
        />
    );
};

/**
 * The pending requests docked above the composer, one card at a time (`agentChatRequestDock`), so a phone never scrolls
 * several whole cards as one block and loses a question's title. The dock is capped at 80% of the Chat, like the Chat's
 * sheets, so the timeline keeps the sent message in view; inside it the card's options or approval text scroll while
 * its title and buttons stay put. A 60% cap left a two-option question on a phone with one and a sliver of rows.
 *
 * Every request's card stays mounted, the ones not shown hidden: an answered card waits hidden while its answer is on
 * its way, so a refused answer brings it back with its choices and the card's own error instead of a blank card.
 */
const AgentChatRequests = ({
    blockedReason,
    chat,
    isExpanded,
    provider,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    chat: AgentChatController;
    /**
     * The keyboard is up beside this dock, so the card may take the timeline's whole share of the screen.
     */
    isExpanded: boolean;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { pending, respond, snapshot } = chat;
    const { answeredRequestIds } = pending;
    const requests = snapshot?.requests ?? [];
    if (requests.length === 0) return null;
    const dock = agentChatRequestDock(requests, answeredRequestIds, t);
    return (
        <View
            style={[
                styles.dock,
                isExpanded && styles.dockExpanded,
                { borderColor: theme.border },
                dock.currentId === undefined && styles.hidden,
            ]}
            testID="agent-chat-requests"
        >
            {requests.map((request) => (
                <View
                    key={request.id}
                    style={request.id === dock.currentId ? styles.dockCard : styles.hidden}
                >
                    <AgentChatRequestCard
                        blockedReason={blockedReason}
                        items={snapshot?.items ?? []}
                        onRespond={respond}
                        positionLabel={dock.positionLabel}
                        provider={provider}
                        request={request}
                        theme={theme}
                    />
                </View>
            ))}
        </View>
    );
};

/**
 * Whether a request card waits in the dock while the keyboard is up. The card needs its question, answer field, and
 * buttons beside the keyboard; on a phone the timeline's floor and the dock's 80% cap left it too short for them, so
 * meanwhile the timeline yields its share to the card.
 */
const useIsRequestBesideKeyboard = (chat: AgentChatController): boolean => {
    const { t } = useTranslation();
    const isKeyboardShown = useIsKeyboardShown();
    if (!isKeyboardShown) return false;
    const requests = chat.snapshot?.requests ?? [];
    return (
        agentChatRequestDock(requests, chat.pending.answeredRequestIds, t).currentId !== undefined
    );
};

/**
 * The phone's Chat: Desktop's Chat timeline in the Conversation's list (Markdown replies, work rows and summaries, each
 * finished turn folded behind its `Worked for` row with its artifacts under the reply), with the Chat's own states,
 * pending requests, plan, and activity docked above the composer.
 */
export const AgentChatView = ({
    chat,
    deviceRole,
    enterFrom,
    isConnected,
    isHandedOff,
    onEditMessage,
    onEditQueued,
    provider,
    theme,
}: {
    chat: AgentChatController;
    /**
     * Reply and control devices retry a failed provider; only a control device answers approvals and questions.
     */
    deviceRole: 'view' | 'reply' | 'control' | null;
    enterFrom: -1 | 0 | 1 | null;
    /**
     * While the phone is disconnected the app-wide connection banner already explains the stale copy, so the Chat only
     * reports its own read failures.
     */
    isConnected: boolean;
    /**
     * The Chat was detached for another client. Like the detached PTY chip, the notice offers no action: the phone
     * cannot resume a Session, and Retry restarts only a failed Chat.
     */
    isHandedOff: boolean;
    /**
     * Starts "Edit from Here" on an earlier message: its whole text goes into the composer, which sends it as an edit.
     */
    onEditMessage: (target: AgentChatEditTarget, text: string) => void;
    /**
     * Puts a queued message's full text, taken back by its Edit, into the composer draft.
     */
    onEditQueued: (text: string) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isRestarting, setRestarting] = useState(false);
    const [restartError, setRestartError] = useState<string | null>(null);
    const { snapshot } = chat;
    const dockedPlan = agentChatDockedPlan(snapshot);
    /**
     * Reply access is the bar for both retrying a failed provider and sending a message, matching
     * `agentChatDisabledReason`.
     */
    const canRetry = deviceRole === 'reply' || deviceRole === 'control';
    const restart = async (): Promise<void> => {
        setRestarting(true);
        setRestartError(null);
        try {
            await chat.restart();
        } catch {
            setRestartError(t('chat.restartFailed', { provider: sentenceStartProvider(provider) }));
        } finally {
            setRestarting(false);
        }
    };
    const failure =
        snapshot?.status === 'failed' && chat.savedAt === undefined ? snapshot.failure : undefined;
    /**
     * A missing or outdated provider needs the computer, so its banner explains that step and offers no Retry.
     */
    const canRetryFailure =
        canRetry && failure !== undefined && isAgentChatFailureRetryable(failure.reason);
    /**
     * Deleting, steering with, or resuming a queued message needs what sending needs, so the card follows the composer.
     */
    const canActOnQueue = agentChatComposerAvailability(
        { deviceRole, isConnected, isHandedOff, snapshot },
        t,
    ).isEnabled;
    const blockedReason = useMemo(
        () => agentChatRequestBlockedReason({ deviceRole, isConnected }, t),
        [deviceRole, isConnected, t],
    );
    const isTimelineYielding = useIsRequestBesideKeyboard(chat);

    return (
        <View style={styles.root} testID="agent-chat">
            {failure ? (
                <NoticeBanner
                    actionLabel={canRetryFailure ? t('common.retry') : undefined}
                    isBusy={isRestarting}
                    message={
                        restartError ??
                        agentChatFailureMessage(
                            failure.reason,
                            { canRetry, providerName: provider, surface: 'mobile' },
                            t,
                        )
                    }
                    onAction={() => {
                        void restart();
                    }}
                    testID="agent-chat-failed"
                    theme={theme}
                    tone="danger"
                />
            ) : null}
            {isHandedOff ? (
                <NoticeBanner
                    message={agentChatHandedOffBanner(t)}
                    testID="agent-chat-handed-off"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            {snapshot?.usageGuard ? (
                <AgentChatUsageGuardBanner
                    guard={snapshot.usageGuard}
                    provider={provider}
                    theme={theme}
                />
            ) : null}
            {shouldShowAgentChatStaleNotice(chat, isConnected) ? (
                <NoticeBanner
                    actionLabel={t('common.retry')}
                    message={t('chat.stale')}
                    onAction={chat.refresh}
                    testID="agent-chat-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            {/* Saved-copy and state notices share the top of the segment, as on the Conversation. */}
            <SavedCopyNote savedAt={chat.savedAt} testID="agent-chat-saved" theme={theme} />
            <View style={[styles.body, isTimelineYielding && styles.bodyYielding]}>
                <AgentChatBody
                    canSend={canRetry}
                    chat={chat}
                    enterFrom={enterFrom}
                    isConnected={isConnected}
                    isHandedOff={isHandedOff}
                    onEditMessage={onEditMessage}
                    provider={provider}
                    theme={theme}
                />
            </View>
            {dockedPlan ? (
                <AgentChatPlanCard
                    isTurnRunning={dockedPlan.isTurnRunning}
                    plan={dockedPlan.plan}
                    theme={theme}
                />
            ) : null}
            <AgentChatGoalBar canAct={canActOnQueue} chat={chat} theme={theme} />
            <AgentChatRequests
                blockedReason={blockedReason}
                chat={chat}
                isExpanded={isTimelineYielding}
                provider={provider}
                theme={theme}
            />
            <AgentChatStatusRow
                chat={chat}
                deviceRole={deviceRole}
                isConnected={isConnected}
                provider={provider}
                theme={theme}
            />
            <AgentChatQueueList
                canAct={canActOnQueue}
                chat={chat}
                onEdit={onEditQueued}
                theme={theme}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    /**
     * With the keyboard up, the plan, requests, activity, and queue docked above the composer could otherwise crush the
     * timeline to nothing; the docks shrink first (the queue also collapses while typing), so a few lines stay
     * readable.
     */
    body: { flex: 1, minHeight: TIMELINE_MIN_HEIGHT },
    bodyYielding: { minHeight: 0 },
    bannerButton: {
        alignItems: 'center',
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 48,
        minWidth: 72,
        paddingHorizontal: 14,
    },
    bannerButtonText: { fontSize: 14, fontWeight: '700' },
    status: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
    statusText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
    dock: { borderTopWidth: 1, flexShrink: 1, maxHeight: '80%', padding: 12 },
    dockExpanded: { maxHeight: '100%' },
    dockCard: { flexShrink: 1 },
    hidden: { display: 'none' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
