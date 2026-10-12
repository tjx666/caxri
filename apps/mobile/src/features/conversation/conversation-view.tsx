import { useCallback, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Platform, Pressable, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { ArrowDown } from 'lucide-react-native';

import { NoticeBanner } from '../../components/notice-banner';
import type { MobileTheme } from '../../theme/tokens';
import { SavedCopyNote } from '../read-cache/saved-copy-note';
import { PANEL_ENTER_MS, segmentEnterOffset } from '../sessions/hooks/use-segment-entering';
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
    canSend,
    onRetry,
    status,
    theme,
}: {
    canSend: boolean;
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
        empty: canSend
            ? 'No messages yet. Send a message to start the Conversation.'
            : 'No messages yet.',
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

/**
 * FlashList 2.0.2 places `startRenderingFromBottom` from estimated row heights, then corrects the offset over several
 * frames while rows measure; on a Conversation of mixed-height rows that reads as the list scrolling into place and
 * blanking mid-transition. The list stays transparent until an explicit scroll to the end has landed, so the first
 * visible frame is already the settled bottom.
 * https://github.com/Shopify/flash-list/blob/v2.0.2/src/recyclerview/hooks/useRecyclerViewController.tsx
 *
 * Positioning outlasts a tab switch's entering animation, so a list opened by a tab switch plays that motion itself
 * when it is revealed. Only the wrapper's opacity and transform animate; the list's own layout and measurement are
 * untouched.
 */
const ConversationList = ({
    enterFrom,
    isConnected,
    onRetry,
    theme,
    timeline,
}: {
    enterFrom: -1 | 0 | 1 | null;
    isConnected: boolean;
    onRetry: () => void;
    theme: MobileTheme;
    timeline: ConversationTimelineState & { loadOlder: () => Promise<void> };
}) => {
    const list = useRef<FlashListRef<Entry>>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const isAtBottomReference = useRef(true);
    const viewportHeight = useRef(0);
    const isPositionedReference = useRef(false);
    const revealProgress = useSharedValue(0);
    const enterOffset = enterFrom === null ? 0 : segmentEnterOffset(enterFrom);
    const revealStyle = useAnimatedStyle(() => ({
        opacity: revealProgress.get(),
        transform: [{ translateX: (1 - revealProgress.get()) * enterOffset }],
    }));
    const entries = useMemo(() => groupConversationItems(timeline.items), [timeline.items]);
    const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
        // Initial positioning passes through offsets far from the end; they are not the reader's scroll.
        if (!isPositionedReference.current) return;
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
        const isFollowing = shouldFollowConversation(distance, layoutMeasurement.height);
        isAtBottomReference.current = isFollowing;
        setIsAtBottom(isFollowing);
    }, []);
    /**
     * `autoscrollToBottomThreshold` follows new content only; a viewport that shrinks under a docked card or the
     * keyboard would otherwise leave a reader who was at the end looking at older rows.
     */
    const onViewportLayout = useCallback((event: LayoutChangeEvent): void => {
        const { height } = event.nativeEvent.layout;
        const hasShrunk = height < viewportHeight.current;
        viewportHeight.current = height;
        if (hasShrunk && isPositionedReference.current && isAtBottomReference.current)
            list.current?.scrollToEnd({ animated: false });
    }, []);
    const onLoad = useCallback((): void => {
        const reveal = (): void => {
            isPositionedReference.current = true;
            revealProgress.set(
                enterFrom === null ? 1 : withTiming(1, { duration: PANEL_ENTER_MS }),
            );
        };
        /**
         * FlashList resolves `scrollToEnd` before its native scroll, which it defers by one task; reveal one frame
         * after that task has run.
         */
        // eslint-disable-next-line no-void -- Reveal failures leave a readable list; there is nothing to report.
        void Promise.resolve(list.current?.scrollToEnd({ animated: false })).finally(() => {
            setTimeout(() => requestAnimationFrame(reveal), 0);
        });
    }, [enterFrom, revealProgress]);
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<Entry>) => (
            <View style={styles.entry}>
                <ConversationEntry entry={item} theme={theme} />
            </View>
        ),
        [theme],
    );
    const jumpToLatest = useCallback((): void => {
        list.current?.scrollToEnd({ animated: true });
    }, []);
    return (
        <View style={styles.root} testID="conversation-view">
            {/*
             * Notices sit above the timeline, as on a Chat. Offline, the app-wide Reconnecting banner already explains
             * a stale Conversation, so this one appears only when the connection is up but the read failed.
             */}
            <SavedCopyNote savedAt={timeline.savedAt} testID="conversation-saved" theme={theme} />
            {isConnected && timeline.status === 'stale' ? (
                <NoticeBanner
                    actionLabel="Retry"
                    message="This Conversation could not be updated. Showing the last loaded messages."
                    onAction={onRetry}
                    testID="conversation-status-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            <Animated.View onLayout={onViewportLayout} style={[styles.list, revealStyle]}>
                <FlashList
                    contentContainerStyle={styles.listContent}
                    data={entries}
                    /**
                     * Dragging the timeline dismisses the composer keyboard (following the finger on iOS), and a tap on
                     * a row's button lands on the first touch instead of only closing the keyboard.
                     */
                    keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                    keyboardShouldPersistTaps="handled"
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
                    onLoad={onLoad}
                    onScroll={onScroll}
                    onStartReached={() => {
                        if (
                            isPositionedReference.current &&
                            timeline.olderCursor &&
                            !timeline.isLoadingOlder
                        ) {
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
            </Animated.View>
            {shouldShowConversationJump(isAtBottom, entries.length > 0) ? (
                <Pressable
                    accessibilityLabel="Jump to latest"
                    accessibilityRole="button"
                    onPress={jumpToLatest}
                    style={[
                        styles.jump,
                        { backgroundColor: theme.elevated, borderColor: theme.border },
                    ]}
                    testID="conversation-jump-latest"
                >
                    <ArrowDown color={theme.text} size={20} />
                </Pressable>
            ) : null}
        </View>
    );
};

export const ConversationView = ({
    canSend = true,
    enterFrom = null,
    isConnected = true,
    onRetry,
    theme,
    timeline,
}: {
    /**
     * Whether this device may message the Agent. A view-only device's empty state does not invite it to send.
     */
    canSend?: boolean;
    /**
     * The side a tab switch opened this Conversation from, or `null` when no tab switch motion should play.
     */
    enterFrom?: -1 | 0 | 1 | null;
    /**
     * Whether the connection is live. Offline, the app-wide banner explains a stale Conversation instead.
     */
    isConnected?: boolean;
    onRetry: () => void;
    theme: MobileTheme;
    timeline: ConversationTimelineState & { loadOlder: () => Promise<void> };
}) => {
    if (timeline.items.length === 0) {
        const status = timeline.status === 'available' ? 'empty' : timeline.status;
        return (
            <ConversationStatus
                canSend={canSend}
                historyExpired={timeline.historyExpired}
                onRetry={onRetry}
                status={status}
                theme={theme}
            />
        );
    }
    return (
        <ConversationList
            enterFrom={enterFrom}
            isConnected={isConnected}
            onRetry={onRetry}
            theme={theme}
            timeline={timeline}
        />
    );
};
