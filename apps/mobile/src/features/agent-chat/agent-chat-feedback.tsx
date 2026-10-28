/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatItem } from '@caxri/protocol';
import { agentChatNoticeHeading, agentChatNoticeMessage } from '@caxri/protocol';
import { CircleAlert, Clock, Gauge, SquareTerminal, TriangleAlert } from 'lucide-react-native';

import { Card } from '../../components/card';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import {
    agentChatAutoContinueLabel,
    agentChatUsageLimitHeadline,
    agentChatUsageLimitReset,
} from './agent-chat-usage-limit';
import { useMinuteClock } from './use-minute-clock';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * A turn the provider failed because the plan's usage limit is used up, after Desktop's notice: which window ran out
 * and when it resets, the provider's own words muted beneath, and whether the Chat continues on its own once the limit
 * resets. The actions (Continue now, Cancel, Continue in another Agent) stay on Desktop until the phone gains the
 * gateway methods for them.
 */
const UsageLimitContent = ({
    item,
    provider,
    theme,
    usageLimit,
}: {
    item: Notice;
    provider: string;
    theme: MobileTheme;
    usageLimit: NonNullable<Notice['usageLimit']>;
}) => {
    const { locale, t } = useTranslation();
    const now = useMinuteClock();
    const reset = agentChatUsageLimitReset(usageLimit, now, t);
    const detail = agentChatNoticeMessage(item, t);
    return (
        <>
            <Gauge color={theme.danger} size={18} />
            <View style={styles.content} testID={`chat-usage-limit-${item.id}`}>
                <Text selectable style={[styles.title, { color: theme.danger }]}>
                    {agentChatUsageLimitHeadline(usageLimit, provider, t)}
                    {reset ? <Text style={{ color: theme.muted }}> · {reset}</Text> : null}
                </Text>
                {detail ? (
                    <Text selectable style={[styles.body, { color: theme.muted }]}>
                        {detail}
                    </Text>
                ) : null}
                {usageLimit.autoContinue ? (
                    <View style={styles.auto}>
                        <Clock color={theme.muted} size={14} />
                        <Text style={[styles.body, styles.autoText, { color: theme.muted }]}>
                            {agentChatAutoContinueLabel(usageLimit.autoContinue, now, locale, t)}
                        </Text>
                    </View>
                ) : null}
            </View>
        </>
    );
};

/**
 * Explicit provider feedback keeps its source and complete details visible, including after history restoration. An
 * error is the one failure the user may need to act on (`danger` edge); a warning or command output is informative and
 * keeps the quiet card, told apart by its glyph and text color rather than by fill.
 */
export function AgentChatFeedback({
    item,
    provider,
    theme,
}: {
    item: Notice;
    /**
     * The Agent's name, for a usage-limit headline.
     */
    provider: string;
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    // Command output (`/rename` confirming a title) is informative, so it stays neutral like Desktop's.
    const tone =
        item.kind === 'error'
            ? { Icon: CircleAlert, color: theme.danger }
            : item.kind === 'warning'
              ? { Icon: TriangleAlert, color: theme.warning }
              : { Icon: SquareTerminal, color: theme.muted };
    const { Icon, color } = tone;
    return (
        <Card
            style={styles.card}
            testID={`chat-feedback-${item.id}`}
            theme={theme}
            tone={item.kind === 'error' ? 'danger' : 'default'}
        >
            {item.kind === 'error' && item.usageLimit ? (
                <UsageLimitContent
                    item={item}
                    provider={provider}
                    theme={theme}
                    usageLimit={item.usageLimit}
                />
            ) : (
                <>
                    <Icon color={color} size={18} />
                    <View style={styles.content}>
                        {item.heading && (
                            <Text selectable style={[styles.title, { color }]}>
                                {agentChatNoticeHeading(item.heading, t)}
                            </Text>
                        )}
                        <Text selectable style={[styles.body, { color }]}>
                            {item.message}
                        </Text>
                    </View>
                </>
            )}
        </Card>
    );
}

const styles = StyleSheet.create({
    card: { flexDirection: 'row', gap: mobileSpace.md },
    content: { flex: 1, gap: mobileSpace.xs, minWidth: 0 },
    title: { ...mobileType.meta, fontWeight: '600' },
    body: mobileType.meta,
    auto: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    autoText: { flex: 1 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
