/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import {
    ActivityIndicator,
    FlatList,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import type { AgentChatQueueEntry } from '@caxri/protocol';
import { CornerDownLeft, Image as ImageIcon, Pause, Play, Trash2 } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatQueueHeader } from './agent-chat-queue';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatQueueActions } from './use-agent-chat-queue-actions';

const MONOSPACE = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const STEER_HIT_SLOP = { bottom: 8, left: 8, right: 4, top: 8 } as const;

/**
 * About four rows; a longer queue scrolls inside the card so the Chat above keeps its room.
 */
const QUEUE_MAX_HEIGHT = 216;

const QueueHeader = ({
    canAct,
    header,
    isResuming,
    onResume,
    theme,
}: {
    canAct: boolean;
    header: AgentChatQueueHeader;
    isResuming: boolean;
    onResume: () => void;
    theme: MobileTheme;
}) => (
    <View style={styles.header}>
        {header.isPaused ? <Pause color={theme.warning} size={14} strokeWidth={2.25} /> : null}
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
            {header.title}
        </Text>
        <View style={[styles.count, { backgroundColor: theme.elevated }]}>
            <Text
                accessibilityLabel={`${header.count} queued`}
                style={[styles.countText, { color: theme.muted }]}
                testID="agent-chat-queue-count"
            >
                {header.count}
            </Text>
        </View>
        <Text numberOfLines={1} style={[styles.detail, { color: theme.muted }]}>
            {header.detail ?? ''}
        </Text>
        {canAct && header.isPaused ? (
            <Pressable
                accessibilityLabel="Resume queue"
                accessibilityRole="button"
                accessibilityState={{ busy: isResuming, disabled: isResuming }}
                disabled={isResuming}
                onPress={onResume}
                style={({ pressed }) => [styles.resume, { opacity: pressed ? 0.6 : 1 }]}
                testID="agent-chat-queue-resume"
            >
                {isResuming ? (
                    <ActivityIndicator color={theme.primary} size="small" />
                ) : (
                    <Play color={theme.primary} size={14} strokeWidth={2.5} />
                )}
                <Text style={[styles.resumeText, { color: theme.primary }]}>Resume</Text>
            </Pressable>
        ) : null}
    </View>
);

/**
 * One queued follow-up: up to two lines of preview, its command and image count, then Steer (or Send now) and Delete.
 * Swiping the row left deletes it too, like dismissing a message in a chat list; the Delete button stays for readers
 * who do not swipe and for the screen reader.
 */
const QueueRow = ({
    canAct,
    entry,
    onRemove,
    onSendNow,
    theme,
}: {
    canAct: boolean;
    entry: AgentChatQueueEntry;
    onRemove: (id: string) => Promise<boolean>;
    onSendNow: (id: string) => Promise<boolean>;
    theme: MobileTheme;
}) => {
    const remove = useCallback((): void => {
        // eslint-disable-next-line no-void -- The queue card reports a failed delete itself.
        void onRemove(entry.id);
    }, [entry.id, onRemove]);
    const renderRightActions = useCallback(
        () => (
            <View style={[styles.swipeAction, { backgroundColor: theme.danger }]}>
                <Trash2 color={theme.primaryForeground} size={20} strokeWidth={2.25} />
            </View>
        ),
        [theme],
    );
    const isSteer = entry.sendNowLabel === 'Steer';
    const canSendNow = canAct && entry.canSendNow;
    return (
        <ReanimatedSwipeable
            childrenContainerStyle={{ backgroundColor: theme.surface }}
            enabled={canAct}
            friction={1.5}
            onSwipeableWillOpen={remove}
            overshootRight={false}
            renderRightActions={renderRightActions}
            rightThreshold={64}
        >
            <View style={styles.row} testID="agent-chat-queue-item">
                <View style={styles.rowText}>
                    <Text numberOfLines={2} style={[styles.preview, { color: theme.text }]}>
                        {entry.commandLabel ? (
                            <Text
                                style={[
                                    styles.command,
                                    { backgroundColor: theme.elevated, color: theme.text },
                                ]}
                            >
                                {` ${entry.commandLabel} `}
                            </Text>
                        ) : null}
                        {entry.commandLabel && entry.preview ? ' ' : ''}
                        {entry.preview}
                    </Text>
                    {entry.imageLabel ? (
                        <View style={styles.images}>
                            <ImageIcon color={theme.muted} size={12} strokeWidth={2.25} />
                            <Text style={[styles.imagesText, { color: theme.muted }]}>
                                {entry.imageLabel}
                            </Text>
                        </View>
                    ) : null}
                </View>
                {canAct ? (
                    <>
                        <Pressable
                            accessibilityHint={
                                entry.canSendNow
                                    ? isSteer
                                        ? 'Adds this message to the running turn now.'
                                        : undefined
                                    : 'A command waits for the running turn to end.'
                            }
                            accessibilityLabel={isSteer ? 'Steer now' : 'Send now'}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !canSendNow }}
                            disabled={!canSendNow}
                            // 32dp pill plus 8dp above and below is the 48dp target; the 52dp row holds the slop, which
                            // Android clips to the parent's bounds.
                            hitSlop={STEER_HIT_SLOP}
                            onPress={() => {
                                // eslint-disable-next-line no-void -- The queue card reports a failed send itself.
                                void onSendNow(entry.id);
                            }}
                            style={({ pressed }) => [
                                styles.steer,
                                {
                                    backgroundColor: theme.primary,
                                    opacity: canSendNow ? (pressed ? 0.7 : 1) : 0.38,
                                },
                            ]}
                            testID="agent-chat-queue-send-now"
                        >
                            <CornerDownLeft
                                color={theme.primaryForeground}
                                size={14}
                                strokeWidth={2.5}
                            />
                            <Text style={[styles.steerText, { color: theme.primaryForeground }]}>
                                {entry.sendNowLabel}
                            </Text>
                        </Pressable>
                        <IconButton
                            accessibilityLabel="Delete queued message"
                            color={theme.muted}
                            icon={Trash2}
                            onPress={remove}
                            size={18}
                            testID="agent-chat-queue-delete"
                            theme={theme}
                        />
                    </>
                ) : null}
            </View>
        </ReanimatedSwipeable>
    );
};

