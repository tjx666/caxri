/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
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

import { Card } from '../../components/card';
import { IconButton } from '../../components/icon-button';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileSpace, mobileType, PRESSED_OPACITY } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatQueueHeader, AgentChatQueueRow } from './agent-chat-queue';
import {
    agentChatQueueCardLayout,
    agentChatQueueRowHints,
    agentChatQueueSendNowText,
} from './agent-chat-queue';
import { AgentChatQueueEditor } from './agent-chat-queue-editor';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatQueueActions } from './use-agent-chat-queue-actions';
import { useIsKeyboardShown } from './use-keyboard-shown';

const STEER_HIT_SLOP = { bottom: 8, left: 8, right: 4, top: 8 } as const;
const DELETE_ACTION_WIDTH = 84;

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
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.header}>
            {header.isPaused ? <Pause color={theme.warning} size={14} strokeWidth={2.25} /> : null}
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                {header.title}
            </Text>
            <View style={[styles.count, { backgroundColor: theme.elevated }]}>
                <Text
                    accessibilityLabel={t('chat.queue.countLabel', { count: header.count })}
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
                    accessibilityLabel={t('chat.queue.resumeLabel')}
                    accessibilityRole="button"
                    accessibilityState={{ busy: isResuming, disabled: isResuming }}
                    disabled={isResuming}
                    onPress={onResume}
                    style={({ pressed }) => [
                        styles.resume,
                        { opacity: pressed ? PRESSED_OPACITY : 1 },
                    ]}
                    testID="agent-chat-queue-resume"
                >
                    {isResuming ? (
                        <Spinner color={theme.primary} />
                    ) : (
                        <Play color={theme.primary} size={14} strokeWidth={2.5} />
                    )}
                    <Text style={[styles.resumeText, { color: theme.primary }]}>
                        {t('chat.queue.resume')}
                    </Text>
                </Pressable>
            ) : null}
            {showsToggle ? (
                <IconButton
                    accessibilityLabel={t(
                        isExpanded ? 'chat.queue.hideRows' : 'chat.queue.showRows',
                    )}
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
};

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
    const { t } = useTranslation();
    const isSteer = entry.sendNowLabel === 'Steer';
    const hints = agentChatQueueRowHints(entry, t);
    return (
        <>
            <Pressable
                accessibilityHint={hints.sendNow}
                accessibilityLabel={t(isSteer ? 'chat.queue.steerNow' : 'chat.queue.sendNow')}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSendNow }}
                disabled={!canSendNow}
                // 32dp pill plus 8dp above and below is the 48dp target; the 52dp row holds the slop, which Android
                // clips to the parent's bounds.
                hitSlop={STEER_HIT_SLOP}
                onPress={() => {
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
                    {agentChatQueueSendNowText(entry, t)}
                </Text>
            </Pressable>
            <IconButton
                accessibilityHint={hints.edit}
                accessibilityLabel={t('chat.queue.editMessage')}
                color={theme.muted}
                disabled={isPending}
                icon={Pencil}
                onPress={() => {
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
    editor,
    entry,
    onEdit,
    onRemove,
    onSendNow,
    theme,
}: {
    canAct: boolean;
    /**
     * The in-place editor that replaces the row while its message is being edited.
     */
    editor: ReactNode;
    entry: AgentChatQueueRow;
    onEdit: (id: string) => Promise<boolean>;
    onRemove: (id: string) => Promise<boolean>;
    onSendNow: (id: string) => Promise<boolean>;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const deleteLabel = t('chat.queue.deleteMessage');
    const swipeableReference = useRef<SwipeableMethods>(null);
    const remove = useCallback(async (): Promise<void> => {
        // A failed delete brings the row back with the card's error; close it so the row reads normally again.
        if (!(await onRemove(entry.id))) swipeableReference.current?.close();
    }, [entry.id, onRemove]);
    const renderRightActions = useCallback(
        () => (
            <Pressable
                accessibilityLabel={deleteLabel}
                accessibilityRole="button"
                onPress={remove}
                style={({ pressed }) => [
                    styles.swipeAction,
                    { backgroundColor: theme.danger, opacity: pressed ? PRESSED_OPACITY : 1 },
                ]}
                testID="agent-chat-queue-delete"
            >
                <Trash2 color={theme.dangerForeground} size={20} strokeWidth={2.25} />
                <Text style={[styles.swipeActionText, { color: theme.dangerForeground }]}>
                    {t('chat.queue.delete')}
                </Text>
            </Pressable>
        ),
        [deleteLabel, remove, t, theme],
    );
    if (editor) return <>{editor}</>;
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
                    accessibilityActions={canAct ? [{ name: 'delete', label: deleteLabel }] : []}
                    accessible
                    onAccessibilityAction={({ nativeEvent }) => {
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
                        <Text style={[styles.imagesText, { color: theme.muted }]}>
                            {t('chat.sending')}
                        </Text>
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
 * offers Resume. Edit takes a plain message out of the queue and hands its full text to `onEdit`, the composer draft; a
 * message with images or references is edited in place instead. A device that cannot send sees the card without
 * actions.
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
    const {
        cancelEdit,
        edit,
        editing,
        entries,
        error,
        header,
        isResuming,
        isSavingEdit,
        notice,
        remove,
        resume,
        saveEdit,
        sendNow,
    } = useAgentChatQueueActions(chat, onEdit);
    const { t } = useTranslation();
    const isComposing = useIsKeyboardShown();
    const [isExpanded, setExpanded] = useState(false);
    // Each time the keyboard goes down the card is whole again, so the next time the user types it starts collapsed.
    // Reset during render: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
    if (!isComposing && isExpanded) setExpanded(false);
    const layout = agentChatQueueCardLayout({
        isComposing,
        isEditing: editing !== null,
        isExpanded,
    });
    const renderRow = useCallback(
        ({ item }: ListRenderItemInfo<AgentChatQueueRow>) => (
            <QueueRow
                canAct={canAct}
                editor={
                    editing?.id === item.id ? (
                        <AgentChatQueueEditor
                            editing={editing}
                            isSaving={isSavingEdit}
                            onCancel={cancelEdit}
                            onSave={(text) => {
                                void saveEdit(text);
                            }}
                            theme={theme}
                        />
                    ) : null
                }
                entry={item}
                onEdit={edit}
                onRemove={remove}
                onSendNow={sendNow}
                theme={theme}
            />
        ),
        [canAct, cancelEdit, edit, editing, isSavingEdit, remove, saveEdit, sendNow, theme],
    );
    const noticeLine = notice ? (
        <Text
            accessibilityRole="alert"
            style={[styles.error, { color: theme.danger }]}
            testID="agent-chat-queue-notice"
        >
            {notice}
        </Text>
    ) : null;
    // A message that left the queue before Edit reached it may have emptied the queue; its notice then stands alone.
    if (!header)
        return noticeLine ? (
            <Card padded={false} style={styles.card} theme={theme}>
                {noticeLine}
            </Card>
        ) : null;
    return (
        <Card
            accessibilityLabel={t('chat.queue.label')}
            padded={false}
            style={styles.card}
            testID="agent-chat-queue"
            theme={theme}
        >
            <QueueHeader
                canAct={canAct}
                header={header}
                isExpanded={isExpanded}
                isResuming={isResuming}
                onResume={() => {
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
            {noticeLine}
        </Card>
    );
};

const styles = StyleSheet.create({
    // Shrinks before the timeline does when the keyboard leaves little room (`AgentChatView`'s body keeps a minimum).
    card: {
        flexShrink: 1,
        marginBottom: mobileSpace.sm,
        marginHorizontal: mobileSpace.md,
    },
    header: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        minHeight: 36,
        paddingLeft: 12,
        paddingRight: 4,
    },
    title: { ...mobileType.meta, fontWeight: '700' },
    count: { borderRadius: 8, minWidth: 20, paddingHorizontal: 6, paddingVertical: 1 },
    countText: { ...mobileType.caption, fontWeight: '700', textAlign: 'center' },
    detail: { ...mobileType.caption, flex: 1 },
    // A full 48dp box rather than hit slop: the header is shorter than 48dp, and Android clips slop to the parent.
    resume: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
        minHeight: 48,
        paddingHorizontal: 8,
    },
    resumeText: { ...mobileType.meta, fontWeight: '700' },
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
    preview: { ...mobileType.body },
    command: { ...mobileType.meta, fontFamily: MONOSPACE_FONT },
    images: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    imagesText: { ...mobileType.caption },
    steer: {
        alignItems: 'center',
        borderRadius: 16,
        flexDirection: 'row',
        gap: 4,
        height: 32,
        marginLeft: 4,
        paddingHorizontal: 12,
    },
    steerText: { ...mobileType.meta, fontWeight: '700' },
    swipeAction: {
        alignItems: 'center',
        gap: 4,
        justifyContent: 'center',
        width: DELETE_ACTION_WIDTH,
    },
    swipeActionText: { ...mobileType.meta, fontWeight: '700' },
    error: { ...mobileType.meta, paddingBottom: mobileSpace.sm, paddingHorizontal: mobileSpace.md },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
