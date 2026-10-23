/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import { agentChatTaskIdentity, agentChatTaskUsageSummary } from '@caxri/protocol';
import { Bot, Check, CircleSlash, Square, SquareTerminal, X } from 'lucide-react-native';

import { SheetButton } from '../../components/sheet-button';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import type { MobileTheme } from '../../theme/tokens';
import { isScrolledToBottom } from './agent-chat-task-output';
import { AgentChatTaskTranscript } from './agent-chat-task-transcript';
import type { AgentChatTaskDetailContent } from './agent-chat-tasks';
import {
    agentChatTaskDetailContent,
    agentChatTaskReadError,
    agentChatTaskRow,
} from './agent-chat-tasks';
import type { useAgentChatTaskStop } from './use-agent-chat-task-detail';
import { useAgentChatTaskClock, useAgentChatTaskDetail } from './use-agent-chat-task-detail';

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
 * Stop for one task, shown only to a control device while the task runs and the provider can stop it on its own, and
 * only in the task's detail, never in a list row where a stray tap would end a subagent. Pressing it asks for
 * confirmation (`onPress` opens `StopConfirmation`); it stays `Stopping…` until the Chat reports the task ended.
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
 * The second step before a stop, in the sheet itself like the pull request merge confirmation: Stop ends a subagent for
 * good, so one tap on the button never does it.
 */
const StopConfirmation = ({
    onCancel,
    onStop,
    theme,
    title,
}: {
    onCancel: () => void;
    onStop: () => void;
    theme: MobileTheme;
    title: string;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.confirmation} testID="agent-chat-task-stop-confirmation">
            <Text style={[styles.confirmTitle, { color: theme.text }]}>
                {t('chat.tasks.stopConfirmTitle')}
            </Text>
            <Text numberOfLines={3} style={[styles.confirmText, { color: theme.muted }]}>
                {t('chat.tasks.stopConfirmBody', { title })}
            </Text>
            <View style={styles.confirmButtons}>
                <View style={styles.confirmSlot}>
                    <SheetButton
                        label={t('common.cancel')}
                        onPress={onCancel}
                        testID="agent-chat-task-stop-cancel"
                        theme={theme}
                        variant="secondary"
                    />
                </View>
                <View style={styles.confirmSlot}>
                    <SheetButton
                        label={t('chat.tasks.stop')}
                        onPress={onStop}
                        testID="agent-chat-task-stop-confirm"
                        theme={theme}
                        variant="danger"
                    />
                </View>
            </View>
        </View>
    );
};

/**
 * A shell's output tail in a monospace box capped at 320dp that scrolls, following the newest line while the reader
 * stays at the bottom. Only the reader's own scrolls decide whether they left the bottom: `onScroll` also fires while
 * new lines grow the content, measured against the old offset, so a burst taller than the slack (the last lines and the
 * exit line arriving as a task ends) used to read as the reader scrolling away and the box stopped short of them.
 */
const TaskOutput = ({ text, theme }: { text: string; theme: MobileTheme }) => {
    const scroll = useRef<ScrollViewInstance>(null);
    const isAtBottom = useRef(true);
    const onReaderScrolled = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
        isAtBottom.current = isScrolledToBottom(nativeEvent);
    };
    return (
        <ScrollView
            nestedScrollEnabled
            onContentSizeChange={(_width, height) => {
                if (!isAtBottom.current) return;
                // `scrollToEnd` here still measured the previous content on Android and stopped short of the newest
                // lines; scrolling to the reported height a frame later lands on the real end (the view clamps it).
                requestAnimationFrame(() =>
                    scroll.current?.scrollTo({ animated: false, y: height }),
                );
            }}
            onMomentumScrollEnd={onReaderScrolled}
            onScrollEndDrag={onReaderScrolled}
            ref={scroll}
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
 * The status line with Stop beside it; pressing Stop swaps the button for `StopConfirmation` below the line.
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
                {canStop && !showStopConfirmation ? (
                    <AgentChatTaskStopButton
                        isStopping={isStopping}
                        onPress={() => setConfirmingStop(true)}
                        theme={theme}
                        title={row.title}
                    />
                ) : null}
            </View>
            {showStopConfirmation ? (
                <StopConfirmation
                    onCancel={() => setConfirmingStop(false)}
                    onStop={() => {
                        setConfirmingStop(false);
                        void stopper.stop(task.id);
                    }}
                    theme={theme}
                    title={row.title}
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
    const content = detail ? agentChatTaskDetailContent(task, detail, t) : undefined;
    const stopError = stopper.errorFor(task);
    const command = isCommandShown
        ? undefined
        : (task.command ?? (row.isCommandTitle ? task.title : undefined));
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
    status: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 8 },
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
    confirmation: { gap: 8 },
    confirmTitle: { fontSize: 16, fontWeight: '700' },
    confirmText: { fontSize: 14, lineHeight: 20 },
    confirmButtons: { flexDirection: 'row', gap: 10, paddingTop: 4 },
    confirmSlot: { flex: 1 },
    command: {
        borderRadius: 8,
        fontFamily: MONOSPACE_FONT,
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    summary: { fontSize: 14, lineHeight: 20 },
    identity: { fontSize: 12, fontVariant: ['tabular-nums'], lineHeight: 16, marginTop: -6 },
    output: { borderRadius: 8, flexGrow: 0, maxHeight: 320 },
    outputText: {
        fontFamily: MONOSPACE_FONT,
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    note: { fontSize: 13, lineHeight: 18 },
    loading: { alignSelf: 'flex-start', paddingVertical: 8 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
