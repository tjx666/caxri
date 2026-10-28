/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AgentChatActivity } from '@caxri/protocol';
import { formatNoticeableDuration } from '@caxri/protocol';
import { MessageCircleQuestionMark } from 'lucide-react-native';

import { ShimmerText } from '../../components/shimmer-text';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

const ELAPSED_TICK_MS = 1000;

/**
 * How long the turn has run, kept current every second while it shows. Hidden under a second, as Desktop hides it, so a
 * quick turn never flashes `<1s`. `startedAt` is the computer's clock, so a phone clock far ahead or behind skews it; a
 * negative span reads as nothing rather than a wrong figure.
 */
const ElapsedTime = ({ startedAt, theme }: { startedAt: number; theme: MobileTheme }) => {
    const { t } = useTranslation();
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
        return () => clearInterval(timer);
    }, []);
    const label = formatNoticeableDuration(now - startedAt, t);
    return label ? (
        <Text style={[styles.elapsed, { color: theme.muted }]} testID="agent-chat-activity-elapsed">
            {label}
        </Text>
    ) : null;
};

/**
 * What the Chat is doing, leading the status row above the composer as Desktop's activity lead says it: the spinner and
 * the turn's phrase under the activity highlight with how long the turn has run (`Mapping the terrain… 12s`),
 * `Compacting context…` while the context is compacted, or a question glyph in the warning color while the turn waits
 * on the user, which does not animate since nothing is working.
 */
export const AgentChatActivityLead = ({
    activity,
    theme,
}: {
    activity: AgentChatActivity;
    theme: MobileTheme;
}) => (
    <View
        accessibilityLabel={activity.text}
        accessible
        style={styles.root}
        testID="agent-chat-activity"
    >
        <View style={styles.glyph}>
            {activity.kind === 'waiting' ? (
                <MessageCircleQuestionMark color={theme.warning} size={14} />
            ) : (
                <Spinner color={theme.muted} size={14} />
            )}
        </View>
        {activity.kind === 'waiting' ? (
            <Text numberOfLines={1} style={[styles.text, styles.fill, { color: theme.muted }]}>
                {activity.text}
            </Text>
        ) : (
            <ShimmerText color={theme.muted} highlightColor={theme.text} textStyle={styles.text}>
                {activity.text}
            </ShimmerText>
        )}
        {activity.kind === 'working' && activity.startedAt !== undefined ? (
            <ElapsedTime startedAt={activity.startedAt} theme={theme} />
        ) : null}
    </View>
);

const styles = StyleSheet.create({
    root: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: mobileSpace.sm, minWidth: 0 },
    /**
     * A 16dp slot keeps the 14dp glyph centered on the 13pt line, the size Desktop's lead draws it at.
     */
    glyph: { alignItems: 'center', height: 16, justifyContent: 'center', width: 16 },
    text: mobileType.meta,
    fill: { flex: 1 },
    elapsed: { ...mobileType.meta, fontVariant: ['tabular-nums'] },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
