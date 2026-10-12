/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatRequest } from '@caxri/protocol';
import { agentChatFailureMessage, sentenceStartProvider } from '@caxri/protocol';

import { NoticeBanner } from '../../components/notice-banner';
import type { MobileTheme } from '../../theme/tokens';
import { ConversationUserAttachments } from '../conversation/conversation-user-attachments';
import { ConversationView } from '../conversation/conversation-view';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import { SavedCopyNote } from '../read-cache/saved-copy-note';
import { AgentChatMessageImages } from './agent-chat-message-images';
import {
    AGENT_CHAT_HANDED_OFF_BANNER,
    agentChatActivityLabel,
    agentChatEmptyMessage,
    agentChatImageCounts,
    agentChatRequestBlockedReason,
    agentChatTimelineItems,
    isAgentChatFailureRetryable,
} from './agent-chat-model';
import { AgentChatQueueList } from './agent-chat-queue-list';
import { AgentChatRequestCard } from './agent-chat-request-card';
import type { AgentChatController } from './use-agent-chat';

const noOlderPage = async (): Promise<void> => {};

const AgentChatBody = ({
    canSend,
    chat,
    enterFrom,
    isConnected,
    isHandedOff,
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
    provider: string;
    theme: MobileTheme;
}) => {
    const { snapshot } = chat;
    const timeline = useMemo<ConversationTimelineState & { loadOlder: () => Promise<void> }>(
        () => ({
            error: null,
            historyExpired: false,
            isLoadingOlder: false,
            items: snapshot ? agentChatTimelineItems(snapshot) : [],
            loadOlder: noOlderPage,
            status: 'available',
            truncated: snapshot?.truncated ?? false,
        }),
        [snapshot],
    );
    /**
     * Keyed on the messages that carry images, not the snapshot, so a streamed reply does not redraw every entry.
     */
    const imageCounts = agentChatImageCounts(snapshot);
    const terminalId = snapshot?.terminalId;
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
    if (timeline.items.length > 0)
        return (
            <ConversationUserAttachments value={renderImages}>
                <ConversationView
                    enterFrom={enterFrom}
                    onRetry={chat.refresh}
                    theme={theme}
                    timeline={timeline}
                />
            </ConversationUserAttachments>
        );
    if (chat.status === 'error')
        return (
            <View style={styles.status} testID="agent-chat-status-error">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    Unable to load this Chat.
                </Text>
                <Pressable
                    accessibilityRole="button"
                    onPress={chat.refresh}
                    style={[styles.bannerButton, { backgroundColor: theme.surface }]}
                    testID="agent-chat-reload"
                >
                    <Text style={[styles.bannerButtonText, { color: theme.text }]}>Retry</Text>
                </Pressable>
            </View>
        );
    // Offline with no saved copy, the read cannot start; say so instead of spinning until the connection returns.
    if (!snapshot && !isConnected)
        return (
            <View style={styles.status} testID="agent-chat-status-offline">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    Reconnect to load this Chat.
                </Text>
            </View>
        );
    if (!snapshot || snapshot.status === 'starting')
        return (
            <View style={styles.status} testID="agent-chat-status-loading">
                <ActivityIndicator color={theme.muted} />
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {snapshot ? `Starting ${provider}…` : 'Loading Chat…'}
                </Text>
            </View>
        );
    return (
        <View style={styles.status} testID="agent-chat-status-empty">
            <Text style={[styles.statusText, { color: theme.muted }]}>
                {agentChatEmptyMessage({ canSend, isHandedOff, provider })}
            </Text>
        </View>
    );
};

const AgentChatRequests = ({
    blockedReason,
    chat,
    provider,
    theme,
}: {
    blockedReason: ReturnType<typeof agentChatRequestBlockedReason>;
    chat: AgentChatController;
    provider: string;
    theme: MobileTheme;
}) => {
    const { respond, snapshot } = chat;
    const items = snapshot?.items;
    const renderRequest = useCallback(
        ({ item }: ListRenderItemInfo<AgentChatRequest>) => (
            <AgentChatRequestCard
                blockedReason={blockedReason}
                items={items ?? []}
                onRespond={respond}
                provider={provider}
                request={item}
                theme={theme}
            />
        ),
        [blockedReason, items, provider, respond, theme],
    );
    const requests = snapshot?.requests ?? [];
    if (requests.length === 0) return null;
    return (
        <FlatList
            contentContainerStyle={styles.requests}
            data={requests}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(request) => request.id}
            renderItem={renderRequest}
            style={[styles.dock, { borderColor: theme.border }]}
            testID="agent-chat-requests"
        />
    );
};

