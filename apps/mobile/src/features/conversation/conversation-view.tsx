import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Platform, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import type { FlashListRef, ListRenderItemInfo } from '@shopify/flash-list';
import { FlashList } from '@shopify/flash-list';

import { Button } from '../../components/button';
import { NoticeBanner } from '../../components/notice-banner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { SavedCopyNote } from '../read-cache/saved-copy-note';
import { ConversationDisclosure } from './conversation-disclosure';
import { ConversationEntry } from './conversation-entry';
import { ConversationJumpLatest } from './conversation-jump-latest';
import type { ConversationMessageTarget } from './conversation-message-actions';
import { ConversationMessageActions } from './conversation-message-actions';
import { ConversationMessageSheet } from './conversation-message-sheet';
import type { ConversationEntry as GroupedEntry } from './conversation-model';
import {
    CONVERSATION_SEND_FOLLOW_HOLD_MS,
    followConversationToLatest,
    groupConversationItems,
    isConversationFollowing,
    isNewConversationSend,
    shouldShowConversationJump,
} from './conversation-model';
import { createConversationFollower } from './conversation-scroll';
import { conversationStyles as styles } from './conversation-styles';
import { isTimelineMessageClipped, MessageReadOfflineError } from './read-whole-message';
import { useConversationOlderPages } from './use-conversation-older-pages';
import { useConversationOpening } from './use-conversation-opening';
import type {
    ConversationPagedTimeline,
    ConversationTimelineState,
} from './use-conversation-timeline';
import { useConversationTurnSpacer } from './use-conversation-turn-spacer';

