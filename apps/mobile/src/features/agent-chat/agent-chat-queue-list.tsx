/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useCallback, useRef, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import {
    ChevronDown,
    ChevronUp,
    CornerDownLeft,
    Image as ImageIcon,
    Pause,
    Pencil,
    Play,
    Trash2,
} from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatQueueHeader, AgentChatQueueRow } from './agent-chat-queue';
import { agentChatQueueCardLayout, agentChatQueueRowHints } from './agent-chat-queue';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatQueueActions } from './use-agent-chat-queue-actions';
import { useIsKeyboardShown } from './use-keyboard-shown';

const MONOSPACE = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const STEER_HIT_SLOP = { bottom: 8, left: 8, right: 4, top: 8 } as const;
const DELETE_ACTION_WIDTH = 84;
const DELETE_LABEL = 'Delete queued message';

/**
 * About four rows; a longer queue scrolls inside the card so the Chat above keeps its room.
 */
const QUEUE_MAX_HEIGHT = 216;

/**
 * The card's one-line summary (`Queued 3`), with Resume after a Stop and, while the user types, the toggle that shows
 * or hides the rows (`agentChatQueueCardLayout`).
 */
const QueueHeader = ({
    canAct,
    header,
    isExpanded,
    isResuming,
    onResume,
    onToggle,
    showsToggle,
    theme,
}: {
    canAct: boolean;
    header: AgentChatQueueHeader;
    isExpanded: boolean;
    isResuming: boolean;
    onResume: () => void;
    onToggle: () => void;
    showsToggle: boolean;
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
        {showsToggle ? (
            <IconButton
                accessibilityLabel={isExpanded ? 'Hide queued messages' : 'Show queued messages'}
                color={theme.muted}
                expanded={isExpanded}
                icon={isExpanded ? ChevronDown : ChevronUp}
                onPress={onToggle}
                size={18}
                testID="agent-chat-queue-toggle"
                theme={theme}
            />
        ) : null}
    </View>
);

/**
 * Desktop's reason a message with images has no Edit, shown when the disabled button is tapped.
 */
const IMAGES_UNSUPPORTED = 'Messages with images cannot be edited';

/**
 * A queued row's Send now (or Steer) and Edit buttons, for a device that may act on the queue. Delete lives in the
 * row's swipe and its screen reader action, leaving the preview room to read.
 */
const QueueRowActions = ({
    canSendNow,
    entry,
    isPending,
    onEdit,
    onSendNow,
    theme,
}: {
    canSendNow: boolean;
    entry: AgentChatQueueRow;
    isPending: boolean;
    onEdit: (id: string) => Promise<boolean>;
    onSendNow: (id: string) => Promise<boolean>;
    theme: MobileTheme;
}) => {
    const isSteer = entry.sendNowLabel === 'Steer';
    const hints = agentChatQueueRowHints(entry, IMAGES_UNSUPPORTED);
    return (
        <>
            <Pressable
                accessibilityHint={hints.sendNow}
                accessibilityLabel={isSteer ? 'Steer now' : 'Send now'}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSendNow }}
                disabled={!canSendNow}
                // 32dp pill plus 8dp above and below is the 48dp target; the 52dp row holds the slop, which Android
                // clips to the parent's bounds.
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
                <CornerDownLeft color={theme.primaryForeground} size={14} strokeWidth={2.5} />
                <Text style={[styles.steerText, { color: theme.primaryForeground }]}>
                    {entry.sendNowLabel}
                </Text>
            </Pressable>
            <IconButton
                accessibilityHint={hints.edit}
                accessibilityLabel="Edit queued message"
                color={theme.muted}
                disabled={isPending || !entry.canEdit}
                icon={Pencil}
                onDisabledPress={
                    isPending
                        ? undefined
                        : () => Alert.alert("This message can't be edited", IMAGES_UNSUPPORTED)
                }
                onPress={() => {
                    // eslint-disable-next-line no-void -- The queue card reports a failed edit itself.
                    void onEdit(entry.id);
                }}
                size={18}
                testID="agent-chat-queue-edit"
                theme={theme}
            />
        </>
    );
};

/**
 * One queued follow-up: up to two lines of preview, its command and image count, then Steer (or Send now) and Edit.
 * Swiping the row left reveals Delete, like a chat list's row action, and only a tap on it deletes, so a stray swipe
 * never loses a message. The screen reader reaches the same Delete as an action on the row.
 */
