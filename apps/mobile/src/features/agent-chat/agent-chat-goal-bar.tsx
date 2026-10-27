/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

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
 * long it has been worked on, with Clear, Pause or Resume, and Expand in Desktop's order. Clear and Pause or Resume run
 * `/goal clear|pause|resume` through `mobile.agentChat.runCommand`, the command Desktop's row runs. Expand, or tapping
 * the objective, shows all of it. A device that cannot message the Chat sees the goal and Expand only.
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
                <IconButton
                    accessibilityLabel={t(isExpanded ? 'chat.goal.collapse' : 'chat.goal.expand')}
                    color={theme.muted}
                    expanded={isExpanded}
                    icon={isExpanded ? Minimize2 : Maximize2}
                    onPress={() => setExpanded((current) => !current)}
                    size={16}
                    testID="agent-chat-goal-expand"
                    theme={theme}
                />
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
 * Clear, then Pause or Resume when the goal allows it, as Desktop orders them, so Clear never sits beside Expand at the
 * row's end where a thumb lands. Clearing cannot be undone from the phone, so it asks first; Desktop's pointer does not
 * miss its target the way a thumb does.
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
    const confirmClear = (): void => {
        Alert.alert(t('chat.goal.clearConfirmTitle'), t('chat.goal.clearConfirmBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('chat.goal.clear'), style: 'destructive', onPress: () => onRun('clear') },
        ]);
    };
    return (
        <>
            <IconButton
                accessibilityLabel={t('chat.goal.clear')}
                color={theme.muted}
                disabled={isBusy}
                icon={Trash2}
                onPress={confirmClear}
                size={18}
                testID="agent-chat-goal-clear"
                theme={theme}
            />
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
