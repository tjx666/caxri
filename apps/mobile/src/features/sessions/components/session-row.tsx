import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import {
    sessionAgeLabel,
    sessionAgentLabel,
    sessionStateLabel,
    sessionTitleForDisplay,
} from '../session-row-model';
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
    onLongPress,
    onPress,
    savedAt,
    selected,
    session,
    showProject,
    theme,
}: {
    now: number;
    /**
     * Present only for a control device, which may rename and archive Sessions.
     */
    onLongPress?: (session: MobileSessionItem) => void;
    onPress: (sessionId: string) => void;
    /**
     * When the list is the copy saved on this phone, so the row's state is only as fresh as that copy.
     */
    savedAt: number | null;
    selected: boolean;
    session: MobileSessionItem;
    /**
     * A Project filter already names the Project, so rows drop it to keep one line of metadata short.
     */
    showProject: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const title = sessionTitleForDisplay(session.displayTitle, t);
    const handlePress = useCallback(() => onPress(session.id), [onPress, session.id]);
    const age = sessionAgeLabel(session.lastOpenedAt, now, t);
    const stateLabel = sessionStateLabel(session.stateLabel, savedAt, now, t);
    return (
        <Pressable
            accessibilityHint={t('sessions.row.openHint')}
            accessibilityLabel={`${title}, ${sessionAgentLabel(session, t)}, ${stateLabel}`}
            accessibilityActions={
                onLongPress ? [{ name: 'longpress', label: t('sessions.row.actions') }] : undefined
            }
            accessibilityRole="button"
            accessibilityState={{ selected }}
            delayLongPress={350}
            onAccessibilityAction={onLongPress ? () => onLongPress(session) : undefined}
            onLongPress={onLongPress ? () => onLongPress(session) : undefined}
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
                    {title}
                </Text>
                <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                    {showProject ? `${session.projectTitle} · ${age}` : age}
                </Text>
            </View>
            <View style={styles.status}>
                <SessionStatusGlyph
                    isSaved={savedAt !== null}
                    label={stateLabel}
                    session={session}
                    theme={theme}
                />
            </View>
        </Pressable>
    );
};
