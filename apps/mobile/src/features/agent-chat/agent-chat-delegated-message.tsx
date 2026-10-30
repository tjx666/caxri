/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatDelegatedTask } from '@caxri/protocol';
import { Forward, MessageSquareShare } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { allMobileSessions } from '../sessions/hooks/use-session-polling';
import { sessionTitleForDisplay } from '../sessions/session-row-model';
import { ClampedText } from './agent-chat-request-parts';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { useOpenSession } from './use-open-session';

/**
 * "Delegated by" and who: a link to a Session the phone lists, or Caxri Bot. A source the phone cannot open (archived,
 * deleted, or never recorded) reads as a plain delegated task. A hand-off (`/new-session`) reads "Continued from" its
 * Session instead, since this Session carries that one's work on.
 */
function DelegatedTaskSource({
    task,
    theme,
}: {
    task: AgentChatDelegatedTask;
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    const { sessions } = useHostSessions();
    const openSession = useOpenSession();
    const { source } = task;
    const by = (
        <Text style={[styles.sourceText, { color: theme.muted }]}>
            {t(task.handoff ? 'chat.handoff.continuedFrom' : 'chat.delegated.by')}
        </Text>
    );
    if (source?.kind === 'bot')
        return (
            <>
                {by}
                <Text style={[styles.sourceText, { color: theme.text }]}>Caxri Bot</Text>
            </>
        );
    const session =
        source && allMobileSessions(sessions.sections).find(({ id }) => id === source.sessionId);
    if (!session)
        return (
            <Text style={[styles.sourceText, { color: theme.text }]}>
                {t(task.handoff ? 'chat.handoff.fromEarlier' : 'chat.delegated.task')}
            </Text>
        );
    const title = sessionTitleForDisplay(session.title, t);
    return (
        <>
            {by}
            <Pressable
                accessibilityHint={t('chat.delegated.openSourceHint')}
                accessibilityRole="link"
                hitSlop={8}
                onPress={() => openSession(session.id)}
                style={styles.sourceLink}
                testID={`agent-chat-delegated-source-${task.delegationId}`}
            >
                <Text numberOfLines={1} style={[styles.sourceText, { color: theme.primary }]}>
                    {title}
                </Text>
            </Pressable>
        </>
    );
}

/**
 * A delegated task in place of the user's bubble, as Desktop draws it. Its text is only the pointer to a private task
 * file that the user never typed, so the bubble names who delegated it and shows the task the caller wrote, clamped to
 * six lines with Show more like Desktop's. Only a task whose delegation record is gone falls back to the pointer behind
 * Show instruction. The list owns `isExpanded`, so a recycled row never carries another message's state and grows when
 * it unfolds.
 */
export const AgentChatDelegatedMessage = ({
    body,
    id,
    isExpanded,
    onToggle,
    task,
    text,
    theme,
}: {
    body: Extract<AgentChatTimelineEntry, { kind: 'delegated' }>['body'];
    id: string;
    isExpanded: boolean;
    onToggle: (id: string) => void;
    task: AgentChatDelegatedTask;
    text: string;
    theme: MobileTheme;
}) => {
    return (
        <View
            style={[conversationStyles.message, conversationStyles.userRow]}
            testID={`agent-chat-delegated-${id}`}
        >
            <View style={[conversationStyles.userBubble, { backgroundColor: theme.surface }]}>
                <View style={styles.source}>
                    {task.handoff ? (
                        <MessageSquareShare color={theme.primary} size={14} />
                    ) : (
                        <Forward color={theme.muted} size={14} />
                    )}
                    <DelegatedTaskSource task={task} theme={theme} />
                </View>
                {body.kind === 'prompt' ? (
                    <ClampedText
                        expansion={{ isExpanded, onToggle: () => onToggle(id) }}
                        maxLines={DELEGATED_PROMPT_LINES}
                        style={[styles.prompt, { color: theme.text }]}
                        testID={`agent-chat-delegated-prompt-${id}`}
                        text={body.prompt}
                        theme={theme}
                    />
                ) : (
                    <DelegatedTaskPointer
                        id={id}
                        isExpanded={isExpanded}
                        onToggle={onToggle}
                        text={text}
                        theme={theme}
                    />
                )}
            </View>
        </View>
    );
};

/**
 * Desktop clamps the task to six lines too (`DelegatedTaskPrompt`).
 */
const DELEGATED_PROMPT_LINES = 6;

/**
 * The bare pointer, for a task whose delegation record is gone: nothing else says what was asked.
 */
function DelegatedTaskPointer({
    id,
    isExpanded,
    onToggle,
    text,
    theme,
}: {
    id: string;
    isExpanded: boolean;
    onToggle: (id: string) => void;
    text: string;
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    return (
        <>
            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                hitSlop={8}
                onPress={() => onToggle(id)}
                style={styles.toggle}
                testID={`agent-chat-delegated-toggle-${id}`}
            >
                <Text style={[styles.toggleText, { color: theme.muted }]}>
                    {t(
                        isExpanded
                            ? 'chat.delegated.hideInstruction'
                            : 'chat.delegated.showInstruction',
                    )}
                </Text>
            </Pressable>
            {isExpanded ? (
                <Text selectable style={[styles.instruction, { color: theme.muted }]}>
                    {text}
                </Text>
            ) : null}
        </>
    );
}

const styles = StyleSheet.create({
    source: { alignItems: 'center', flexDirection: 'row', flexShrink: 1, gap: 6 },
    sourceLink: { flexShrink: 1 },
    sourceText: { flexShrink: 1, fontSize: 15, lineHeight: 22 },
    toggle: { alignSelf: 'flex-start', marginTop: 4 },
    toggleText: { fontSize: 13, lineHeight: 18 },
    instruction: { fontSize: 13, lineHeight: 18, marginTop: 4 },
    prompt: { fontSize: 15, lineHeight: 22, marginTop: 4 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
