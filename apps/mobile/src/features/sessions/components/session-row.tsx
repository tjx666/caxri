import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import { sessionAgeLabel, sessionAgentLabel } from '../session-row-model';

const styles = StyleSheet.create({
    sessionCopy: { flex: 1, gap: 4, minWidth: 0 },
    sessionProject: { fontSize: 13 },
    sessionRow: {
        alignItems: 'center',
        borderLeftWidth: 3,
        flexDirection: 'row',
        gap: 12,
        minHeight: 72,
        paddingHorizontal: 13,
        paddingVertical: 10,
    },
    sessionTitle: { fontSize: 15, fontWeight: '600' },
    unreadDot: { borderRadius: 4, height: 7, width: 7 },
    stateGroup: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    stateLabel: { fontSize: 12, fontWeight: '600' },
});

export const SessionRow = ({
    now,
    onPress,
    selected,
    session,
    theme,
}: {
    now: number;
    onPress: (sessionId: string) => void;
    selected: boolean;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const handlePress = useCallback(() => onPress(session.id), [onPress, session.id]);
    return (
        <Pressable
            accessibilityHint="Opens this Session."
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={handlePress}
            style={({ pressed }) => [
                styles.sessionRow,
                {
                    backgroundColor: selected ? theme.surface : theme.background,
                    borderColor: selected ? theme.primary : 'transparent',
                    opacity: pressed ? 0.72 : 1,
                },
            ]}
            testID={`session-row-${session.id}`}
        >
            <View style={styles.sessionCopy}>
                <View style={styles.stateGroup}>
                    {session.hasUnread ? (
                        <View
                            accessibilityLabel="Unread"
                            style={[styles.unreadDot, { backgroundColor: theme.primary }]}
                        />
                    ) : null}
                    <Text numberOfLines={1} style={[styles.sessionTitle, { color: theme.text }]}>
                        {session.displayTitle}
                    </Text>
                </View>
                <Text numberOfLines={1} style={[styles.sessionProject, { color: theme.muted }]}>
                    {session.projectTitle} · {sessionAgentLabel(session)} ·{' '}
                    {sessionAgeLabel(session.lastOpenedAt, now)}
                </Text>
            </View>
            <View accessible accessibilityLabel={session.stateLabel} style={styles.stateGroup}>
                <Text style={[styles.stateLabel, { color: theme.muted }]}>
                    {session.stateLabel}
                </Text>
            </View>
        </Pressable>
    );
};
