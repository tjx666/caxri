/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef } from 'react';
import {
    ActivityIndicator,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import { agentChatTaskIdentity, agentChatTaskUsageSummary } from '@caxri/protocol';
import { Bot, Check, CircleSlash, Square, SquareTerminal, X } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatTaskTranscript } from './agent-chat-task-transcript';
import type { AgentChatTaskDetailContent } from './agent-chat-tasks';
import {
    agentChatTaskDetailContent,
    agentChatTaskReadError,
    agentChatTaskRow,
} from './agent-chat-tasks';
import type { useAgentChatTaskStop } from './use-agent-chat-task-detail';
import { useAgentChatTaskClock, useAgentChatTaskDetail } from './use-agent-chat-task-detail';

const MONOSPACE = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export type AgentChatTaskStopper = ReturnType<typeof useAgentChatTaskStop>;

export const AgentChatTaskKindGlyph = ({
    kind,
    theme,
}: {
    kind: AgentChatTask['kind'];
    theme: MobileTheme;
}) => {
    const Icon = kind === 'shell' ? SquareTerminal : Bot;
    return <Icon color={theme.muted} size={16} />;
};

/**
 * A task's status as a glyph beside its label, never color alone: a spinner while it runs, then a check, a cross, or
 * the stopped mark Desktop uses for interrupted work.
 */
export const AgentChatTaskStatusGlyph = ({
    status,
    theme,
}: {
    status: AgentChatTask['status'];
    theme: MobileTheme;
}) => {
    switch (status) {
        case 'running': {
            return <ActivityIndicator color={theme.muted} size="small" style={styles.spinner} />;
        }
        case 'completed': {
            return <Check color={theme.success} size={14} />;
        }
        case 'failed': {
            return <X color={theme.danger} size={14} />;
        }
        case 'stopped': {
            return <CircleSlash color={theme.warning} size={14} />;
        }
    }
};

/**
 * Stop for one task, shown only to a control device while the task runs and the provider can stop it on its own. It
 * stays `Stopping…` until the Chat reports the task ended.
 */
