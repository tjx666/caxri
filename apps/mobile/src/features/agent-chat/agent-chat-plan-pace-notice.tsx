import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isPlanPaceDismissed, limitPaceShortfall, weeklyCreditsWindow } from '@caxri/protocol';
import { TrendingUp, X } from 'lucide-react-native';

import { Card } from '../../components/card';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { agentChatPlanLimitRows } from './agent-chat-plan-limits';
import {
    useAgentChatPlanLimits,
    useDismissAgentChatUsageNotice,
} from './use-agent-chat-plan-limits';

const styles = StyleSheet.create({
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        marginBottom: mobileSpace.sm,
        paddingVertical: mobileSpace.xs,
        paddingLeft: mobileSpace.md,
    },
    body: { flex: 1, gap: mobileSpace.xxs },
    text: { ...mobileType.meta },
    reset: { ...mobileType.caption },
    dismiss: {
        alignItems: 'center',
        height: mobileControl.row,
        justifyContent: 'center',
        width: mobileControl.row,
    },
});

/**
 * Above the composer's model row, Desktop's pace reminder: the plan's weekly limit has less left than an even pace
 * would leave (`limitPaceShortfall`), so the rest of the week cannot be used at the rate it has been. It names what is
 * left and when the window resets, and its close button hides it for the rest of the local day, on every Client and
 * across relaunches, because the Server keeps the dismissal.
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
    const dismiss = useDismissAgentChatUsageNotice(terminalId, 'planPace');
    // Read at render: the limits re-read every 30 seconds, which re-renders the countdown often enough for a day.
    // eslint-disable-next-line react-hooks/purity -- a pace is relative to the render time by definition
    const now = Date.now();
    const shortfall = limitPaceShortfall(limit, now);
    if (!limit || !shortfall || isPlanPaceDismissed(limit, now)) return null;
    // An account working on credits past its weekly window gets the credits notice instead, dismissed or not.
    if (weeklyCreditsWindow(limit, now)) return null;
    const row = agentChatPlanLimitRows({ ...limit, windows: [shortfall.window] }, now, t).at(0);
    if (!row) return null;
    const text = t('chat.model.paceWarning', {
        limit: row.label,
        left: row.left,
    });
    return (
        <Card padded={false} style={styles.row} testID="agent-chat-plan-pace" theme={theme}>
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
                onPress={async () => {
                    await dismiss();
                }}
                style={styles.dismiss}
                testID="agent-chat-plan-pace-dismiss"
            >
                <X color={theme.muted} size={16} />
            </Pressable>
        </Card>
    );
};
