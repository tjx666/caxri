/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { AgentChatActivity } from '@caxri/protocol';
import { formatNoticeableDuration } from '@caxri/protocol';
import { MessageCircleQuestionMark } from 'lucide-react-native';

import { ShimmerText } from '../../components/shimmer-text';
import type { MobileTheme } from '../../theme/tokens';

const ELAPSED_TICK_MS = 1000;

/**
 * How long the turn has run, kept current every second while it shows. Hidden under a second, as Desktop hides it, so a
 * quick turn never flashes `<1s`. `startedAt` is the computer's clock, so a phone clock far ahead or behind skews it; a
 * negative span reads as nothing rather than a wrong figure.
 */
const ElapsedTime = ({ startedAt, theme }: { startedAt: number; theme: MobileTheme }) => {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
        return () => clearInterval(timer);
    }, []);
    const label = formatNoticeableDuration(now - startedAt);
    return label ? (
        <Text style={[styles.elapsed, { color: theme.muted }]} testID="agent-chat-activity-elapsed">
            {label}
        </Text>
    ) : null;
};

/**
 * What the Chat is doing, above the composer, as Desktop's activity row says it: a spinner and the turn's verb under
 * the activity highlight with how long the turn has run (`Herding tokens… 12s`), `Compacting context…` while the
 * context is compacted, or a question glyph in the warning color while the turn waits on the user, which does not
 * animate since nothing is working.
 */
export const AgentChatActivityLine = ({
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
                <ActivityIndicator color={theme.muted} size="small" style={styles.spinner} />
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
    /**
     * Inset like the queue card's text below it, so the line, the card, and the composer share one left edge.
     */
    root: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        minHeight: 32,
        paddingHorizontal: 24,
    },
    /**
     * Android's small spinner is 20dp, taller than the 13pt line; a 16dp slot with the spinner scaled to fit keeps it
     * centered on the text instead of pushing the line taller.
     */
    glyph: { alignItems: 'center', height: 16, justifyContent: 'center', width: 16 },
    spinner: { transform: [{ scale: 0.8 }] },
    text: { fontSize: 13, lineHeight: 18 },
    fill: { flex: 1 },
    elapsed: { fontSize: 13, fontVariant: ['tabular-nums'], lineHeight: 18 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
