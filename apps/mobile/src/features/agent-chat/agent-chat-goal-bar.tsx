/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AGENT_CHAT_GOAL_COMMAND, agentChatGoalArguments } from '@caxri/protocol';
import { Goal, Maximize2, Minimize2, Pause, Play, Trash2 } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatGoalBarView } from './agent-chat-goal';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatTaskClock } from './use-agent-chat-task-detail';

/**
 * The goal row above the phone's composer, after Desktop's: where the provider's goal stands, the objective, and how
 * long it has been worked on, with Clear and Pause or Resume. Those run `/goal pause|resume|clear` through
 * `mobile.agentChat.runCommand`, the command Desktop's row runs. Tapping the objective shows all of it. A device that
 * cannot message the Chat sees the goal without the buttons.
 */
export const AgentChatGoalBar = ({
    canAct,
    chat,
    theme,
}: {
    canAct: boolean;
    chat: AgentChatController;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { savedAt, snapshot } = chat;
    const [isExpanded, setExpanded] = useState(false);
    const [isBusy, setBusy] = useState(false);
    const [hasFailed, setFailed] = useState(false);
    const isSavedCopy = savedAt !== undefined;
    const now = useAgentChatTaskClock(
        agentChatGoalBarView(snapshot, 0, isSavedCopy)?.isTicking ?? false,
    );
    const view = agentChatGoalBarView(snapshot, now, isSavedCopy, t);
    if (!view) return null;
    const run = async (action: 'clear' | 'pause' | 'resume'): Promise<void> => {
        setBusy(true);
        setFailed(false);
        try {
            await chat.runCommand({
                name: AGENT_CHAT_GOAL_COMMAND,
                arguments: agentChatGoalArguments({ action }),
            });
        } catch {
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };
    const accent = view.isActive ? theme.primary : theme.muted;
    return (
        <View
            style={[styles.root, { backgroundColor: theme.surface, borderColor: theme.border }]}
            testID="agent-chat-goal"
        >
            <View style={styles.row}>
                <Pressable
                    accessibilityHint={t(isExpanded ? 'chat.goal.collapse' : 'chat.goal.expand')}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isExpanded }}
                    onPress={() => setExpanded((current) => !current)}
                    style={styles.summary}
                    testID="agent-chat-goal-summary"
                >
                    <Goal color={accent} size={16} />
                    <Text style={[styles.status, { color: theme.text }]}>{view.status}</Text>
                    <Text
                        numberOfLines={1}
                        style={[styles.objective, { color: theme.muted }]}
                        testID="agent-chat-goal-objective"
                    >
                        {view.objective}
                    </Text>
                    <Text style={[styles.elapsed, { color: theme.muted }]}>{view.elapsed}</Text>
                    {isExpanded ? (
                        <Minimize2 color={theme.muted} size={14} />
                    ) : (
                        <Maximize2 color={theme.muted} size={14} />
                    )}
                </Pressable>
                {canAct ? (
                    <AgentChatGoalActions
                        isBusy={isBusy}
                        onRun={(action) => {
                            void run(action);
                        }}
                        theme={theme}
                        toggle={view.toggle}
                    />
                ) : null}
            </View>
            {isExpanded ? (
                <Text
                    selectable
                    style={[styles.full, { color: theme.text }]}
                    testID="agent-chat-goal-full"
                >
                    {view.objective}
                </Text>
            ) : null}
            {hasFailed ? (
                <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.error, { color: theme.danger }]}
                    testID="agent-chat-goal-error"
                >
                    {t('chat.commands.runFailed', { name: AGENT_CHAT_GOAL_COMMAND })}
                </Text>
            ) : null}
        </View>
    );
};

/**
 * Pause or Resume when the goal allows it, then Clear.
 */
const AgentChatGoalActions = ({
    isBusy,
    onRun,
    theme,
    toggle,
}: {
    isBusy: boolean;
    onRun: (action: 'clear' | 'pause' | 'resume') => void;
    theme: MobileTheme;
    toggle: 'pause' | 'resume' | undefined;
}) => {
    const { t } = useTranslation();
    return (
        <>
            {toggle ? (
                <IconButton
                    accessibilityLabel={t(
                        toggle === 'pause' ? 'chat.goal.pause' : 'chat.goal.resume',
                    )}
                    color={theme.muted}
                    disabled={isBusy}
                    icon={toggle === 'pause' ? Pause : Play}
                    onPress={() => onRun(toggle)}
                    size={18}
                    testID="agent-chat-goal-toggle"
                    theme={theme}
                />
            ) : null}
            <IconButton
                accessibilityLabel={t('chat.goal.clear')}
                color={theme.muted}
                disabled={isBusy}
                icon={Trash2}
                onPress={() => onRun('clear')}
                size={18}
                testID="agent-chat-goal-clear"
                theme={theme}
            />
        </>
    );
};

const styles = StyleSheet.create({
    root: {
        borderRadius: 10,
        borderWidth: 1,
        marginHorizontal: 12,
        marginTop: 8,
        paddingLeft: 12,
    },
    row: { alignItems: 'center', flexDirection: 'row' },
    summary: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 8,
        // 48dp is the mobile minimum touch target.
        minHeight: 48,
        minWidth: 0,
    },
    status: { fontSize: 13, fontWeight: '600' },
    objective: { flex: 1, fontSize: 13, minWidth: 0 },
    elapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
    full: { fontSize: 13, lineHeight: 19, paddingBottom: 10, paddingRight: 12 },
    error: { fontSize: 12, paddingBottom: 8, paddingRight: 12 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
