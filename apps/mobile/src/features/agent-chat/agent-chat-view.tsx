/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
    agentChatDockedPlan,
    agentChatFailureMessage,
    agentChatSnapshotBeforeItem,
    sentenceStartProvider,
} from '@caxri/protocol';

import { Button } from '../../components/button';
import { NoticeBanner } from '../../components/notice-banner';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import type { ConversationMessageTarget } from '../conversation/conversation-message-actions';
import { ConversationMessageActions } from '../conversation/conversation-message-actions';
import { ConversationMessageSheet } from '../conversation/conversation-message-sheet';
import { ConversationUserAttachments } from '../conversation/conversation-user-attachments';
import { conversationActionText } from '../conversation/conversation-user-text';
import { ConversationList } from '../conversation/conversation-view';
import { MessageReadOfflineError } from '../conversation/read-whole-message';
import { SavedCopyNote } from '../read-cache/saved-copy-note';
import { AgentChatContinueScope } from './agent-chat-continue';
import { AgentChatDock } from './agent-chat-dock';
import type { AgentChatHandoffSource } from './agent-chat-handoff';
import { AgentChatHandoffScope } from './agent-chat-handoff-scope';
import { AgentChatMcpServersContext } from './agent-chat-mcp-icons';
import type { AgentChatEditTarget } from './agent-chat-message-edit';
import {
    agentChatMessageEditAvailability,
    isAgentChatMessageClipped,
} from './agent-chat-message-edit';
import {
    agentChatComposerAvailability,
    agentChatEmptyMessage,
    agentChatHandedOffBanner,
    agentChatRequestBlockedReason,
    isAgentChatFailureRetryable,
    shouldShowAgentChatStaleNotice,
} from './agent-chat-model';
import { AgentChatPlanCard } from './agent-chat-plan-card';
import { createAgentChatEntryStabilizer } from './agent-chat-stable-entries';
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
import {
    agentChatUsageActionBlockedReason,
    AgentChatUsageActionScope,
} from './agent-chat-usage-actions';
import { AgentChatUsageGuardCard } from './agent-chat-usage-guard-card';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatHistory } from './use-agent-chat-history';
import { useAgentChatMessageAttachments } from './use-agent-chat-message-attachments';
import { useIsRequestBesideKeyboard } from './use-request-beside-keyboard';

/**
 * About three lines of the timeline, kept visible however much is docked above the composer.
 */
const TIMELINE_MIN_HEIGHT = 96;

const AgentChatBody = ({
    canSend,
    chat,
    enterFrom,
    handoffSource,
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
    handoffSource: AgentChatHandoffSource;
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
    const { snapshot: loadedSnapshot, timeline } = useAgentChatHistory(
        chat.snapshot,
        isConnected && chat.status === 'ready' && chat.savedAt === undefined,
    );
    const { retryConnection } = useMobileClient();
    /**
     * What the timeline shows: while an edit is on its way, the message it replaces and everything after it are already
     * gone, as they will be once Server Core rewinds.
     */
    const snapshot = useMemo(
        () => agentChatSnapshotBeforeItem(loadedSnapshot, pending.replacedFrom),
        [loadedSnapshot, pending.replacedFrom],
    );
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
            <AgentChatTimelineEntry
                entry={entry}
                onToggle={toggleExpansion}
                provider={provider}
                theme={theme}
            />
        ),
        [provider, theme, toggleExpansion],
    );
    const renderAttachments = useAgentChatMessageAttachments(snapshot, theme);
    const terminalId = snapshot?.terminalId;
    const serverList = snapshot?.mcpServers;
    const mcpServers = useMemo(
        () => (serverList ? new Map(serverList.map((server) => [server.name, server])) : undefined),
        [serverList],
    );
    const usageBlockedReason = agentChatUsageActionBlockedReason({ canSend, isConnected }, t);
    const usageScope = useMemo(
        () =>
            terminalId === undefined
                ? undefined
                : { blockedReason: usageBlockedReason, terminalId },
        [terminalId, usageBlockedReason],
    );
    if (entries.length > 0)
        return (
            <ConversationUserAttachments value={renderAttachments}>
                <AgentChatMcpServersContext value={mcpServers}>
                    <AgentChatHandoffScope canSend={canSend} chat={chat} source={handoffSource}>
                        <ConversationMessageActions value={setActionTarget}>
                            <AgentChatUsageActionScope value={usageScope}>
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
                            </AgentChatUsageActionScope>
                        </ConversationMessageActions>
                    </AgentChatHandoffScope>
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
                <Button
                    label={t('common.retry')}
                    onPress={chat.refresh}
                    style={styles.stateButton}
                    testID="agent-chat-reload"
                    theme={theme}
                    variant="secondary"
                />
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
                <Button
                    accessibilityHint={t('chat.reconnectHint')}
                    label={t('common.retry')}
                    onPress={retryConnection}
                    style={styles.stateButton}
                    testID="agent-chat-reconnect"
                    theme={theme}
                    variant="secondary"
                />
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
        /**
         * A saved copy still reads the whole text while the phone is connected: the Server finds the message by id, or
         * says it is gone. Only an unreachable computer leaves a clipped message unreadable.
         */
        if (!isConnected) {
            if (isClipped) throw new MessageReadOfflineError();
            return message.text;
        }
        try {
            // A Desktop hand-off message copies and edits as the user's note, never the Agent's instructions.
            return conversationActionText(await chat.readMessage(message.id));
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
 * The phone's Chat: Desktop's Chat timeline in the Conversation's list (Markdown replies, work rows and summaries, each
 * finished turn folded behind its `Worked for` row with its artifacts under the reply), with the Chat's own states,
 * pending requests, plan, and activity docked above the composer.
 */
export const AgentChatView = ({
    chat,
    deviceRole,
    enterFrom,
    handoffSource,
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
     * The Session, Project, and Agent a `/new-session` hand-off started from this Chat names.
     */
    handoffSource: AgentChatHandoffSource;
    /**
     * While the phone is disconnected the app-wide connection banner already explains the stale copy, so the Chat only
     * reports its own read failures.
     */
    isConnected: boolean;
    /**
     * The Chat was detached for another client. Like the detached PTY chip, the notice offers no action: Resume Agent
     * lives in the Session menu of a control device, and Retry restarts only a failed Chat.
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
    const usageBlockedReason = agentChatUsageActionBlockedReason(
        { canSend: canRetry, isConnected },
        t,
    );

    return (
        <AgentChatContinueScope
            deviceRole={deviceRole}
            isConnected={isConnected}
            sessionId={handoffSource.sessionId}
            terminalId={snapshot?.terminalId}
            theme={theme}
        >
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
                    <AgentChatUsageGuardCard
                        blockedReason={usageBlockedReason}
                        guard={snapshot.usageGuard}
                        provider={provider}
                        terminalId={snapshot.terminalId}
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
                        handoffSource={handoffSource}
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
                <AgentChatDock
                    blockedReason={blockedReason}
                    canAct={canActOnQueue}
                    chat={chat}
                    deviceRole={deviceRole}
                    isConnected={isConnected}
                    isTimelineYielding={isTimelineYielding}
                    onEditQueued={onEditQueued}
                    provider={provider}
                    theme={theme}
                />
            </View>
        </AgentChatContinueScope>
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
    stateButton: { minWidth: 96 },
    status: {
        alignItems: 'center',
        flex: 1,
        gap: mobileSpace.md,
        justifyContent: 'center',
        padding: mobileSpace.xl,
    },
    statusText: { ...mobileType.body, textAlign: 'center' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
