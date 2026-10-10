/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useMemo, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatRequest } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationView } from '../conversation/conversation-view';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import {
    AGENT_CHAT_HANDED_OFF_NOTICE,
    agentChatActivityLabel,
    agentChatEmptyMessage,
    agentChatFailureMessage,
    agentChatTimelineItems,
} from './agent-chat-model';
import { AgentChatRequestCard } from './agent-chat-request-card';
import type { AgentChatController } from './use-agent-chat';

const noOlderPage = async (): Promise<void> => {};

const Banner = ({
    actionLabel,
    isBusy,
    message,
    onAction,
    testID,
    theme,
    tone,
}: {
    actionLabel?: string;
    isBusy?: boolean;
    message: string;
    onAction?: () => void;
    testID: string;
    theme: MobileTheme;
    tone: 'danger' | 'muted';
}) => (
    <View
        accessibilityRole="alert"
        style={[styles.banner, { borderColor: theme.border }]}
        testID={testID}
    >
        <Text
            style={[styles.bannerText, { color: tone === 'danger' ? theme.danger : theme.muted }]}
        >
            {message}
        </Text>
        {actionLabel && onAction ? (
            <Pressable
                accessibilityRole="button"
                disabled={isBusy}
                onPress={onAction}
                style={[styles.bannerButton, { backgroundColor: theme.surface }]}
                testID={`${testID}-action`}
            >
                {isBusy ? (
                    <ActivityIndicator color={theme.text} />
                ) : (
                    <Text style={[styles.bannerButtonText, { color: theme.text }]}>
                        {actionLabel}
                    </Text>
                )}
            </Pressable>
        ) : null}
    </View>
);

const AgentChatBody = ({
    canSend,
    chat,
    enterFrom,
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
    if (timeline.items.length > 0)
        return (
            <ConversationView
                enterFrom={enterFrom}
                onRetry={chat.refresh}
                theme={theme}
                timeline={timeline}
            />
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
    canAnswer,
    chat,
    provider,
    theme,
}: {
    canAnswer: boolean;
    chat: AgentChatController;
    provider: string;
    theme: MobileTheme;
}) => {
    const { respond, snapshot } = chat;
    const items = snapshot?.items;
    const renderRequest = useCallback(
        ({ item }: ListRenderItemInfo<AgentChatRequest>) => (
            <AgentChatRequestCard
                canAnswer={canAnswer}
                items={items ?? []}
                onRespond={respond}
                provider={provider}
                request={item}
                theme={theme}
            />
        ),
        [canAnswer, items, provider, respond, theme],
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
    if (!activity || !snapshot || snapshot.status === 'starting') return null;
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
     * `agentChatComposerDisabledReason`.
     */
    const canRetry = deviceRole === 'reply' || deviceRole === 'control';
    const restart = async (): Promise<void> => {
        setRestarting(true);
        setRestartError(null);
        try {
            await chat.restart();
        } catch {
            setRestartError(`${provider} could not be restarted. Try again.`);
        } finally {
            setRestarting(false);
        }
    };
    const failure = snapshot?.status === 'failed' ? snapshot.failure : undefined;

    return (
        <View style={styles.root} testID="agent-chat">
            {failure ? (
                <Banner
                    actionLabel={canRetry ? 'Retry' : undefined}
                    isBusy={isRestarting}
                    message={
                        restartError ?? agentChatFailureMessage(failure.reason, provider, canRetry)
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
                <Banner
                    message={AGENT_CHAT_HANDED_OFF_NOTICE}
                    testID="agent-chat-handed-off"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            {isConnected && chat.status === 'stale' ? (
                <Banner
                    actionLabel="Retry"
                    message="This Chat could not be updated."
                    onAction={chat.refresh}
                    testID="agent-chat-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            <View style={styles.body}>
                <AgentChatBody
                    canSend={canRetry}
                    chat={chat}
                    enterFrom={enterFrom}
                    isHandedOff={isHandedOff}
                    provider={provider}
                    theme={theme}
                />
            </View>
            <AgentChatRequests
                canAnswer={deviceRole === 'control'}
                chat={chat}
                provider={provider}
                theme={theme}
            />
            <AgentChatActivity chat={chat} provider={provider} theme={theme} />
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    body: { flex: 1 },
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
    bannerButton: {
        alignItems: 'center',
        borderRadius: 10,
        justifyContent: 'center',
        minHeight: 44,
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
