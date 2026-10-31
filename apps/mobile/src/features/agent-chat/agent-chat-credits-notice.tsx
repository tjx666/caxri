import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCreditsBalance, weeklyCreditsNotice } from '@caxri/protocol';
import { Gauge, X } from 'lucide-react-native';

import { Card } from '../../components/card';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatPlanPaceNotice } from './agent-chat-plan-pace-notice';
import { useAgentChatUsage, useDismissAgentChatUsageNotice } from './use-agent-chat-plan-limits';

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
    detail: { ...mobileType.caption },
    dismiss: {
        alignItems: 'center',
        height: mobileControl.row,
        justifyContent: 'center',
        width: mobileControl.row,
    },
});

/**
 * Above the composer's model row, Desktop's credits notice in place of the usage guard card: the weekly window is at
 * the guard, but the account still has usable credits, so requests go on, now spending them (`weeklyCreditsNotice`).
 * Nothing is paused and there is nothing to hand off. Its close button hides it for a day on every Client and across
 * relaunches, because the Server keeps the dismissal; the pace reminder gives way to it.
 */
const AgentChatCreditsNotice = ({
    provider,
    terminalId,
    theme,
}: {
    /**
     * The Agent's name, for the headline.
     */
    provider: string;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const limit = useAgentChatUsage(terminalId)?.limit;
    const dismiss = useDismissAgentChatUsageNotice(terminalId, 'credits');
    // Read at render: the limits re-read every 30 seconds, often enough for a notice that lasts until the weekly reset.
    // eslint-disable-next-line react-hooks/purity -- the notice is relative to the render time by definition
    const notice = weeklyCreditsNotice(limit, Date.now());
    if (!notice) return null;
    const balance = formatCreditsBalance(notice.credits);
    const kind = notice.credits.currency ? 'extraUsage' : 'credits';
    const headline = { provider, percent: Math.floor(notice.usedPercent) };
    return (
        <Card padded={false} style={styles.row} testID="agent-chat-credits-notice" theme={theme}>
            <Gauge color={theme.warning} size={16} />
            <View style={styles.body}>
                <Text style={[styles.text, { color: theme.warning }]}>
                    {balance
                        ? t(`chat.creditsNotice.${kind}Left`, { ...headline, balance })
                        : t(`chat.creditsNotice.${kind}`, headline)}
                </Text>
                <Text style={[styles.detail, { color: theme.muted }]}>
                    {t('chat.creditsNotice.detail')}
                </Text>
            </View>
            <Pressable
                accessibilityLabel={t('chat.creditsNotice.dismiss')}
                accessibilityRole="button"
                onPress={async () => {
                    await dismiss();
                }}
                style={styles.dismiss}
                testID="agent-chat-credits-notice-dismiss"
            >
                <X color={theme.muted} size={16} />
            </Pressable>
        </Card>
    );
};

/**
 * The usage notices above the composer's model row: the credits notice, then the pace reminder, which gives way to it.
 */
export const AgentChatUsageNotices = (properties: {
    provider: string;
    terminalId: string;
    theme: MobileTheme;
}) => (
    <>
        <AgentChatCreditsNotice {...properties} />
        <AgentChatPlanPaceNotice terminalId={properties.terminalId} theme={properties.theme} />
    </>
);
