/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import { ChevronLeft } from 'lucide-react-native';

import { BottomSheet } from '../../components/bottom-sheet';
import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import type { MobileTheme } from '../../theme/tokens';
import {
    AgentChatTaskDetailBody,
    AgentChatTaskKindGlyph,
    AgentChatTaskStatusGlyph,
} from './agent-chat-task-detail';
import type { AgentChatTaskPill } from './agent-chat-tasks';
import { agentChatTaskRow } from './agent-chat-tasks';
import { useAgentChatTaskClock } from './use-agent-chat-task-detail';
import type { AgentChatTaskSheetState } from './use-agent-chat-task-sheet';

/**
 * One task in the list. It only opens the task: Stop lives in the task's detail behind a confirmation, because beside
 * the timer and spinner a stray tap ended a running subagent.
 */
const TaskRow = ({
    now,
    onOpen,
    task,
    theme,
}: {
    now: number;
    onOpen: (taskId: string) => void;
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
        </View>
    );
};

const TaskList = ({
    onOpen,
    pill,
    theme,
}: {
    onOpen: (taskId: string) => void;
    pill: AgentChatTaskPill;
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
                    <TaskRow key={task.id} now={now} onOpen={onOpen} task={task} theme={theme} />
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
 * The Background work sheet the status row's badge opens: the task list with each task's elapsed time, or one task's
 * command, live output, and, for a control device, a confirmed Stop, with Back to the list. Stopping the turn never
 * stops these. With no pill left to list, it shows the empty note instead.
 */
export const AgentChatTaskSheet = ({
    state,
    theme,
}: {
    state: AgentChatTaskSheetState;
    theme: MobileTheme;
}) => {
    const {
        backToList: onBack,
        canControl,
        close: onClose,
        openTask: onOpenTask,
        sheetPill: pill,
        shownTask,
        stopper,
        terminalId,
    } = state;
    const { t } = useTranslation();
    const shownRow = shownTask && agentChatTaskRow(shownTask, 0, t);
    const list = pill ? (
        <TaskList onOpen={onOpenTask} pill={pill} theme={theme} />
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
                        isCommandShown={shownRow?.isCommandTitle}
                        stopper={stopper}
                        task={shownTask}
                        terminalId={terminalId ?? ''}
                        theme={theme}
                    />
                </ScrollView>
            ) : (
                list
            )}
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    sheetHeader: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 44 },
    sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700', paddingHorizontal: 4 },
    sheetCommandTitle: { flex: 1, fontFamily: MONOSPACE_FONT, fontSize: 14, paddingHorizontal: 4 },
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
    rowCommand: { fontFamily: MONOSPACE_FONT, fontSize: 13 },
    rowSummary: { fontSize: 12 },
    rowElapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
    empty: { fontSize: 14, paddingVertical: 16, textAlign: 'center' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
