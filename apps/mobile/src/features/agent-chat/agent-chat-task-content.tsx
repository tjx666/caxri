/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native';
import { ScrollView, StyleSheet, Text } from 'react-native';

import type { AgentChatTask } from '@caxri/protocol';
import { Bot, Check, CircleSlash, Network, SquareTerminal, X } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { isScrolledToBottom } from './agent-chat-task-output';
import { AgentChatTaskTranscript } from './agent-chat-task-transcript';
import type { AgentChatTaskDetailContent } from './agent-chat-tasks';
import { agentChatTaskReadError } from './agent-chat-tasks';

/**
 * The parts a task's detail and a workflow member's detail share: the kind and status glyphs, and what a
 * `mobile.agentChat.readTask` read shows (a shell's output tail, a subagent's transcript, or a note).
 */

/**
 * The kind glyph a subagent, a workflow run, or a background shell shows wherever it is listed, as on Desktop: a
 * branching graph for a run that fans out into subagents.
 */
export const AgentChatTaskKindGlyph = ({
    isWorkflow = false,
    kind,
    size = 16,
    theme,
}: {
    isWorkflow?: boolean;
    kind: AgentChatTask['kind'];
    size?: number;
    theme: MobileTheme;
}) => {
    const Icon = kind === 'shell' ? SquareTerminal : isWorkflow ? Network : Bot;
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
export const AgentChatTaskReadContent = ({
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
 * The captured output scrolls inside this height so a long log never pushes the controls off screen.
 */
const OUTPUT_MAX_HEIGHT = 320;

const styles = StyleSheet.create({
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