const ConversationHistory = ({
    error,
    historyExpired,
    isLoadingOlder,
    needsConnection,
    onLoadOlder,
    olderCursor,
    theme,
    truncated,
}: {
    error: string | null;
    historyExpired: boolean;
    isLoadingOlder: boolean;
    needsConnection: boolean;
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
                <Button
                    isBusy={isLoadingOlder}
                    label={t(
                        isLoadingOlder ? 'conversation.loadingEarlier' : 'conversation.loadEarlier',
                    )}
                    onPress={onLoadOlder}
                    style={styles.stateButton}
                    testID="conversation-load-earlier"
                    theme={theme}
                    variant="secondary"
                />
            ) : null}
            {needsConnection ? (
                <Text
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-offline"
                >
                    {t('conversation.connectToLoadEarlier')}
                </Text>
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
                <Button
                    label={t('common.retry')}
                    onPress={onRetry}
                    style={styles.stateButton}
                    testID="conversation-retry"
                    theme={theme}
                    variant="secondary"
                />
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

/**
 * A list with a turn spacer opens at its end through `initialScrollIndex` instead. `startRenderingFromBottom` also
 * pushes rows shorter than the viewport down with a top margin, and FlashList resizes that margin a render after a row
 * or the viewport changes, while the spacer and the scroll catch up in other frames: each new line of a streamed reply
 * on a short Chat lifted the turn by a line for a frame, and the keyboard opening or closing bounced it the same way.
 */
const MAINTAIN_TURN_POSITION = {} as const;

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
 * The list opens hidden and reveals itself at its settled end (`useConversationOpening`).
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
    timeline: ConversationPagedTimeline;
}) => {
    const { t } = useTranslation();
    const list = useRef<FlashListRef<Entry>>(null);
    const [isAtBottom, setIsAtBottomState] = useState(true);
    const setIsAtBottom = useCallback(
        (isFollowing: boolean): void => {
            setIsAtBottomState(isFollowing);
            onFollowingChange?.(isFollowing);
        },
        [onFollowingChange],
    );
    const hasTurnSpacer = isTurnStart !== undefined;
    const [initialScrollIndex] = useState(() =>
        hasTurnSpacer && entries.length > 0 ? entries.length - 1 : undefined,
    );
    const viewportHeight = useRef(0);
    /**
     * The tallest the viewport has been, as before the keyboard opened. The spacer is sized for it (`measureSpacer`),
     * so the content never has to grow back when the keyboard closes.
     */
    const largestViewportHeight = useRef(0);
    const isPositionedReference = useRef(false);
    const followHoldUntil = useRef(0);
    const [follower] = useState(() =>
        createConversationFollower({ nextFrame: requestAnimationFrame }),
    );
    /**
     * The latest props the layout callbacks read, so those callbacks (and the list props built from them) stay stable.
     */
    const latest = useRef({ entries, isTurnStart, timeline });
    useLayoutEffect(() => {
        latest.current = { entries, isTurnStart, timeline };
    });
    const {
        endSpacerHeight,
        markRevealed,
        measureSpacer,
        scrollToLatest,
        spacerHeight,
        spacerReserve,
    } = useConversationTurnSpacer({
        bottomInset: CONTENT_BOTTOM_INSET,
        isBottomAligned: !hasTurnSpacer,
        largestViewportHeight,
        latest,
        list,
        viewportHeight,
    });
    useEffect(() => follower.connect(() => scrollToLatest(false)), [follower, scrollToLatest]);
    /**
     * Re-measures the spacer and, while the list follows, returns to the end on the next frame.
     */
    const pin = useCallback((): void => {
        measureSpacer();
        follower.request();
    }, [follower, measureSpacer]);
    const {
        fillWithOlder,
        isShort,
        loadOlder: onLoadOlder,
        onStartReached,
    } = useConversationOlderPages({
        isFollowing: () => follower.isFollowing,
        isPositionedReference,
        list,
        timeline: latest,
        viewportHeight,
    });
    const { onLayoutCommitted, onLoad, revealStyle } = useConversationOpening({
        enterFrom,
        fillWithOlder,
        isPositionedReference,
        isShort,
        list,
        measureSpacer,
        onReveal: markRevealed,
    });
    /**
     * A row that grows (an unfolded delegated task) need not change the native content size: the spacer, or a short
     * list's `startRenderingFromBottom` margin, absorbs it, so `onContentSizeChange` stays silent and the rows slid up
     * under the header. Every layout commit re-measures the spacer instead.
     *
     * The follower scrolls to the end FlashList has measured, which a native content size change can precede, so each
     * commit (a measured row grew, or the spacer changed) also follows the end.
     */
    const onCommitLayout = useCallback((): void => {
        pin();
        onLayoutCommitted();
    }, [onLayoutCommitted, pin]);
    const onScroll = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
            // Initial positioning passes through offsets far from the end; they are not the reader's scroll.
            if (!isPositionedReference.current) return;
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            // The spacer drawn for the largest viewport runs past the end while the keyboard is up.
            const distance =
                contentSize.height - layoutMeasurement.height - contentOffset.y - spacerReserve();
            const isNearEnd = isConversationFollowing(
                distance,
                layoutMeasurement.height,
                Date.now(),
                followHoldUntil.current,
            );
            setIsAtBottom(follower.recordScroll(isNearEnd));
        },
        [follower, setIsAtBottom, spacerReserve],
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
            largestViewportHeight.current = Math.max(largestViewportHeight.current, height);
            pin();
        },
        [pin],
    );
    const renderItem = useCallback(
        ({ item }: ListRenderItemInfo<Entry>) => (
            <View style={styles.entry}>{renderEntry(item)}</View>
        ),
        [renderEntry],
    );
    /**
     * The reader opened or closed a row. While the latest turn's spacer still has room the row grows into it and the
     * end does not move, so the list keeps following; once the turn fills the viewport, following on would slide the
     * tapped row away, so the list holds its place and offers Jump to latest instead (`ConversationDisclosure`).
     */
    const holdForDisclosure = useCallback((): void => {
        if (endSpacerHeight() > 0 || !follower.isFollowing) return;
        follower.hold();
        setIsAtBottom(false);
    }, [endSpacerHeight, follower, setIsAtBottom]);
    const jumpToLatest = useCallback((): void => {
        follower.follow();
        setIsAtBottom(true);
        measureSpacer();
        scrollToLatest(true);
    }, [follower, measureSpacer, scrollToLatest, setIsAtBottom]);
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
    const header = useMemo(
        () => (
            <ConversationHistory
                error={timeline.error}
                historyExpired={timeline.historyExpired}
                isLoadingOlder={timeline.isLoadingOlder}
                needsConnection={timeline.needsConnectionForOlder === true}
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
            timeline.needsConnectionForOlder,
            timeline.olderCursor,
            timeline.truncated,
        ],
    );
    const maintainPosition = hasTurnSpacer
        ? MAINTAIN_TURN_POSITION
        : MAINTAIN_VISIBLE_CONTENT_POSITION;
    const footer = useMemo(
        () => (hasTurnSpacer ? <ConversationTurnSpacer height={spacerHeight} /> : null),
        [hasTurnSpacer, spacerHeight],
    );
    return (
        <ConversationDisclosure value={holdForDisclosure}>
            <View style={styles.root} testID="conversation-view">
                {/*
                 * Notices sit above the timeline, as on a Chat. Offline, the app-wide Reconnecting banner already explains
                 * a stale Conversation, so this one appears only when the connection is up but the read failed.
                 */}
                <SavedCopyNote
                    savedAt={timeline.savedAt}
                    testID="conversation-saved"
                    theme={theme}
                />
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
                         * Dragging the timeline dismisses the composer keyboard (following the finger on iOS), and a
                         * tap on a row's button lands on the first touch instead of only closing the keyboard.
                         */
                        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                        keyboardShouldPersistTaps="handled"
                        keyExtractor={conversationEntryKey}
                        ListFooterComponent={footer}
                        ListHeaderComponent={header}
                        initialScrollIndex={initialScrollIndex}
                        maintainVisibleContentPosition={maintainPosition}
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
                    <ConversationJumpLatest onPress={jumpToLatest} theme={theme} />
                ) : null}
            </View>
        </ConversationDisclosure>
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
    timeline: ConversationPagedTimeline;
}) => {
    const { t } = useTranslation();
    const entries = useMemo(() => groupConversationItems(timeline.items, t), [timeline.items, t]);
    const renderEntry = useCallback(
        (entry: GroupedEntry) => <ConversationEntry entry={entry} theme={theme} />,
        [theme],
    );
    const [actionTarget, setActionTarget] = useState<ConversationMessageTarget>();
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
    /**
     * A terminal Agent's message the timeline cut short is read whole from the computer; there is no edit behind them.
     */
    const readActionText = async (target: ConversationMessageTarget): Promise<string> => {
        if (!isTimelineMessageClipped(target.text) || !timeline.readMessage) return target.text;
        if (!isConnected) throw new MessageReadOfflineError();
        return timeline.readMessage(target.id);
    };
    return (
        <ConversationMessageActions value={setActionTarget}>
            <ConversationList
                entries={entries}
                enterFrom={enterFrom}
                isConnected={isConnected}
                onRetry={onRetry}
                renderEntry={renderEntry}
                theme={theme}
                timeline={timeline}
            />
            {actionTarget ? (
                <ConversationMessageSheet
                    onClose={() => setActionTarget(undefined)}
                    readText={() => readActionText(actionTarget)}
                    theme={theme}
                />
            ) : null}
        </ConversationMessageActions>
    );
};
