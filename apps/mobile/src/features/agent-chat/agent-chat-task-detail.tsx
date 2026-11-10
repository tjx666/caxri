/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import {
    agentChatTaskIdentity,
    agentChatTaskUsageSummary,
    agentChatTaskWorkflow,
    isAgentChatTaskTitleCommand,
} from '@caxri/protocol';
import { Square } from 'lucide-react-native';

import { ConfirmSheet } from '../../components/confirm-sheet';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatTaskReadContent, AgentChatTaskStatusGlyph } from './agent-chat-task-content';
import { agentChatTaskDetailContent, agentChatTaskRow } from './agent-chat-tasks';
import { AgentChatWorkflowDetail } from './agent-chat-workflow-detail';
import type { useAgentChatTaskStop } from './use-agent-chat-task-detail';
import { useAgentChatTaskClock, useAgentChatTaskDetail } from './use-agent-chat-task-detail';

export type AgentChatTaskStopper = ReturnType<typeof useAgentChatTaskStop>;

/**
 * Stop for one task, shown only to a control device while the task runs and the provider can stop it on its own, and
 * only in the task's detail, never in a list row where a stray tap would end a subagent. Pressing it asks for
 * confirmation (`onPress` opens a `ConfirmSheet`); it stays `Stopping…` until the Chat reports the task ended.
 */
const AgentChatTaskStopButton = ({
    isStopping,
    onPress,
    theme,
    title,
}: {
    isStopping: boolean;
    onPress: () => void;
    theme: MobileTheme;
    title: string;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityHint={t('chat.tasks.stopHint')}
            accessibilityLabel={t('chat.tasks.stopTitle', { title })}
            accessibilityRole="button"
            accessibilityState={{ busy: isStopping, disabled: isStopping }}
            disabled={isStopping}
            onPress={onPress}
            style={({ pressed }) => [styles.stop, { opacity: pressed ? 0.6 : 1 }]}
            testID="agent-chat-task-stop"
        >
            {isStopping ? (
                <Spinner color={theme.danger} size={16} />
            ) : (
                <Square color={theme.danger} fill={theme.danger} size={12} />
            )}
            <Text style={[styles.stopText, { color: theme.danger }]}>
                {t(isStopping ? 'chat.tasks.stopping' : 'chat.tasks.stop')}
            </Text>
        </Pressable>
    );
};

/**
 * The status line with Stop beside it. Pressing Stop opens the shared `ConfirmSheet` above the task's sheet: Stop ends
 * a subagent for good, so one tap on the button never does it. Android Back closes the confirmation first, then the
 * detail. The button stays in place and reads `Stopping…` once confirmed.
 */
const TaskStatusRow = ({
    canStop,
    row,
    stopper,
    task,
    theme,
}: {
    canStop: boolean;
    row: ReturnType<typeof agentChatTaskRow>;
    stopper: AgentChatTaskStopper;
    task: AgentChatTask;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isConfirmingStop, setConfirmingStop] = useState(false);
    const isStopping = stopper.isStopping(task);
    // A task that ended (or a device that lost control) while the question was open leaves nothing to confirm.
    const showStopConfirmation = isConfirmingStop && canStop && !isStopping;
    return (
        <>
            <View style={styles.facts}>
                <View accessible style={styles.status}>
                    <AgentChatTaskStatusGlyph status={task.status} theme={theme} />
                    <Text style={[styles.factsText, { color: theme.muted }]}>
                        {row.elapsed ? `${row.statusLabel} · ${row.elapsed}` : row.statusLabel}
                    </Text>
                </View>
                {canStop ? (
                    <AgentChatTaskStopButton
                        isStopping={isStopping}
                        onPress={() => setConfirmingStop(true)}
                        theme={theme}
                        title={row.title}
                    />
                ) : null}
            </View>
            {showStopConfirmation ? (
                <ConfirmSheet
                    confirmLabel={t('chat.tasks.stop')}
                    detail={t('chat.tasks.stopConfirmBody', { title: row.title })}
                    onClose={() => setConfirmingStop(false)}
                    onConfirm={() => {
                        void stopper.stop(task.id);
                    }}
                    testID="agent-chat-task-stop-confirm"
                    theme={theme}
                    title={t('chat.tasks.stopConfirmTitle')}
                    tone="danger"
                />
            ) : null}
        </>
    );
};

