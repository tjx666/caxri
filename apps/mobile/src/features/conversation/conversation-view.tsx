import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Platform, Pressable, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';
import { ArrowDown } from 'lucide-react-native';

import { NoticeBanner } from '../../components/notice-banner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { SavedCopyNote } from '../read-cache/saved-copy-note';
import { PANEL_ENTER_MS, segmentEnterOffset } from '../sessions/hooks/use-segment-entering';
import { ConversationEntry } from './conversation-entry';
import type { ConversationEntry as GroupedEntry } from './conversation-model';
import {
    CONVERSATION_SEND_FOLLOW_HOLD_MS,
    followConversationToLatest,
    groupConversationItems,
    isConversationFollowing,
    isNewConversationSend,
    shouldShowConversationJump,
} from './conversation-model';
import {
    conversationTurnSpacerHeight,
    createConversationFollower,
    latestConversationTurnStart,
} from './conversation-scroll';
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
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.history}>
            {historyExpired ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-expired"
                >
                    {t('conversation.historyExpired')}
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
                        {t(
                            isLoadingOlder
                                ? 'conversation.loadingEarlier'
                                : 'conversation.loadEarlier',
                        )}
                    </Text>
                </Pressable>
            ) : null}
            {truncated ? (
                <Text
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-truncated"
                >
                    {t('conversation.earlierOnComputer')}
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
};

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
    const { t } = useTranslation();
    const message = {
        loading: t('conversation.loading'),
        available: '',
        unsupported: '',
        missing: '',
        empty: t(canSend ? 'conversation.emptyCanSend' : 'conversation.empty'),
        error: t('conversation.loadFailed'),
        stale: t('conversation.reconnectToUpdate'),
    }[status];
    return (
        <View style={styles.status} testID={`conversation-status-${status}`}>
            {historyExpired ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.statusText, { color: theme.muted }]}
                    testID="conversation-history-expired"
                >
                    {t('conversation.historyExpired')}
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
                    <Text style={[styles.buttonText, { color: theme.text }]}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
};

/**
 * `startRenderingFromBottom` opens the list at its end. FlashList's own `autoscrollToBottomThreshold` is not used: it
 * scrolls to the end on every data change while the reader is near it, including mid-drag, so a streamed reply kept
 * snapping a reader who had started scrolling up back down. `createConversationFollower` follows instead.
 */
const MAINTAIN_VISIBLE_CONTENT_POSITION = { startRenderingFromBottom: true } as const;

const conversationEntryKey = (entry: { id: string }): string => entry.id;

/**
 * The content's bottom padding sits between the rows and the turn spacer, so the spacer leaves it out.
 */
const CONTENT_BOTTOM_INSET = styles.listContent.paddingBottom;

/**
 * The empty space after the rows that lets the latest turn rest at the top of the viewport. Its height is a shared
 * value, so resizing it never re-renders the list.
 */