/**
 * The follow-up messages waiting for the running turn, as one card docked above the composer, like Desktop's queue.
 * Each can be deleted or sent now (steering the running turn); after Stop the queue pauses, and the header offers
 * Resume. Editing stays on the computer, since the phone holds only a preview. A device that cannot send sees the card
 * without actions.
 */
export const AgentChatQueueList = ({
    canAct,
    chat,
    theme,
}: {
    /**
     * Whether this device may send to the Chat right now; the queue actions need the same access.
     */
    canAct: boolean;
    chat: AgentChatController;
    theme: MobileTheme;
}) => {
    const { entries, error, header, isResuming, remove, resume, sendNow } =
        useAgentChatQueueActions(chat);
    const renderRow = useCallback(
        ({ item }: ListRenderItemInfo<AgentChatQueueEntry>) => (
            <QueueRow
                canAct={canAct}
                entry={item}
                onRemove={remove}
                onSendNow={sendNow}
                theme={theme}
            />
        ),
        [canAct, remove, sendNow, theme],
    );
    // An entry that failed to delete because it already left the queue leaves nothing to explain the error against.
    if (!header) return null;
    return (
        <View
            accessibilityLabel="Queued messages"
            style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-queue"
        >
            <QueueHeader
                canAct={canAct}
                header={header}
                isResuming={isResuming}
                onResume={() => {
                    // eslint-disable-next-line no-void -- The queue card reports a failed resume itself.
                    void resume();
                }}
                theme={theme}
            />
            {/*
             * The phone's queue preview holds at most `MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS` rows, so FlatList's default
             * first batch renders them all; it is a list for the row contract, not for virtualization.
             */}
            <FlatList
                data={entries}
                keyboardShouldPersistTaps="handled"
                keyExtractor={(entry) => entry.id}
                nestedScrollEnabled
                renderItem={renderRow}
                style={styles.list}
            />
            {error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.error, { color: theme.danger }]}
                    testID="agent-chat-queue-error"
                >
                    {error}
                </Text>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        borderRadius: 14,
        borderWidth: 1,
        marginBottom: 8,
        marginHorizontal: 12,
        overflow: 'hidden',
    },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        minHeight: 36,
        paddingLeft: 12,
        paddingRight: 4,
    },
    title: { fontSize: 13, fontWeight: '700' },
    count: { borderRadius: 8, minWidth: 20, paddingHorizontal: 6, paddingVertical: 1 },
    countText: { fontSize: 12, fontWeight: '700', textAlign: 'center' },
    detail: { flex: 1, fontSize: 12 },
    // A full 48dp box rather than hit slop: the header is shorter than 48dp, and Android clips slop to the parent.
    resume: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minHeight: 48,
        paddingHorizontal: 8,
    },
    resumeText: { fontSize: 13, fontWeight: '700' },
    list: { flexGrow: 0, maxHeight: QUEUE_MAX_HEIGHT },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minHeight: 52,
        paddingLeft: 12,
        paddingVertical: 4,
    },
    rowText: { flex: 1, gap: 2, minWidth: 0 },
    preview: { fontSize: 14, lineHeight: 19 },
    command: { fontFamily: MONOSPACE, fontSize: 13 },
    images: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    imagesText: { fontSize: 12 },
    steer: {
        alignItems: 'center',
        borderRadius: 16,
        flexDirection: 'row',
        gap: 4,
        height: 32,
        marginLeft: 4,
        paddingHorizontal: 12,
    },
    steerText: { fontSize: 13, fontWeight: '700' },
    swipeAction: { alignItems: 'center', justifyContent: 'center', width: 72 },
    error: { fontSize: 13, paddingBottom: 8, paddingHorizontal: 12 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