const QueueRow = ({
    canAct: canActOnQueue,
    entry,
    onEdit,
    onRemove,
    onSendNow,
    theme,
}: {
    canAct: boolean;
    entry: AgentChatQueueRow;
    onEdit: (id: string) => Promise<boolean>;
    onRemove: (id: string) => Promise<boolean>;
    onSendNow: (id: string) => Promise<boolean>;
    theme: MobileTheme;
}) => {
    const swipeableReference = useRef<SwipeableMethods>(null);
    const remove = useCallback(async (): Promise<void> => {
        // A failed delete brings the row back with the card's error; close it so the row reads normally again.
        if (!(await onRemove(entry.id))) swipeableReference.current?.close();
    }, [entry.id, onRemove]);
    const renderRightActions = useCallback(
        () => (
            <Pressable
                accessibilityLabel={DELETE_LABEL}
                accessibilityRole="button"
                onPress={remove}
                style={({ pressed }) => [
                    styles.swipeAction,
                    { backgroundColor: theme.danger, opacity: pressed ? 0.8 : 1 },
                ]}
                testID="agent-chat-queue-delete"
            >
                <Trash2 color={theme.primaryForeground} size={20} strokeWidth={2.25} />
                <Text style={[styles.swipeActionText, { color: theme.primaryForeground }]}>
                    Delete
                </Text>
            </Pressable>
        ),
        [remove, theme],
    );
    const isPending = entry.isPending === true;
    // A message still on its way holds every action until Server Core lists it, as on Desktop.
    const canAct = canActOnQueue && !isPending;
    const canSendNow = canAct && entry.canSendNow;
    return (
        <ReanimatedSwipeable
            childrenContainerStyle={{ backgroundColor: theme.surface }}
            enabled={canAct}
            friction={1.5}
            overshootRight={false}
            ref={swipeableReference}
            renderRightActions={renderRightActions}
            rightThreshold={DELETE_ACTION_WIDTH / 2}
        >
            <View
                accessibilityState={{ busy: isPending }}
                style={[styles.row, isPending && styles.pending]}
                testID={isPending ? 'agent-chat-queue-item-pending' : 'agent-chat-queue-item'}
            >
                <View
                    accessibilityActions={canAct ? [{ name: 'delete', label: DELETE_LABEL }] : []}
                    accessible
                    onAccessibilityAction={({ nativeEvent }) => {
                        // eslint-disable-next-line no-void -- The queue card reports a failed delete itself.
                        if (nativeEvent.actionName === 'delete') void remove();
                    }}
                    style={styles.rowText}
                >
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
                    {isPending ? (
                        <Text style={[styles.imagesText, { color: theme.muted }]}>Sending…</Text>
                    ) : null}
                </View>
                {canActOnQueue ? (
                    <QueueRowActions
                        canSendNow={canSendNow}
                        entry={entry}
                        isPending={isPending}
                        onEdit={onEdit}
                        onSendNow={onSendNow}
                        theme={theme}
                    />
                ) : null}
            </View>
        </ReanimatedSwipeable>
    );
};

/**
 * The follow-up messages waiting for the running turn, as one card docked above the composer, like Desktop's queue.
 * Each can be sent now (steering the running turn), edited, or deleted; after Stop the queue pauses, and the header
 * offers Resume. Edit takes the message out of the queue and hands its full text to `onEdit`, the composer draft. A
 * device that cannot send sees the card without actions.
 */
export const AgentChatQueueList = ({
    canAct,
    chat,
    onEdit,
    theme,
}: {
    /**
     * Whether this device may send to the Chat right now; the queue actions need the same access.
     */
    canAct: boolean;
    chat: AgentChatController;
    onEdit: (text: string) => void;
    theme: MobileTheme;
}) => {
    const { edit, entries, error, header, isResuming, remove, resume, sendNow } =
        useAgentChatQueueActions(chat, onEdit);
    const isComposing = useIsKeyboardShown();
    const [isExpanded, setExpanded] = useState(false);
    // Each time the keyboard goes down the card is whole again, so the next time the user types it starts collapsed.
    // Reset during render: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
    if (!isComposing && isExpanded) setExpanded(false);
    const layout = agentChatQueueCardLayout({ isComposing, isExpanded });
    const renderRow = useCallback(
        ({ item }: ListRenderItemInfo<AgentChatQueueRow>) => (
            <QueueRow
                canAct={canAct}
                entry={item}
                onEdit={edit}
                onRemove={remove}
                onSendNow={sendNow}
                theme={theme}
            />
        ),
        [canAct, edit, remove, sendNow, theme],
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
                isExpanded={isExpanded}
                isResuming={isResuming}
                onResume={() => {
                    // eslint-disable-next-line no-void -- The queue card reports a failed resume itself.
                    void resume();
                }}
                onToggle={() => setExpanded((current) => !current)}
                showsToggle={layout.showsToggle}
                theme={theme}
            />
            {/*
             * The phone's queue preview holds at most `MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS` rows, so FlatList's default
             * first batch renders them all; it is a list for the row contract, not for virtualization.
             */}
            <FlatList
                data={layout.showsRows ? entries : []}
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
    // Shrinks before the timeline does when the keyboard leaves little room (`AgentChatView`'s body keeps a minimum).
    card: {
        borderRadius: 14,
        borderWidth: 1,
        flexShrink: 1,
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
    list: { flexGrow: 0, flexShrink: 1, maxHeight: QUEUE_MAX_HEIGHT },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minHeight: 52,
        paddingLeft: 12,
        paddingVertical: 4,
    },
    rowText: { flex: 1, gap: 2, minWidth: 0 },
    pending: { opacity: 0.6 },
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
    swipeAction: {
        alignItems: 'center',
        gap: 4,
        justifyContent: 'center',
        width: DELETE_ACTION_WIDTH,
    },
    swipeActionText: { fontSize: 13, fontWeight: '700' },
    error: { fontSize: 13, paddingBottom: 8, paddingHorizontal: 12 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