const ConversationTurnSpacer = ({ height }: { height: SharedValue<number> }) => {
    const style = useAnimatedStyle(() => ({ height: height.get() }));
    return <Animated.View pointerEvents="none" style={style} testID="conversation-turn-spacer" />;
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
 *
 * With `isTurnStart`, the list pins the latest turn the way Desktop's Agent Chat does: a spacer after the rows keeps
 * that turn's first row at the top of the viewport when the list is at its end, so a sent message rises to the top and
 * its reply fills in below it. The spacer is re-measured whenever the content or the viewport changes size; it lives in
 * the footer, outside the rows FlashList measures, so resizing it never changes the measurement it was computed from.
 */
export const ConversationList = <Entry extends { id: string }>({
    entries,
    enterFrom,
    followKey,
    isConnected,
    isTurnStart,
    onFollowingChange,
    onRetry,
    renderEntry,
    theme,
    timeline,
}: {
    /**
     * The rows to draw, already grouped by the caller: a terminal Agent's grouped tool calls, or an Agent Chat's
     * timeline entries. Keep unchanged rows the same objects across updates so FlashList can skip redrawing them.
     */
    entries: readonly Entry[];
    enterFrom: -1 | 0 | 1 | null;
    /**
     * Grows with each message the user sends from this screen; the list then returns to its end and follows again,
     * wherever the reader had scrolled. A Conversation without a composer of its own leaves it unset.
     */
    followKey?: number;
    isConnected: boolean;
    /**
     * Marks the rows that start a turn (the user's messages). When set, the latest turn rests at the top of the
     * viewport at the list's end; when unset, the list simply ends at its last row. Keep it a stable function.
     */
    isTurnStart?: (entry: Entry) => boolean;
    /**
     * Reports whether the list follows its end, so a caller can tell a reader parked on earlier content from one
     * tracking the latest output. Starts as `true`.
     */
    onFollowingChange?: (isFollowing: boolean) => void;
    onRetry: () => void;
    renderEntry: (entry: Entry) => ReactNode;
    theme: MobileTheme;
    timeline: ConversationTimelineState & { loadOlder: () => Promise<void> };
}) => {
    const { t } = useTranslation();
    const list = useRef<FlashListRef<Entry>>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    useEffect(() => {
        onFollowingChange?.(isAtBottom);
    }, [isAtBottom, onFollowingChange]);
    const viewportHeight = useRef(0);
    const isPositionedReference = useRef(false);
    const followHoldUntil = useRef(0);
    const [follower] = useState(() =>
        createConversationFollower({ nextFrame: requestAnimationFrame }),
    );
    useEffect(
        () =>
            follower.connect(() => {
                list.current?.scrollToEnd({ animated: false });
            }),
        [follower],
    );
    const spacerHeight = useSharedValue(0);
    const appliedSpacerHeight = useRef(0);
    /**
     * The latest props the layout callbacks read, so those callbacks (and the list props built from them) stay stable.
     */
    const latest = useRef({ entries, isTurnStart, timeline });
    useLayoutEffect(() => {
        latest.current = { entries, isTurnStart, timeline };
    });
    const revealProgress = useSharedValue(0);
    const enterOffset = enterFrom === null ? 0 : segmentEnterOffset(enterFrom);
    const revealStyle = useAnimatedStyle(() => ({
        opacity: revealProgress.get(),
        transform: [{ translateX: (1 - revealProgress.get()) * enterOffset }],
    }));
    /**
     * Sizes the turn spacer from the latest turn's measured rows and returns whether it changed. A row FlashList has
     * not laid out yet keeps the current spacer; the next layout commit measures again.
     */
    const measureSpacer = useCallback((): boolean => {
        const { entries: rows, isTurnStart: startsTurn } = latest.current;
        const reference = list.current;
        if (!startsTurn || !reference || viewportHeight.current <= 0) return false;
        const index = latestConversationTurnStart(rows, startsTurn);
        let height = 0;
        if (index !== -1) {
            const layout = reference.getLayout(index);
            if (!layout) return false;
            height = conversationTurnSpacerHeight({
                bottomInset: CONTENT_BOTTOM_INSET,
                contentHeight: reference.getChildContainerDimensions().height,
                turnTop: layout.y,
                viewportHeight: viewportHeight.current,
            });
        }
        if (height === appliedSpacerHeight.current) return false;
        appliedSpacerHeight.current = height;
        spacerHeight.set(height);
        return true;
    }, [spacerHeight]);
    /**
     * Re-measures the spacer and, while the list follows, returns to the end on the next frame.
     */
    const pin = useCallback((): void => {
        measureSpacer();
        follower.request();
    }, [follower, measureSpacer]);
    /**
     * A row that grows on a short Conversation (an unfolded delegated task) never changes the content size:
     * `startRenderingFromBottom`'s top margin shrinks by the same amount, so `onContentSizeChange` stays silent and the
     * rows slid up under the header. Every layout commit re-measures the spacer instead.
     */
    const onCommitLayout = useCallback((): void => {
        if (measureSpacer()) follower.request();
    }, [follower, measureSpacer]);
    const onScroll = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
            // Initial positioning passes through offsets far from the end; they are not the reader's scroll.
            if (!isPositionedReference.current) return;
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            const distance = contentSize.height - layoutMeasurement.height - contentOffset.y;
            const isNearEnd = isConversationFollowing(
                distance,
                layoutMeasurement.height,
                Date.now(),
                followHoldUntil.current,
            );
            setIsAtBottom(follower.recordScroll(isNearEnd));
        },
        [follower],
    );
    const onScrollBeginDrag = useCallback((): void => {
        followHoldUntil.current = 0;
        follower.beginDrag();
    }, [follower]);
    /**
     * A viewport that shrinks under a docked card or the keyboard moves the end, and so does one that grows back; both
     * also change how much room the latest turn has.
     */
    const onViewportLayout = useCallback(
        (event: LayoutChangeEvent): void => {
            const { height } = event.nativeEvent.layout;
            if (height === viewportHeight.current) return;
            viewportHeight.current = height;
            pin();
        },
        [pin],
    );
    const onLoad = useCallback((): void => {
        const reveal = (): void => {
            isPositionedReference.current = true;
            revealProgress.set(
                enterFrom === null ? 1 : withTiming(1, { duration: PANEL_ENTER_MS }),
            );
        };
        measureSpacer();
        /**
         * FlashList resolves `scrollToEnd` before its native scroll, which it defers by one task; reveal one frame
         * after that task has run.
         */
        // eslint-disable-next-line no-void -- Reveal failures leave a readable list; there is nothing to report.
        void Promise.resolve(list.current?.scrollToEnd({ animated: false })).finally(() => {
            setTimeout(() => requestAnimationFrame(reveal), 0);
        });
    }, [enterFrom, measureSpacer, revealProgress]);
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<Entry>) => (
            <View style={styles.entry}>{renderEntry(item)}</View>
        ),
        [renderEntry],
    );
    const jumpToLatest = useCallback((): void => {
        follower.follow();
        setIsAtBottom(true);
        measureSpacer();
        list.current?.scrollToEnd({ animated: true });
    }, [follower, measureSpacer]);
    const lastFollowKey = useRef(followKey);
    useEffect(() => {
        const previous = lastFollowKey.current;
        lastFollowKey.current = followKey;
        if (!isNewConversationSend(previous, followKey)) return;
        followConversationToLatest({
            follow: () => {
                followHoldUntil.current = Date.now() + CONVERSATION_SEND_FOLLOW_HOLD_MS;
            },
            nextFrame: requestAnimationFrame,
            scrollToEnd: jumpToLatest,
        });
    }, [followKey, jumpToLatest]);
    const onLoadOlder = useCallback((): void => {
        // eslint-disable-next-line no-void -- The timeline hook owns the bounded page request.
        void latest.current.timeline.loadOlder();
    }, []);
    const onStartReached = useCallback((): void => {
        const { timeline: current } = latest.current;
        if (isPositionedReference.current && current.olderCursor && !current.isLoadingOlder) {
            // eslint-disable-next-line no-void -- The timeline hook serializes older-page reads.
            void current.loadOlder();
        }
    }, []);
    const header = useMemo(
        () => (
            <ConversationHistory
                error={timeline.error}
                historyExpired={timeline.historyExpired}
                isLoadingOlder={timeline.isLoadingOlder}
                onLoadOlder={onLoadOlder}
                olderCursor={timeline.olderCursor}
                theme={theme}
                truncated={timeline.truncated}
            />
        ),
        [
            onLoadOlder,
            theme,
            timeline.error,
            timeline.historyExpired,
            timeline.isLoadingOlder,
            timeline.olderCursor,
            timeline.truncated,
        ],
    );
    const hasTurnSpacer = isTurnStart !== undefined;
    const footer = useMemo(
        () => (hasTurnSpacer ? <ConversationTurnSpacer height={spacerHeight} /> : null),
        [hasTurnSpacer, spacerHeight],
    );
    return (
        <View style={styles.root} testID="conversation-view">
            {/*
             * Notices sit above the timeline, as on a Chat. Offline, the app-wide Reconnecting banner already explains
             * a stale Conversation, so this one appears only when the connection is up but the read failed.
             */}
            <SavedCopyNote savedAt={timeline.savedAt} testID="conversation-saved" theme={theme} />
            {isConnected && timeline.status === 'stale' ? (
                <NoticeBanner
                    actionLabel={t('common.retry')}
                    message={t('conversation.staleNotice')}
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
                    keyExtractor={conversationEntryKey}
                    ListFooterComponent={footer}
                    ListHeaderComponent={header}
                    maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
                    onCommitLayoutEffect={onCommitLayout}
                    onContentSizeChange={pin}
                    onLoad={onLoad}
                    onMomentumScrollBegin={follower.beginMomentum}
                    onMomentumScrollEnd={follower.endMomentum}
                    onScroll={onScroll}
                    onScrollBeginDrag={onScrollBeginDrag}
                    onScrollEndDrag={follower.endDrag}
                    onStartReached={onStartReached}
                    onStartReachedThreshold={0.25}
                    ref={list}
                    renderItem={renderItem}
                    scrollEventThrottle={32}
                    style={styles.list}
                />
            </Animated.View>
            {shouldShowConversationJump(isAtBottom, entries.length > 0) ? (
                <Pressable
                    accessibilityLabel={t('conversation.jumpToLatest')}
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
    const { t } = useTranslation();
    const entries = useMemo(() => groupConversationItems(timeline.items, t), [timeline.items, t]);
    const renderEntry = useCallback(
        (entry: GroupedEntry) => <ConversationEntry entry={entry} theme={theme} />,
        [theme],
    );
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
            entries={entries}
            enterFrom={enterFrom}
            isConnected={isConnected}
            onRetry={onRetry}
            renderEntry={renderEntry}
            theme={theme}
            timeline={timeline}
        />
    );
};
