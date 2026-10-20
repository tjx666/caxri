/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import { findAgentChatTask } from '@caxri/protocol';
import { ChevronLeft, ChevronUp, Layers } from 'lucide-react-native';

import { BottomSheet } from '../../components/bottom-sheet';
import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatTaskStopper } from './agent-chat-task-detail';
import {
    AgentChatTaskDetailBody,
    AgentChatTaskKindGlyph,
    AgentChatTaskStatusGlyph,
    AgentChatTaskStopButton,
} from './agent-chat-task-detail';
import { publishAgentChatTaskLinks, withdrawAgentChatTaskLinks } from './agent-chat-task-links';
import type { AgentChatTaskPill } from './agent-chat-tasks';
import { agentChatTaskPill, agentChatTaskRow } from './agent-chat-tasks';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatTaskClock, useAgentChatTaskStop } from './use-agent-chat-task-detail';

const MONOSPACE = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const TaskRow = ({
    canControl,
    now,
    onOpen,
    stopper,
    task,
    theme,
}: {
    canControl: boolean;
    now: number;
    onOpen: (taskId: string) => void;
    stopper: AgentChatTaskStopper;
    task: AgentChatTask;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const row = agentChatTaskRow(task, now, t);
    return (
        <View style={styles.row}>
            <Pressable
                accessibilityHint={t('chat.tasks.openHint')}
                accessibilityLabel={row.accessibilityLabel}
                accessibilityRole="button"
                onPress={() => onOpen(task.id)}
                style={({ pressed }) => [
                    styles.rowButton,
                    { backgroundColor: pressed ? theme.elevated : 'transparent' },
                ]}
                testID="agent-chat-task-row"
            >
                <AgentChatTaskKindGlyph kind={task.kind} theme={theme} />
                <View style={styles.rowText}>
                    <Text
                        numberOfLines={1}
                        style={[
                            row.isCommandTitle ? styles.rowCommand : styles.rowTitle,
                            { color: theme.text },
                        ]}
                    >
                        {row.title}
                    </Text>
                    {row.summary ? (
                        <Text numberOfLines={1} style={[styles.rowSummary, { color: theme.muted }]}>
                            {row.summary}
                        </Text>
                    ) : null}
                </View>
                {row.elapsed ? (
                    <Text style={[styles.rowElapsed, { color: theme.muted }]}>{row.elapsed}</Text>
                ) : null}
                <AgentChatTaskStatusGlyph status={task.status} theme={theme} />
            </Pressable>
            {canControl && row.canStop ? (
                <AgentChatTaskStopButton
                    stopper={stopper}
                    task={task}
                    theme={theme}
                    title={row.title}
                />
            ) : null}
        </View>
    );
};

const TaskList = ({
    canControl,
    onOpen,
    pill,
    stopper,
    theme,
}: {
    canControl: boolean;
    onOpen: (taskId: string) => void;
    pill: AgentChatTaskPill;
    stopper: AgentChatTaskStopper;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const now = useAgentChatTaskClock(pill.running.length > 0);
    const section = (title: string, tasks: AgentChatTask[]) =>
        tasks.length > 0 ? (
            <View>
                <Text accessibilityRole="header" style={[styles.section, { color: theme.muted }]}>
                    {title}
                </Text>
                {tasks.map((task) => (
                    <TaskRow
                        canControl={canControl}
                        key={task.id}
                        now={now}
                        onOpen={onOpen}
                        stopper={stopper}
                        task={task}
                        theme={theme}
                    />
                ))}
            </View>
        ) : null;
    return (
        // react-doctor-disable-next-line react-doctor/rn-no-scrollview-mapped-list -- The phone's task list holds at most a few dozen rows, bounded by `clipAgentChatTasksForMobile`.
        <ScrollView style={styles.list} testID="agent-chat-task-list">
            {section(t('chat.tasks.sectionRunning'), pill.running)}
            {section(t('chat.tasks.sectionEnded'), pill.ended)}
        </ScrollView>
    );
};

/**
 * The one-row pill counting background tasks while any runs; it opens the sheet.
 */
const TaskPill = ({
    onOpen,
    pill,
    theme,
}: {
    onOpen: () => void;
    pill: AgentChatTaskPill;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={[styles.pill, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Pressable
                accessibilityHint={t('chat.tasks.pillHint')}
                accessibilityLabel={t('chat.tasks.pillLabel', { label: pill.label })}
                accessibilityRole="button"
                onPress={onOpen}
                style={styles.pillButton}
                testID="agent-chat-tasks"
            >
                <Layers color={theme.muted} size={14} />
                <Text style={[styles.pillTitle, { color: theme.text }]}>
                    {t('chat.tasks.backgroundWork')}
                </Text>
                <Text
                    numberOfLines={1}
                    style={[styles.pillCount, { color: theme.muted }]}
                    testID="agent-chat-tasks-count"
                >
                    {pill.label}
                </Text>
                <ChevronUp color={theme.muted} size={14} />
            </Pressable>
        </View>
    );
};

/**
 * The Background work sheet: the task list, or one task's detail with Back to the list. With no pill left to list, it
 * shows the empty note instead.
 */
const TaskSheet = ({
    canControl,
    onBack,
    onClose,
    onOpenTask,
    pill,
    shownTask,
    stopper,
    terminalId,
    theme,
}: {
    canControl: boolean;
    onBack: () => void;
    onClose: () => void;
    onOpenTask: (taskId: string) => void;
    pill: AgentChatTaskPill | undefined;
    shownTask: AgentChatTask | undefined;
    stopper: AgentChatTaskStopper;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const shownRow = shownTask && agentChatTaskRow(shownTask, 0, t);
    const list = pill ? (
        <TaskList
            canControl={canControl}
            onOpen={onOpenTask}
            pill={pill}
            stopper={stopper}
            theme={theme}
        />
    ) : (
        <Text style={[styles.empty, { color: theme.muted }]}>{t('chat.tasks.empty')}</Text>
    );
    return (
        <BottomSheet
            closeLabel={t('chat.tasks.close')}
            maxHeight="75%"
            onClose={onClose}
            testID="agent-chat-tasks-sheet"
            theme={theme}
        >
            <View style={styles.sheetHeader}>
                {shownTask ? (
                    <IconButton
                        accessibilityLabel={t('chat.tasks.back')}
                        color={theme.primary}
                        icon={ChevronLeft}
                        onPress={onBack}
                        testID="agent-chat-task-back"
                        theme={theme}
                    />
                ) : null}
                <Text
                    accessibilityRole="header"
                    numberOfLines={2}
                    style={[
                        shownRow?.isCommandTitle ? styles.sheetCommandTitle : styles.sheetTitle,
                        { color: theme.text },
                    ]}
                >
                    {shownRow ? shownRow.title : t('chat.tasks.backgroundWork')}
                </Text>
            </View>
            {shownTask ? (
                <ScrollView style={styles.list}>
                    <AgentChatTaskDetailBody
                        canControl={canControl}
                        stopper={stopper}
                        task={shownTask}
                        terminalId={terminalId}
                        theme={theme}
                    />
                </ScrollView>
            ) : (
                list
            )}
        </BottomSheet>
    );
};

/**
 * Background work, just above the composer, as Desktop's strip: a one-row pill counting the subagents and background
 * shells that run (and those that ended), shown by the same rule (`agentChatTaskStripView`) and gone once nothing runs.
 * Tapping it opens a sheet listing each task with its elapsed time and, for a control device, Stop; a task opens its
 * command and live output in the same sheet. Stopping the turn never stops these. A saved copy shows no pill, since its
 * tasks may have ended long ago. The strip also publishes the Chat's tasks for background command rows
 * (`agent-chat-task-links.ts`), so a row's detail can show the same live output.
 */
export const AgentChatTaskStrip = ({
    chat,
    deviceRole,
    isConnected,
    theme,
}: {
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    theme: MobileTheme;
}) => {
    const { savedAt, snapshot } = chat;
    const terminalId = snapshot?.terminalId;
    const tasks = savedAt === undefined ? snapshot?.tasks : undefined;
    const canControl = deviceRole === 'control' && isConnected;
    const [isOpen, setOpen] = useState(false);
    const [openTask, setOpenTask] = useState<AgentChatTask | undefined>();
    const stopper = useAgentChatTaskStop(terminalId ?? '');
    const { t } = useTranslation();

    useEffect(() => {
        if (terminalId !== undefined)
            publishAgentChatTaskLinks(terminalId, tasks ?? [], canControl);
    }, [canControl, tasks, terminalId]);
    useEffect(() => {
        if (terminalId === undefined) return;
        return () => withdrawAgentChatTaskLinks(terminalId);
    }, [terminalId]);

    const pill = agentChatTaskPill(savedAt === undefined ? snapshot : undefined, t);
    if (!terminalId || (!pill && !isOpen)) return null;
    // The open task follows the Chat's copy; one the phone's list no longer carries keeps its last known state.
    const shownTask = openTask && (findAgentChatTask(tasks, openTask.id) ?? openTask);
    const close = (): void => {
        setOpen(false);
        setOpenTask(undefined);
    };
    return (
        <>
            {pill ? <TaskPill onOpen={() => setOpen(true)} pill={pill} theme={theme} /> : null}
            {isOpen ? (
                <TaskSheet
                    canControl={canControl}
                    onBack={() => setOpenTask(undefined)}
                    onClose={close}
                    onOpenTask={(taskId) => setOpenTask(findAgentChatTask(tasks, taskId))}
                    pill={pill}
                    shownTask={shownTask}
                    stopper={stopper}
                    terminalId={terminalId}
                    theme={theme}
                />
            ) : null}
        </>
    );
};

const styles = StyleSheet.create({
    pill: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: 1,
        flexDirection: 'row',
        marginHorizontal: 12,
        marginTop: 8,
        paddingRight: 2,
    },
    pillButton: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 8,
        // The pill opens the sheet; 48dp is the mobile minimum touch target.
        minHeight: 48,
        paddingHorizontal: 12,
    },
    pillTitle: { fontSize: 13, fontWeight: '600' },
    pillCount: { flex: 1, fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'right' },
    sheetHeader: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 44 },
    sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700', paddingHorizontal: 4 },
    sheetCommandTitle: { flex: 1, fontFamily: MONOSPACE, fontSize: 14, paddingHorizontal: 4 },
    list: { flexGrow: 0 },
    section: { fontSize: 12, fontWeight: '700', paddingHorizontal: 4, paddingTop: 12 },
    row: { alignItems: 'center', flexDirection: 'row' },
    rowButton: {
        alignItems: 'center',
        borderRadius: 10,
        flex: 1,
        flexDirection: 'row',
        gap: 10,
        minHeight: 52,
        paddingHorizontal: 6,
    },
    rowText: { flex: 1, gap: 2, minWidth: 0 },
    rowTitle: { fontSize: 15 },
    rowCommand: { fontFamily: MONOSPACE, fontSize: 13 },
    rowSummary: { fontSize: 12 },
    rowElapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
    empty: { fontSize: 14, paddingVertical: 16, textAlign: 'center' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
