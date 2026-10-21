import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { limitPaceShortfall } from '@caxri/protocol';
import { TrendingUp, X } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatPlanLimitRows } from './agent-chat-plan-limits';
import { useAgentChatPlanLimits } from './use-agent-chat-plan-limits';

/**
 * The local day the reminder was dismissed on, per provider, for this app run: the reminder is about today's spending,
 * so it returns the next day or after a relaunch, as on Desktop.
 */
const dismissedOn = new Map<string, string>();

const localDay = (now: number): string => new Date(now).toDateString();

const styles = StyleSheet.create({
    row: {
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        gap: 8,
        marginBottom: 6,
        paddingLeft: 10,
        paddingVertical: 6,
    },
    body: { flex: 1, gap: 2 },
    text: { fontSize: 13, lineHeight: 18 },
    reset: { fontSize: 12, lineHeight: 16 },
    dismiss: { alignItems: 'center', height: 32, justifyContent: 'center', width: 36 },
});

/**
 * Above the composer's model row, Desktop's pace reminder: the plan's weekly limit has less left than an even pace
 * would leave (`limitPaceShortfall`), so the rest of the week cannot be used at the rate it has been. It names what is
 * left and when the window resets, and its close button hides it for the rest of the day.
 */
export const AgentChatPlanPaceNotice = ({
    terminalId,
    theme,
}: {
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const limit = useAgentChatPlanLimits(terminalId);
    const [, setDismissals] = useState(0);
    // Read at render: the limits re-read every 30 seconds, which re-renders the countdown often enough for a day.
    // eslint-disable-next-line react-hooks/purity -- a pace is relative to the render time by definition
    const now = Date.now();
    const shortfall = limitPaceShortfall(limit, now);
    if (!limit || !shortfall || dismissedOn.get(limit.provider) === localDay(now)) return null;
    const row = agentChatPlanLimitRows({ ...limit, windows: [shortfall.window] }, now, t).at(0);
    if (!row) return null;
    const text = t('chat.model.paceWarning', {
        limit: row.label,
        left: row.left,
    });
    return (
        <View
            style={[styles.row, { backgroundColor: theme.elevated, borderColor: theme.border }]}
            testID="agent-chat-plan-pace"
        >
            <TrendingUp color={theme.warning} size={16} />
            <View style={styles.body}>
                <Text style={[styles.text, { color: theme.text }]}>{text}</Text>
                {row.reset ? (
                    <Text style={[styles.reset, { color: theme.muted }]}>{row.reset}</Text>
                ) : null}
            </View>
            <Pressable
                accessibilityLabel={t('chat.model.paceDismiss')}
                accessibilityRole="button"
                onPress={() => {
                    dismissedOn.set(limit.provider, localDay(Date.now()));
                    setDismissals((count) => count + 1);
                }}
                style={styles.dismiss}
                testID="agent-chat-plan-pace-dismiss"
            >
                <X color={theme.muted} size={16} />
            </Pressable>
        </View>
    );
};
