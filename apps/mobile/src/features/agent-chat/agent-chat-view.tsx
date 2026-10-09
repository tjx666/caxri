/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationView } from '../conversation/conversation-view';
import type { ConversationTimelineState } from '../conversation/use-conversation-timeline';
import {
    agentChatActivityLabel,
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

/**
 * The phone's Chat: the same Conversation rendering a terminal Agent gets (Markdown replies, grouped tool rows, a
 * collapsed Thought row for reasoning), with the Chat's own states and pending requests docked above the composer.
 */
export const AgentChatView = ({
    canAnswer,
    canRetry,
    chat,
    enterFrom,
    isConnected,
    provider,
    theme,
}: {
    /**
     * Only a control device answers approvals and questions.
     */
    canAnswer: boolean;
    canRetry: boolean;
    chat: AgentChatController;
    enterFrom: -1 | 0 | 1 | null;
    /**
     * While the phone is disconnected the app-wide connection banner already explains the stale copy, so the Chat only
     * reports its own read failures.
     */
    isConnected: boolean;
    provider: string;
    theme: MobileTheme;
}) => {
    const [isRestarting, setRestarting] = useState(false);
    const [restartError, setRestartError] = useState<string | null>(null);
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
    const activity = agentChatActivityLabel(snapshot, provider);
    const requests = snapshot?.requests ?? [];

    let body: ReactNode;
    if (timeline.items.length > 0)
        body = (
            <ConversationView
                enterFrom={enterFrom}
                onRetry={() => {
                    chat.refresh();
                }}
                theme={theme}
                timeline={timeline}
            />
        );
    else if (chat.status === 'error')
        body = (
            <View style={styles.status} testID="agent-chat-status-error">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    Unable to load this Chat.
                </Text>
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        chat.refresh();
                    }}
                    style={[styles.bannerButton, { backgroundColor: theme.surface }]}
                    testID="agent-chat-reload"
                >
                    <Text style={[styles.bannerButtonText, { color: theme.text }]}>Retry</Text>
                </Pressable>
            </View>
        );
    else if (!snapshot || snapshot.status === 'starting')
        body = (
            <View style={styles.status} testID="agent-chat-status-loading">
                <ActivityIndicator color={theme.muted} />
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {snapshot ? `Starting ${provider}…` : 'Loading Chat…'}
                </Text>
            </View>
        );
    else
        body = (
            <View style={styles.status} testID="agent-chat-status-empty">
                <Text style={[styles.statusText, { color: theme.muted }]}>
                    {`No messages yet. Send a message to start working with ${provider}.`}
                </Text>
            </View>
        );

    return (
        <View style={styles.root} testID="agent-chat">
            {snapshot?.status === 'failed' && snapshot.failure ? (
                <Banner
                    actionLabel={canRetry ? 'Retry' : undefined}
                    isBusy={isRestarting}
                    message={
                        restartError ?? agentChatFailureMessage(snapshot.failure.reason, provider)
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
            {isConnected && chat.status === 'stale' ? (
                <Banner
                    actionLabel="Retry"
                    message="This Chat could not be updated."
                    onAction={() => {
                        chat.refresh();
                    }}
                    testID="agent-chat-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            <View style={styles.body}>{body}</View>
            {requests.length > 0 ? (
                <ScrollView
                    contentContainerStyle={styles.requests}
                    style={[styles.dock, { borderColor: theme.border }]}
                    testID="agent-chat-requests"
                >
                    {requests.map((request) => (
                        <AgentChatRequestCard
                            key={request.id}
                            canAnswer={canAnswer}
                            items={snapshot?.items ?? []}
                            onRespond={chat.respond}
                            request={request}
                            theme={theme}
                        />
                    ))}
                </ScrollView>
            ) : null}
            {activity && snapshot && snapshot.status !== 'starting' ? (
                <View style={styles.activity} testID="agent-chat-activity">
                    {activity.isBusy ? (
                        <ActivityIndicator color={theme.muted} size="small" />
                    ) : null}
                    <Text style={[styles.activityText, { color: theme.muted }]}>
                        {activity.text}
                    </Text>
                </View>
            ) : null}
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
        minHeight: 36,
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
