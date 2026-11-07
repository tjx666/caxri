import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Check, FolderTree } from 'lucide-react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { IconButton } from '../../../components/icon-button';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem } from '../session-model';
import {
    sessionAgeLabel,
    sessionAgentLabel,
    sessionAttentionStateLabel,
    sessionRowPullRequest,
    sessionStateLabel,
    sessionTitleForDisplay,
} from '../session-row-model';
import { SessionRowPullRequest } from './session-row-pull-request';
import { SessionStatusGlyph } from './session-status-glyph';

/**
 * Roughly how many characters fit `worktreeShrinkable.minWidth` beside the icon.
 */
const WORKTREE_MIN_CHARACTERS = 6;

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
    age: { ...mobileType.meta, flexShrink: 0 },
    meta: { ...mobileType.meta, flexShrink: 1 },
    /**
     * The 44dp check would make the row taller than its 64dp minimum with the vertical padding, so it pulls into that
     * padding (and the trailing one) instead of growing the row.
     */
    markDone: { marginRight: -mobileSpace.sm, marginVertical: -mobileSpace.md },
    metaLine: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.xs, minWidth: 0 },
    worktree: { alignItems: 'center', flexDirection: 'row', gap: 2 },
    /**
     * The Project names the row more than the worktree does, so the worktree gives up its width first: its shrink
     * weight dwarfs the Project's, and only once it is down to its minimum (the icon plus a few characters) does the
     * Project start to truncate too. A name already about that short does not shrink at all, since a minimum wider than
     * the name would pad it.
     */
    worktreeShrinkable: { flexShrink: 1000, minWidth: 56 },
    worktreeFixed: { flexShrink: 0 },
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
    status: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        justifyContent: 'center',
        minWidth: 20,
    },
    title: { ...mobileType.bodyStrong, fontWeight: '500' },
    unreadTitle: { fontWeight: '700' },
});

export const SessionRow = ({
    isMarkingDone = false,
    now,
    onLongPress,
    onMarkDone,
    onPress,
    savedAt,
    selected,
    session,
    showProject,
    theme,
}: {
    /**
     * Whether this row's Mark as Done request is in flight, which disables the check so a second tap sends nothing.
     */
    isMarkingDone?: boolean;
    now: number;
    /**
     * Present only for a control device, which may rename and archive Sessions.
     */
    onLongPress?: (session: MobileSessionItem) => void;
    /**
     * Present only while the row may be marked done (`canMarkDoneFromRow`): a trailing check resolves its Pending
     * Attention so it leaves Needs attention, as the check on a Desktop Activity row does. A phone has no hover, so the
     * check stays on screen instead of appearing over the status slot.
     */
    onMarkDone?: (session: MobileSessionItem) => void;
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
    const pullRequest = sessionRowPullRequest(session, savedAt !== null, t);
    const worktree = session.worktreeTitle;
    return (
        <Pressable
            accessibilityHint={t('sessions.row.openHint')}
            accessibilityLabel={[
                title,
                sessionAgentLabel(session, t),
                sessionAttentionStateLabel(session, savedAt !== null, stateLabel, t),
                ...(worktree ? [t('sessions.row.worktree', { name: worktree })] : []),
                ...(pullRequest ? [pullRequest.label] : []),
            ].join(', ')}
            accessibilityActions={[
                ...(onLongPress ? [{ name: 'longpress', label: t('sessions.row.actions') }] : []),
                ...(onMarkDone ? [{ name: 'markDone', label: t('sessions.detail.markDone') }] : []),
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            delayLongPress={350}
            onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === 'longpress') onLongPress?.(session);
                else if (!isMarkingDone && nativeEvent.actionName === 'markDone')
                    onMarkDone?.(session);
            }}
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
                <View style={styles.metaLine}>
                    {showProject ? (
                        <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                            {session.projectTitle}
                        </Text>
                    ) : null}
                    {worktree ? (
                        <View
                            style={[
                                styles.worktree,
                                worktree.length > WORKTREE_MIN_CHARACTERS
                                    ? styles.worktreeShrinkable
                                    : styles.worktreeFixed,
                            ]}
                            testID="session-row-worktree"
                        >
                            <FolderTree color={theme.muted} size={12} />
                            <Text numberOfLines={1} style={[styles.meta, { color: theme.muted }]}>
                                {worktree}
                            </Text>
                        </View>
                    ) : null}
                    <Text style={[styles.age, { color: theme.muted }]}>
                        {showProject || worktree ? `· ${age}` : age}
                    </Text>
                </View>
            </View>
            <View style={styles.status}>
                {pullRequest ? (
                    <SessionRowPullRequest
                        icon={pullRequest.icon}
                        label={pullRequest.label}
                        theme={theme}
                        tone={pullRequest.tone}
                    />
                ) : null}
                <SessionStatusGlyph
                    isSaved={savedAt !== null}
                    label={stateLabel}
                    session={session}
                    theme={theme}
                />
            </View>
            {onMarkDone ? (
                <View style={styles.markDone}>
                    <IconButton
                        accessibilityLabel={t('sessions.row.markDone', { title })}
                        color={theme.muted}
                        disabled={isMarkingDone}
                        icon={Check}
                        onPress={() => onMarkDone(session)}
                        size={20}
                        testID={`session-row-mark-done-${session.id}`}
                        theme={theme}
                    />
                </View>
            ) : null}
        </Pressable>
    );
};
