/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { AgentChatDelegatedTask } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { Forward } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';
import { mobileLayoutMode } from '../layout/layout-mode';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { allMobileSessions } from '../sessions/hooks/use-session-polling';
import { sessionTitleForDisplay } from '../sessions/session-row-model';

/**
 * "Delegated by" and who: a link to a Session the phone lists, or Agent Commander. A source the phone cannot open
 * (archived, deleted, or never recorded) reads as a plain delegated task.
 */
function DelegatedTaskSource({
    task,
    theme,
}: {
    task: AgentChatDelegatedTask;
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    const router = useRouter();
    const { height, width } = useWindowDimensions();
    const { hostId, sessions } = useHostSessions();
    const { source } = task;
    const by = (
        <Text style={[styles.sourceText, { color: theme.muted }]}>{t('chat.delegated.by')}</Text>
    );
    if (source?.kind === 'commander')
        return (
            <>
                {by}
                <Text style={[styles.sourceText, { color: theme.text }]}>Agent Commander</Text>
            </>
        );
    const session =
        source && allMobileSessions(sessions.sections).find(({ id }) => id === source.sessionId);
    if (!session)
        return (
            <Text style={[styles.sourceText, { color: theme.text }]}>
                {t('chat.delegated.task')}
            </Text>
        );
    const title = sessionTitleForDisplay(session.displayTitle, t);
    const open = (): void => {
        sessions.selectSession(session.id);
        const href =
            `/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(session.id)}` as const;
        /**
         * A tablet's split view swaps the Session it shows, as the list does, so it never stacks a second Terminal.
         */
        if (mobileLayoutMode(width, height) === 'phone') router.navigate(href);
        else router.replace(href);
    };
    return (
        <>
            {by}
            <Pressable
                accessibilityHint={t('chat.delegated.openSourceHint')}
                accessibilityRole="link"
                hitSlop={8}
                onPress={open}
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
 * file that the user never typed, so the bubble names who delegated it and keeps the pointer behind Show instruction.
 */
export const AgentChatDelegatedMessage = ({
    id,
    task,
    text,
    theme,
}: {
    id: string;
    task: AgentChatDelegatedTask;
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    return (
        <View
            style={[conversationStyles.message, conversationStyles.userRow]}
            testID={`agent-chat-delegated-${id}`}
        >
            <View style={[conversationStyles.userBubble, { backgroundColor: theme.surface }]}>
                <View style={styles.source}>
                    <Forward color={theme.muted} size={14} />
                    <DelegatedTaskSource task={task} theme={theme} />
                </View>
                <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    hitSlop={8}
                    onPress={() => setExpanded((value) => !value)}
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
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    source: { alignItems: 'center', flexDirection: 'row', flexShrink: 1, gap: 6 },
    sourceLink: { flexShrink: 1 },
    sourceText: { flexShrink: 1, fontSize: 15, lineHeight: 22 },
    toggle: { alignSelf: 'flex-start', marginTop: 4 },
    toggleText: { fontSize: 13, lineHeight: 18 },
    instruction: { fontSize: 13, lineHeight: 18, marginTop: 4 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