/**
 * What one background task did and is doing: its status and elapsed time, Stop, a subagent's type, model, and usage,
 * the command line, the provider's summary, and a shell's output tail or a subagent's transcript, read through
 * `mobile.agentChat.readTask` and kept current while it runs (`useAgentChatTaskDetail`). The Background work sheet and
 * a background command's detail show the same body.
 */
export const AgentChatTaskDetailBody = ({
    canControl,
    isCommandShown = false,
    stopper,
    task,
    terminalId,
    theme,
}: {
    canControl: boolean;
    /**
     * Whether the surrounding sheet already shows the task's command (as its title or in its own code block), so the
     * body does not repeat it.
     */
    isCommandShown?: boolean;
    stopper: AgentChatTaskStopper;
    task: AgentChatTask;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const now = useAgentChatTaskClock(task.status === 'running');
    const row = agentChatTaskRow(task, now, t);
    const { detail, isError, isLoading } = useAgentChatTaskDetail(terminalId, task);
    const workflow = agentChatTaskWorkflow(task, detail);
    const content = detail && !workflow ? agentChatTaskDetailContent(task, detail, t) : undefined;
    const stopError = stopper.errorFor(task);
    const command = isCommandShown
        ? undefined
        : (task.command ?? (isAgentChatTaskTitleCommand(task) ? task.title : undefined));
    const facts = [
        task.kind === 'agent' ? agentChatTaskIdentity(task) : undefined,
        agentChatTaskUsageSummary(task, t),
    ].filter(Boolean);
    return (
        <View style={styles.body} testID="agent-chat-task-detail">
            <TaskStatusRow
                canStop={canControl && row.canStop}
                row={row}
                stopper={stopper}
                task={task}
                theme={theme}
            />
            {facts.length > 0 ? (
                <Text
                    style={[styles.identity, { color: theme.muted }]}
                    testID="agent-chat-task-facts"
                >
                    {facts.join(' · ')}
                </Text>
            ) : null}
            {stopError ? (
                <Text accessibilityRole="alert" style={[styles.note, { color: theme.danger }]}>
                    {stopError}
                </Text>
            ) : null}
            {command ? (
                <Text
                    selectable
                    style={[styles.command, { backgroundColor: theme.elevated, color: theme.text }]}
                >
                    {command}
                </Text>
            ) : null}
            {workflow ? (
                <AgentChatWorkflowDetail
                    isRunning={task.status === 'running'}
                    terminalId={terminalId}
                    theme={theme}
                    title={row.title}
                    workflow={workflow}
                />
            ) : (
                <>
                    {row.summary ? (
                        <Text selectable style={[styles.summary, { color: theme.text }]}>
                            {row.summary}
                        </Text>
                    ) : null}
                    <AgentChatTaskReadContent
                        content={content}
                        isError={isError}
                        isLoading={isLoading}
                        theme={theme}
                    />
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    body: { gap: mobileSpace.md, paddingBottom: mobileSpace.lg },
    facts: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
    },
    status: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: mobileSpace.sm },
    factsText: { ...mobileType.meta, flex: 1, fontVariant: ['tabular-nums'] },
    // A full 48dp box, like the queue card's Resume, so the target never depends on hit slop.
    stop: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    stopText: { ...mobileType.bodyStrong, fontWeight: '700' },
    command: {
        ...mobileType.meta,
        borderRadius: mobileRadius.sm,
        fontFamily: MONOSPACE_FONT,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    summary: { ...mobileType.body },
    identity: { ...mobileType.caption, fontVariant: ['tabular-nums'], marginTop: -mobileSpace.sm },
    note: { ...mobileType.meta },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
