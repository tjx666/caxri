import { useCallback, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, Text, View } from 'react-native';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationEntry } from './conversation-entry';
import type { ConversationEntry as Entry } from './conversation-model';
import {
    CONVERSATION_FOLLOW_THRESHOLD,
    groupConversationItems,
    shouldFollowConversation,
    shouldShowConversationJump,
} from './conversation-model';
import { conversationStyles as styles } from './conversation-styles';
import type { ConversationTimelineState } from './use-conversation-timeline';

const ConversationHistory = ({
    error,
    historyExpired,
    isLoadingOlder,
    onLoadOlder,
    olderCursor,
    theme,
    truncated,
}: {
    error: string | null;
    historyExpired: boolean;
    isLoadingOlder: boolean;
    onLoadOlder: () => void;
    olderCursor?: string;
    theme: MobileTheme;
    truncated: boolean;
}) => (
    <View style={styles.history}>
        {historyExpired ? (
            <Text
                accessibilityRole="alert"
                style={[styles.historyText, { color: theme.muted }]}
                testID="conversation-history-expired"
            >
                Conversation history changed on your computer. Showing the latest messages.
            </Text>
        ) : null}
        {olderCursor ? (
            <Pressable
                accessibilityRole="button"
                disabled={isLoadingOlder}
                onPress={onLoadOlder}
                style={[styles.button, { backgroundColor: theme.surface }]}
                testID="conversation-load-earlier"
            >
                <Text style={[styles.buttonText, { color: theme.text }]}>
                    {isLoadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                </Text>
            </Pressable>
        ) : null}
        {truncated ? (
            <Text
                style={[styles.historyText, { color: theme.muted }]}
                testID="conversation-history-truncated"
            >
                Earlier messages are available on your computer.
            </Text>
        ) : null}
        {error ? (
            <Text
                accessibilityRole="alert"
                style={[styles.historyText, { color: theme.danger }]}
                testID="conversation-history-error"
            >
                {error}
            </Text>
        ) : null}
    </View>
);

const ConversationStatus = ({
    historyExpired,
    onRetry,
    status,
    theme,
}: {
    historyExpired: boolean;
    onRetry: () => void;
    status: ConversationTimelineState['status'] | 'empty';
    theme: MobileTheme;
}) => {
    const message = {
        loading: 'Loading Conversation…',
        available: '',
        unsupported: '',
        missing: '',
        empty: 'No messages yet. Send a message to start the Conversation.',
        error: 'Unable to load Conversation.',
        stale: 'Reconnect to update Conversation.',
    }[status];
    return (
        <View style={styles.status} testID={`conversation-status-${status}`}>
            {historyExpired ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.statusText, { color: theme.muted }]}
                    testID="conversation-history-expired"
                >
                    Conversation history changed on your computer. Showing the latest messages.
                </Text>
            ) : null}
            <Text style={[styles.statusText, { color: theme.muted }]}>{message}</Text>
            {status === 'error' || status === 'stale' ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    style={[styles.button, { backgroundColor: theme.surface }]}
                    testID="conversation-retry"
                >
                    <Text style={[styles.buttonText, { color: theme.text }]}>Retry</Text>
                </Pressable>
            ) : null}
        </View>
    );
};

export const ConversationView = ({
    onRetry,
    theme,
    timeline,
}: {
    onRetry: () => void;
    theme: MobileTheme;
    timeline: ConversationTimelineState & { loadOlder: () => Promise<void> };
}) => {
    const list = useRef<FlashListRef<Entry>>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const entries = useMemo(() => groupConversationItems(timeline.items), [timeline.items]);
    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
        setIsAtBottom(shouldFollowConversation(distance, layoutMeasurement.height));
    }, []);
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<Entry>) => <ConversationEntry entry={item} theme={theme} />,
        [theme],
    );
    const jumpToLatest = useCallback((): void => {
        list.current?.scrollToEnd({ animated: true });
    }, []);
    if (timeline.items.length === 0) {
        const status = timeline.status === 'available' ? 'empty' : timeline.status;
        return (
            <ConversationStatus
                historyExpired={timeline.historyExpired}
                onRetry={onRetry}
                status={status}
                theme={theme}
            />
        );
    }
    return (
        <View style={styles.root} testID="conversation-view">
            <FlashList
                contentContainerStyle={styles.listContent}
                data={entries}
                keyExtractor={(entry) => entry.id}
                ListHeaderComponent={
                    <ConversationHistory
                        error={timeline.error}
                        historyExpired={timeline.historyExpired}
                        isLoadingOlder={timeline.isLoadingOlder}
                        onLoadOlder={() => {
                            // eslint-disable-next-line no-void -- The timeline hook owns the bounded page request.
                            void timeline.loadOlder();
                        }}
                        olderCursor={timeline.olderCursor}
                        theme={theme}
                        truncated={timeline.truncated}
                    />
                }
                maintainVisibleContentPosition={{
                    autoscrollToBottomThreshold: CONVERSATION_FOLLOW_THRESHOLD,
                    animateAutoScrollToBottom: false,
                    startRenderingFromBottom: true,
                }}
                onScroll={onScroll}
                onStartReached={() => {
                    if (timeline.olderCursor && !timeline.isLoadingOlder) {
                        // eslint-disable-next-line no-void -- The timeline hook serializes older-page reads.
                        void timeline.loadOlder();
                    }
                }}
                onStartReachedThreshold={0.25}
                ref={list}
                renderItem={renderItem}
                scrollEventThrottle={32}
                style={styles.list}
            />
            {timeline.status === 'stale' ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={onRetry}
                    testID="conversation-status-stale"
                >
                    <Text style={[styles.historyText, { color: theme.muted }]}>
                        Reconnect to update Conversation. Retry
                    </Text>
                </Pressable>
            ) : null}
            {shouldShowConversationJump(isAtBottom, entries.length > 0) ? (
                <Pressable
                    accessibilityRole="button"
                    onPress={jumpToLatest}
                    style={[styles.button, styles.jump, { backgroundColor: theme.primary }]}
                    testID="conversation-jump-latest"
                >
                    <Text style={[styles.buttonText, { color: theme.primaryForeground }]}>
                        Jump to latest
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};
