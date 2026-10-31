/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AGENT_CHAT_GOAL_COMMAND, agentChatGoalArguments } from '@caxri/protocol';
import { ChevronDown, Goal, Pause, Play, Trash2 } from 'lucide-react-native';

import { Button } from '../../components/button';
import { Card } from '../../components/card';
import { ConfirmSheet } from '../../components/confirm-sheet';
import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatGoalBarView } from './agent-chat-goal';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatTaskClock } from './use-agent-chat-task-detail';
import { useDockLayoutTransition } from './use-dock-layout-transition';

/**
 * The goal row above the phone's composer, after Desktop's: where the provider's goal stands, the objective, and how
 * long it has been worked on. The whole summary toggles the full objective (a chevron says so, like the turn fold), and
 * Pause or Resume stays on the row. Clear lives in the expanded body, away from the thumb's resting place, and asks
 * first through a confirmation sheet because it cannot be undone from the phone. Clear and Pause or Resume run `/goal
 * clear|pause|resume` through `mobile.agentChat.runCommand`, the command Desktop's row runs. A device that cannot
 * message the Chat sees the goal and its expansion only.
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
    const [isConfirmingClear, setConfirmingClear] = useState(false);
    const [isBusy, setBusy] = useState(false);
    const [hasFailed, setFailed] = useState(false);
    const layout = useDockLayoutTransition();
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
    const accent = view.isActive
        ? theme.primary
        : view.outcome === 'complete'
          ? theme.success
          : view.outcome === 'failed'
            ? theme.danger
            : theme.muted;
    const toggle = view.toggle;
    return (
        <Animated.View layout={layout} style={styles.dock} testID="agent-chat-goal">
            <Card padded={false} theme={theme}>
                <View style={styles.row}>
                    <Pressable
                        accessibilityHint={t(
                            isExpanded ? 'chat.goal.collapse' : 'chat.goal.expand',
                        )}
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
                        {/* A plain affordance inside the summary: a tap on it lands on the summary's toggle. */}
                        <View collapsable={false} testID="agent-chat-goal-expand">
                            <ChevronDown
                                color={theme.muted}
                                size={16}
                                style={isExpanded ? styles.chevronOpen : null}
                            />
                        </View>
                    </Pressable>
                    {canAct && toggle ? (
                        <GoalToggleButton
                            isBusy={isBusy}
                            onRun={run}
                            theme={theme}
                            toggle={toggle}
                        />
                    ) : null}
                </View>
                <GoalBarDetails
                    canAct={canAct}
                    hasFailed={hasFailed}
                    isBusy={isBusy}
                    isExpanded={isExpanded}
                    objective={view.objective}
                    reason={view.reason}
                    onClear={() => setConfirmingClear(true)}
                    theme={theme}
                />
            </Card>
            {isConfirmingClear ? (
                <ConfirmSheet
                    confirmLabel={t('chat.goal.clear')}
                    detail={t('chat.goal.clearConfirmBody')}
                    onClose={() => setConfirmingClear(false)}
                    onConfirm={() => {
                        void run('clear');
                    }}
                    testID="agent-chat-goal-clear-confirm"
                    theme={theme}
                    title={t('chat.goal.clearConfirmTitle')}
                    tone="danger"
                />
            ) : null}
        </Animated.View>
    );
};

/**
 * The Pause or Resume button on the goal row; split out of `AgentChatGoalBar` to keep its control flow flat
 * (react-doctor/no-high-complexity-react-function).
 */
const GoalToggleButton = ({
    isBusy,
    onRun,
    theme,
    toggle,
}: {
    isBusy: boolean;
    onRun: (action: 'pause' | 'resume') => Promise<void>;
    theme: MobileTheme;
    toggle: 'pause' | 'resume';
}) => {
    const { t } = useTranslation();
    return (
        <IconButton
            accessibilityLabel={t(toggle === 'pause' ? 'chat.goal.pause' : 'chat.goal.resume')}
            color={theme.muted}
            disabled={isBusy}
            icon={toggle === 'pause' ? Pause : Play}
            onPress={() => {
                void onRun(toggle);
            }}
            size={18}
            testID="agent-chat-goal-toggle"
            theme={theme}
        />
    );
};

/**
 * The expanded objective, the provider's reason for an ended goal, and the Clear button, plus the failure line; split
 * out of `AgentChatGoalBar` for the same reason as `GoalToggleButton`.
 */
const GoalBarDetails = ({
    canAct,
    hasFailed,
    isBusy,
    isExpanded,
    objective,
    onClear,
    reason,
    theme,
}: {
    canAct: boolean;
    hasFailed: boolean;
    isBusy: boolean;
    isExpanded: boolean;
    objective: string;
    onClear: () => void;
    reason: string | undefined;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <>
            {isExpanded ? (
                <View style={styles.expanded}>
                    <Text
                        selectable
                        style={[styles.full, { color: theme.text }]}
                        testID="agent-chat-goal-full"
                    >
                        {objective}
                    </Text>
                    {reason ? (
                        <Text
                            selectable
                            style={[styles.full, { color: theme.muted }]}
                            testID="agent-chat-goal-reason"
                        >
                            {reason}
                        </Text>
                    ) : null}
                    {canAct ? (
                        <Button
                            icon={Trash2}
                            isDisabled={isBusy}
                            label={t('chat.goal.clear')}
                            onPress={onClear}
                            testID="agent-chat-goal-clear"
                            theme={theme}
                            variant="outline"
                        />
                    ) : null}
                </View>
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
        </>
    );
};

const styles = StyleSheet.create({
    /**
     * The dock gutter is 16dp, shared with the plan card, requests, status row, and timeline column.
     */
    dock: { marginHorizontal: mobileSpace.lg, marginTop: mobileSpace.sm },
    row: { alignItems: 'center', flexDirection: 'row' },
    summary: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        // 48dp is the mobile minimum touch target.
        minHeight: mobileControl.row,
        minWidth: 0,
        paddingLeft: mobileSpace.md,
        paddingRight: mobileSpace.sm,
    },
    status: { ...mobileType.meta, fontWeight: '600' },
    objective: { ...mobileType.meta, flex: 1, minWidth: 0 },
    elapsed: { ...mobileType.caption, fontVariant: ['tabular-nums'] },
    chevronOpen: { transform: [{ rotate: '180deg' }] },
    expanded: {
        gap: mobileSpace.md,
        paddingBottom: mobileSpace.md,
        paddingHorizontal: mobileSpace.md,
    },
    full: { ...mobileType.meta },
    error: {
        ...mobileType.caption,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.md,
    },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
