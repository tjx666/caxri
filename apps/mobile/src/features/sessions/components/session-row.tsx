import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
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
    accent: {
        borderRadius: 2,
        bottom: mobileSpace.sm,
        left: 0,
        position: 'absolute',
        top: mobileSpace.sm,
        width: 3,
    },
    copy: { flex: 1, gap: mobileSpace.xxs, minWidth: 0 },
    meta: mobileType.meta,
    row: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        flexDirection: 'row',
        gap: mobileSpace.md,
        marginHorizontal: mobileSpace.sm,
        minHeight: 64,
        paddingHorizontal: mobileSpace.md,
        paddingVertical: mobileSpace.md,
    },
    status: { alignItems: 'center', justifyContent: 'center', minWidth: 20 },
    title: { ...mobileType.bodyStrong, fontWeight: '500' },
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
    const title = sessionTitleForDisplay(session.title, t);
    const handlePress = useCallback(() => onPress(session.id), [onPress, session.id]);
    const age = sessionAgeLabel(session.sessionActivityAt, now, t);
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
                    // The open Session on a tablet reads from `selection` plus the leading edge below; a press keeps
                    // the neutral `elevated` so the two states never look alike.
                    backgroundColor: pressed
                        ? theme.elevated
                        : selected
                          ? theme.selection
                          : 'transparent',
                },
            ]}
            testID={`session-row-${session.id}`}
        >
            {selected ? (
                <View
                    style={[styles.accent, { backgroundColor: theme.primary }]}
                    testID="session-row-selected"
                />
            ) : null}
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
