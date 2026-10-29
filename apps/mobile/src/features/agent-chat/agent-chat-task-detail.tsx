/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import { agentChatTaskIdentity, agentChatTaskUsageSummary } from '@caxri/protocol';
import { Bot, Check, CircleSlash, Square, SquareTerminal, X } from 'lucide-react-native';

import { ConfirmSheet } from '../../components/confirm-sheet';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileControl, mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
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
    size = 16,
    theme,
}: {
    kind: AgentChatTask['kind'];
    size?: number;
    theme: MobileTheme;
}) => {
    const Icon = kind === 'shell' ? SquareTerminal : Bot;
    return <Icon color={theme.muted} size={size} />;
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
            return <Spinner color={theme.muted} size={16} />;
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
        return isLoading ? <Spinner color={theme.muted} style={styles.loading} /> : null;
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

/**
 * The captured output scrolls inside this height so a long log never pushes the controls off screen.
 */
const OUTPUT_MAX_HEIGHT = 320;

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
    output: { borderRadius: mobileRadius.sm, flexGrow: 0, maxHeight: OUTPUT_MAX_HEIGHT },
    outputText: {
        ...mobileType.meta,
        fontFamily: MONOSPACE_FONT,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.sm,
    },
    note: { ...mobileType.meta },
    loading: { alignSelf: 'flex-start', paddingVertical: mobileSpace.sm },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
