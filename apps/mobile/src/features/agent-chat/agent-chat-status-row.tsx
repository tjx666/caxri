/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { agentChatActivity } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { chipHitSlop, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatActivityLead } from './agent-chat-activity-lead';
import { AgentChatTaskKindGlyph } from './agent-chat-task-detail';
import { AgentChatTaskSheet } from './agent-chat-task-sheet';
import type { AgentChatRunningKind } from './agent-chat-tasks';
import { agentChatStatusRow, agentChatTaskLead } from './agent-chat-tasks';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatTaskSheet } from './use-agent-chat-task-sheet';

/**
 * One quiet row above the composer, as Desktop's status row: what the turn is doing (`agentChatStatusRow`), with a
 * badge of the running background work's kinds and counts that opens the Background work sheet. Once the turn ended,
 * the running work leads the row behind the same glyphs, with a chevron, and the whole row opens the sheet. A saved
 * copy shows neither, since it is however the Chat stood when it was saved; `starting` has its own status in the body.
 */
export const AgentChatStatusRow = ({
    chat,
    deviceRole,
    isConnected,
    provider,
    theme,
}: {
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const sheet = useAgentChatTaskSheet({ chat, deviceRole, isConnected });
    const current = chat.savedAt === undefined ? chat.snapshot : undefined;
    const activity = agentChatActivity(current, provider, {}, t);
    const row = agentChatStatusRow(
        activity?.kind === 'starting' ? undefined : activity,
        sheet.pill,
    );
    const sheetView = sheet.isOpen ? <AgentChatTaskSheet state={sheet} theme={theme} /> : null;
    if (!row) return sheetView;
    return (
        <View style={styles.root}>
            {activity && row.lead === 'activity' ? (
                <>
                    <AgentChatActivityLead activity={activity} theme={theme} />
                    {row.badge.length > 0 && sheet.pill ? (
                        <Pressable
                            accessibilityHint={t('chat.tasks.pillHint')}
                            accessibilityLabel={t('chat.tasks.pillLabel', {
                                label: sheet.pill.label,
                            })}
                            accessibilityRole="button"
                            hitSlop={chipHitSlop}
                            onPress={sheet.open}
                            style={styles.badge}
                            testID="agent-chat-tasks"
                        >
                            <RunningKinds kinds={row.badge} showsCounts theme={theme} />
                        </Pressable>
                    ) : null}
                </>
            ) : sheet.pill ? (
                <TaskLead
                    kinds={row.badge}
                    lead={agentChatTaskLead(sheet.pill, t)}
                    onPress={sheet.open}
                    theme={theme}
                />
            ) : null}
            {sheetView}
        </View>
    );
};

/**
 * The running background work once the turn ended: its kind glyphs, the task's title or `Background work`, and a
 * chevron saying the row opens the sheet. Counts show only for several tasks; one glyph already says one.
 */
const TaskLead = ({
    kinds,
    lead,
    onPress,
    theme,
}: {
    kinds: readonly AgentChatRunningKind[];
    lead: ReturnType<typeof agentChatTaskLead>;
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isShowsCounts = kinds.reduce((total, { count }) => total + count, 0) > 1;
    return (
        <Pressable
            accessibilityHint={t('chat.tasks.pillHint')}
            accessibilityLabel={lead.accessibilityLabel}
            accessibilityRole="button"
            hitSlop={chipHitSlop}
            onPress={onPress}
            style={styles.taskLead}
            testID="agent-chat-tasks"
        >
            <RunningKinds kinds={kinds} showsCounts={isShowsCounts} theme={theme} />
            <Text
                numberOfLines={1}
                style={[
                    styles.text,
                    styles.taskTitle,
                    lead.isCommandTitle && styles.command,
                    { color: theme.muted },
                ]}
            >
                {lead.text}
            </Text>
            <ChevronRight color={theme.muted} size={16} />
        </Pressable>
    );
};

/**
 * One glyph per running kind (subagents, then shells), each with its count when `showsCounts`.
 */
const RunningKinds = ({
    kinds,
    showsCounts,
    theme,
}: {
    kinds: readonly AgentChatRunningKind[];
    showsCounts: boolean;
    theme: MobileTheme;
}) => (
    <View style={styles.kinds}>
        {kinds.map(({ kind, count }) => (
            <View key={kind} style={styles.badgeKind}>
                <AgentChatTaskKindGlyph kind={kind} size={14} theme={theme} />
                {showsCounts ? (
                    <Text style={[styles.count, { color: theme.muted }]}>{count}</Text>
                ) : null}
            </View>
        ))}
    </View>
);

const styles = StyleSheet.create({
    /**
     * Inset by the same 16dp gutter as the docked cards and the timeline, so the row, the cards, and the composer share
     * one left edge.
     */
    root: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: 32,
        paddingHorizontal: mobileSpace.lg,
    },
    taskLead: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minWidth: 0,
    },
    taskTitle: { flex: 1, minWidth: 0 },
    command: { fontFamily: MONOSPACE_FONT },
    kinds: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.md },
    text: mobileType.meta,
    badge: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.md },
    badgeKind: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.xs },
    count: { ...mobileType.meta, fontVariant: ['tabular-nums'] },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
