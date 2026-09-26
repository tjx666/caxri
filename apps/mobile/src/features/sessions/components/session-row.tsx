import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import { sessionAgeLabel, sessionAgentLabel } from '../session-row-model';
import { SessionStatusGlyph } from './session-status-glyph';

const styles = StyleSheet.create({
    copy: { flex: 1, gap: 3, minWidth: 0 },
    meta: { fontSize: 13 },
    row: {
        alignItems: 'center',
        borderRadius: 14,
        flexDirection: 'row',
        gap: 12,
        marginHorizontal: 8,
        minHeight: 64,
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    status: { alignItems: 'center', justifyContent: 'center', minWidth: 20 },
    title: { fontSize: 15, fontWeight: '500' },
    unreadTitle: { fontWeight: '700' },
});

export const SessionRow = ({
    now,
    onPress,
    selected,
    session,
    showProject,
    theme,
}: {
    now: number;
    onPress: (sessionId: string) => void;
    selected: boolean;
    session: MobileSessionItem;
    /**
     * A Project filter already names the Project, so rows drop it to keep one line of metadata short.
     */
    showProject: boolean;
    theme: MobileTheme;
}) => {
    const handlePress = useCallback(() => onPress(session.id), [onPress, session.id]);
    const age = sessionAgeLabel(session.lastOpenedAt, now);
    return (
        <Pressable
            accessibilityHint="Opens this Session."
            accessibilityLabel={`${session.displayTitle}, ${sessionAgentLabel(session)}, ${session.stateLabel}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={handlePress}
            style={({ pressed }) => [
                styles.row,
                {
                    backgroundColor: selected || pressed ? theme.surface : 'transparent',
                },
            ]}
            testID={`session-row-${session.id}`}
        >
            <AgentAvatar kind={session.primaryTerminal?.kind} theme={theme} />
            <View style={styles.copy}>
                <Text
                    numberOfLines={1}
                    style={[
                        styles.title,
                        session.hasUnread ? styles.unreadTitle : null,
                        { color: theme.text },
                    ]}
                >
                    {session.displayTitle}
                </Text>
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {showProject ? `${session.projectTitle} · ${age}` : age}
                </Text>
            </View>
            <View style={styles.status}>
                <SessionStatusGlyph session={session} theme={theme} />
            </View>
        </Pressable>
    );
};
