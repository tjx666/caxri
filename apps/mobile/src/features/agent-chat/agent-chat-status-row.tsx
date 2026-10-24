/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { agentChatActivity } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatActivityLead } from './agent-chat-activity-lead';
import { AgentChatTaskKindGlyph } from './agent-chat-task-detail';
import { AgentChatTaskSheet } from './agent-chat-task-sheet';
import { agentChatStatusRow, agentChatTaskLeadText } from './agent-chat-tasks';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatTaskSheet } from './use-agent-chat-task-sheet';

/**
 * Lifts the 32dp row's badge to the 48dp mobile minimum touch target.
 */
const BADGE_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

/**
 * One quiet row above the composer, as Desktop's status row: what the turn is doing (`agentChatStatusRow`), with a
 * badge of the running background work's kinds and counts that opens the Background work sheet. Once the turn ended,
 * the running work leads the row and the whole row opens the sheet. A saved copy shows neither, since it is however the
 * Chat stood when it was saved; `starting` has its own status in the body.
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
                <AgentChatActivityLead activity={activity} theme={theme} />
            ) : (
                <Pressable
                    accessibilityHint={t('chat.tasks.pillHint')}
                    accessibilityRole="button"
                    hitSlop={BADGE_HIT_SLOP}
                    onPress={sheet.open}
                    style={styles.taskLead}
                    testID="agent-chat-tasks"
                >
                    <Text numberOfLines={1} style={[styles.text, { color: theme.muted }]}>
                        {sheet.pill ? agentChatTaskLeadText(sheet.pill, t) : ''}
                    </Text>
                </Pressable>
            )}
            {row.badge.length > 0 && sheet.pill ? (
                <Pressable
                    accessibilityHint={t('chat.tasks.pillHint')}
                    accessibilityLabel={t('chat.tasks.pillLabel', { label: sheet.pill.label })}
                    accessibilityRole="button"
                    hitSlop={BADGE_HIT_SLOP}
                    onPress={sheet.open}
                    style={styles.badge}
                    testID="agent-chat-tasks"
                >
                    {row.badge.map(({ kind, count }) => (
                        <View key={kind} style={styles.badgeKind}>
                            <AgentChatTaskKindGlyph kind={kind} size={14} theme={theme} />
                            <Text style={[styles.count, { color: theme.muted }]}>{count}</Text>
                        </View>
                    ))}
                </Pressable>
            ) : null}
            {sheetView}
        </View>
    );
};

const styles = StyleSheet.create({
    /**
     * Inset like the queue card's text below it, so the row, the card, and the composer share one left edge.
     */
    root: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
        minHeight: 32,
        paddingHorizontal: 24,
    },
    taskLead: { flex: 1, minWidth: 0 },
    text: { fontSize: 13, lineHeight: 18 },
    badge: { alignItems: 'center', flexDirection: 'row', gap: 10 },
    badgeKind: { alignItems: 'center', flexDirection: 'row', gap: 4 },
    count: { fontSize: 13, fontVariant: ['tabular-nums'], lineHeight: 18 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