export const AgentChatTaskStopButton = ({
    stopper,
    task,
    theme,
    title,
}: {
    stopper: AgentChatTaskStopper;
    task: AgentChatTask;
    theme: MobileTheme;
    title: string;
}) => {
    const { t } = useTranslation();
    const isStopping = stopper.isStopping(task);
    return (
        <Pressable
            accessibilityHint={t('chat.tasks.stopHint')}
            accessibilityLabel={t('chat.tasks.stopTitle', { title })}
            accessibilityRole="button"
            accessibilityState={{ busy: isStopping, disabled: isStopping }}
            disabled={isStopping}
            onPress={() => {
                // eslint-disable-next-line no-void -- The detail reports a failed stop itself.
                void stopper.stop(task.id);
            }}
            style={({ pressed }) => [styles.stop, { opacity: pressed ? 0.6 : 1 }]}
            testID="agent-chat-task-stop"
        >
            {isStopping ? (
                <ActivityIndicator color={theme.danger} size="small" style={styles.spinner} />
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
 * A shell's output tail in a monospace box capped at 320dp that scrolls, following the newest line while the reader
 * stays at the bottom.
 */
const TaskOutput = ({ text, theme }: { text: string; theme: MobileTheme }) => {
    const scroll = useRef<ScrollView>(null);
    const isAtBottom = useRef(true);
    return (
        <ScrollView
            nestedScrollEnabled
            onContentSizeChange={() => {
                if (isAtBottom.current) scroll.current?.scrollToEnd({ animated: false });
            }}
            onScroll={({ nativeEvent }) => {
                const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
                isAtBottom.current =
                    contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
            }}
            ref={scroll}
            scrollEventThrottle={100}
            style={[styles.output, { backgroundColor: theme.elevated }]}
            testID="agent-chat-task-output"
        >
            <Text
                selectable
                style={[styles.outputText, { color: theme.text }]}
                testID="agent-chat-task-output-text"
            >
                {text}
            </Text>
        </ScrollView>
    );
};

/**
 * The read part of a task's detail: a shell's output tail, a subagent's transcript, or a note, followed by the notes
 * the read carried; until the read answers, a spinner or the read error.
 */
const TaskDetailContent = ({
    content,
    isError,
    isLoading,
    theme,
}: {
    content: AgentChatTaskDetailContent | undefined;
    isError: boolean;
    isLoading: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (!content) {
        if (isError)
            return (
                <Text style={[styles.note, { color: theme.danger }]}>
                    {agentChatTaskReadError(t)}
                </Text>
            );
        return isLoading ? <ActivityIndicator color={theme.muted} style={styles.loading} /> : null;
    }
    return (
        <>
            {content.kind === 'output' ? (
                <TaskOutput text={content.text} theme={theme} />
            ) : content.kind === 'transcript' ? (
                <AgentChatTaskTranscript entries={content.entries} theme={theme} />
            ) : (
                <Text style={[styles.note, { color: theme.muted }]}>{content.text}</Text>
            )}
            {content.notes.map((note) => (
                <Text key={note} style={[styles.note, { color: theme.muted }]}>
                    {note}
                </Text>
            ))}
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
    stopper,
    task,
    terminalId,
    theme,
}: {
    canControl: boolean;
    stopper: AgentChatTaskStopper;
    task: AgentChatTask;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const now = useAgentChatTaskClock(task.status === 'running');
    const row = agentChatTaskRow(task, now, t);
    const { detail, isError, isLoading } = useAgentChatTaskDetail(terminalId, task);
    const content = detail ? agentChatTaskDetailContent(task, detail, t) : undefined;
    const stopError = stopper.errorFor(task.id);
    const command = task.command ?? (row.isCommandTitle ? task.title : undefined);
    const facts = [
        task.kind === 'agent' ? agentChatTaskIdentity(task) : undefined,
        agentChatTaskUsageSummary(task, t),
    ].filter(Boolean);
    return (
        <View style={styles.body} testID="agent-chat-task-detail">
            <View accessible style={styles.facts}>
                <AgentChatTaskStatusGlyph status={task.status} theme={theme} />
                <Text style={[styles.factsText, { color: theme.muted }]}>
                    {row.elapsed ? `${row.statusLabel} · ${row.elapsed}` : row.statusLabel}
                </Text>
                {canControl && row.canStop ? (
                    <AgentChatTaskStopButton
                        stopper={stopper}
                        task={task}
                        theme={theme}
                        title={row.title}
                    />
                ) : null}
            </View>
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
            {row.summary ? (
                <Text selectable style={[styles.summary, { color: theme.text }]}>
                    {row.summary}
                </Text>
            ) : null}
            <TaskDetailContent
                content={content}
                isError={isError}
                isLoading={isLoading}
                theme={theme}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    body: { gap: 10, paddingBottom: 16 },
    facts: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 48 },
    factsText: { flex: 1, fontSize: 13, fontVariant: ['tabular-nums'] },
    spinner: { transform: [{ scale: 0.8 }] },
    // A full 48dp box, like the queue card's Resume, so the target never depends on hit slop.
    stop: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        minHeight: 48,
        paddingHorizontal: 10,
    },
    stopText: { fontSize: 14, fontWeight: '700' },
    command: {
        borderRadius: 8,
        fontFamily: MONOSPACE,
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    summary: { fontSize: 14, lineHeight: 20 },
    identity: { fontSize: 12, fontVariant: ['tabular-nums'], lineHeight: 16, marginTop: -6 },
    output: { borderRadius: 8, flexGrow: 0, maxHeight: 320 },
    outputText: {
        fontFamily: MONOSPACE,
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    note: { fontSize: 13, lineHeight: 18 },
    loading: { alignSelf: 'flex-start', paddingVertical: 8 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