const AgentChatActivity = ({
    chat,
    provider,
    theme,
}: {
    chat: AgentChatController;
    provider: string;
    theme: MobileTheme;
}) => {
    const { snapshot } = chat;
    const activity = agentChatActivityLabel(snapshot, provider);
    // A saved copy's activity is however the Chat stood when it was saved, not what it is doing now.
    if (!activity || !snapshot || snapshot.status === 'starting' || chat.savedAt !== undefined)
        return null;
    return (
        <View style={styles.activity} testID="agent-chat-activity">
            {activity.isBusy ? <ActivityIndicator color={theme.muted} size="small" /> : null}
            <Text style={[styles.activityText, { color: theme.muted }]}>{activity.text}</Text>
        </View>
    );
};

/**
 * The phone's Chat: the same Conversation rendering a terminal Agent gets (Markdown replies, grouped tool rows, a
 * collapsed Thought row for reasoning), with the Chat's own states and pending requests docked above the composer.
 */
export const AgentChatView = ({
    chat,
    deviceRole,
    enterFrom,
    isConnected,
    isHandedOff,
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
    provider: string;
    theme: MobileTheme;
}) => {
    const [isRestarting, setRestarting] = useState(false);
    const [restartError, setRestartError] = useState<string | null>(null);
    const { snapshot } = chat;
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
            setRestartError(
                `${sentenceStartProvider(provider)} could not be restarted. Try again.`,
            );
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
    const blockedReason = useMemo(
        () => agentChatRequestBlockedReason({ deviceRole, isConnected }),
        [deviceRole, isConnected],
    );

    return (
        <View style={styles.root} testID="agent-chat">
            {failure ? (
                <NoticeBanner
                    actionLabel={canRetryFailure ? 'Retry' : undefined}
                    isBusy={isRestarting}
                    message={
                        restartError ??
                        agentChatFailureMessage(failure.reason, {
                            canRetry,
                            providerName: provider,
                            surface: 'mobile',
                        })
                    }
                    onAction={() => {
                        // eslint-disable-next-line no-void -- The banner reports a failed restart itself.
                        void restart();
                    }}
                    testID="agent-chat-failed"
                    theme={theme}
                    tone="danger"
                />
            ) : null}
            {isHandedOff ? (
                <NoticeBanner
                    message={AGENT_CHAT_HANDED_OFF_BANNER}
                    testID="agent-chat-handed-off"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            {isConnected && chat.status === 'stale' ? (
                <NoticeBanner
                    actionLabel="Retry"
                    message="This Chat could not be updated. Showing the last loaded messages."
                    onAction={chat.refresh}
                    testID="agent-chat-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            {/* Saved-copy and state notices share the top of the segment, as on the Conversation. */}
            <SavedCopyNote savedAt={chat.savedAt} testID="agent-chat-saved" theme={theme} />
            <View style={styles.body}>
                <AgentChatBody
                    canSend={canRetry}
                    chat={chat}
                    enterFrom={enterFrom}
                    isConnected={isConnected}
                    isHandedOff={isHandedOff}
                    provider={provider}
                    theme={theme}
                />
            </View>
            <AgentChatRequests
                blockedReason={blockedReason}
                chat={chat}
                provider={provider}
                theme={theme}
            />
            <AgentChatActivity chat={chat} provider={provider} theme={theme} />
            <AgentChatQueueList snapshot={snapshot} theme={theme} />
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    body: { flex: 1 },
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
    dock: { borderTopWidth: 1, flexGrow: 0, maxHeight: '55%' },
    requests: { gap: 8, padding: 12 },
    activity: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 6,
    },
    activityText: { fontSize: 13 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
