import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useSharedValue } from 'react-native-reanimated';

import type { LucideIcon } from 'lucide-react-native';
import { Archive, Check, FolderTree } from 'lucide-react-native';

import { AgentAvatar } from '../../../components/agent-icon';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType, PRESSED_OPACITY } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionItem, SessionRowSwipeAction } from '../session-model';
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

const SWIPE_ACTION_WIDTH = 76;
/**
 * How far a left drag travels before the row takes it. The library default (10dp) let the sideways drift of an ordinary
 * upward flick open the row and freeze the list (#2540); at 20dp the list's own vertical slop (8dp) wins any mostly
 * vertical drag first. It stays below the Project pager's 24dp, so a left drag that starts on a swipeable row reveals
 * its actions instead of paging to the next Project.
 */
const SWIPE_ACTIVATION_DP = 20;
/**
 * A right drag on a closed row never activates the row's swipe, so it falls through to the Project pager and pages to
 * the previous Project. Once the row is open, a right drag closes it instead.
 */
const SWIPE_CLOSED_RIGHT_OFFSET = Number.MAX_SAFE_INTEGER;

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
    swipeAction: {
        alignItems: 'center',
        gap: 4,
        justifyContent: 'center',
        width: SWIPE_ACTION_WIDTH,
    },
    swipeActions: { flexDirection: 'row' },
    swipeActionText: { ...mobileType.meta, fontWeight: '700' },
    title: { ...mobileType.bodyStrong, fontWeight: '500' },
    unreadTitle: { fontWeight: '700' },
});

const SwipeAction = ({
    accessibilityLabel,
    background,
    disabled,
    foreground,
    icon: Icon,
    label,
    onPress,
    testID,
}: {
    accessibilityLabel: string;
    background: string;
    disabled: boolean;
    foreground: string;
    icon: LucideIcon;
    label: string;
    onPress: () => void;
    testID: string;
}) => (
    <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
            styles.swipeAction,
            { backgroundColor: background, opacity: pressed || disabled ? PRESSED_OPACITY : 1 },
        ]}
        testID={testID}
    >
        <Icon color={foreground} size={20} strokeWidth={2.25} />
        <Text style={[styles.swipeActionText, { color: foreground }]}>{label}</Text>
    </Pressable>
);

/**
 * One Session in the home list. Swiping it left reveals its row actions (`sessionRowSwipeActions`): Mark as Done, which
 * resolves its Pending Attention as the check on a Desktop Activity row does, and Archive. Only a tap on an action runs
 * it, so a stray swipe changes nothing, and the screen reader reaches the same actions on the row itself. A row with no
 * actions does not swipe, which leaves every sideways drag to the Project pager. The trailing swipe actions follow the
 * T3 Code and monocode phone thread lists, and leaving a right drag to the pager around the row follows monocode.
 */
export const SessionRow = ({
    isActionPending = false,
    now,
    onArchive,
    onLongPress,
    onMarkDone,
    onPress,
    onSwipeOpen,
    savedAt,
    selected,
    session,
    showProject,
    swipeActions,
    theme,
}: {
    /**
     * Whether a swipe action on this row is in flight, which disables the actions so a second tap sends nothing.
     */
    isActionPending?: boolean;
    now: number;
    onArchive: (session: MobileSessionItem) => void;
    /**
     * Present only for a control device, which may rename and archive Sessions.
     */
    onLongPress?: (session: MobileSessionItem) => void;
    onMarkDone: (session: MobileSessionItem) => void;
    onPress: (sessionId: string) => void;
    /**
     * Called as the row's actions open, so the list can close the row that was open before: one row is open at a time.
     */
    onSwipeOpen?: (row: SwipeableMethods) => void;
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
    swipeActions: readonly SessionRowSwipeAction[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const title = sessionTitleForDisplay(session.title, t);
    const handlePress = useCallback(() => onPress(session.id), [onPress, session.id]);
    const swipeable = useRef<SwipeableMethods>(null);
    const dragOffsetFromLeft = useSharedValue(SWIPE_CLOSED_RIGHT_OFFSET);
    const canMarkDone = swipeActions.includes('markDone');
    const canArchive = swipeActions.includes('archive');
    const runAction = useCallback(
        (action: (session: MobileSessionItem) => void) => {
            swipeable.current?.close();
            action(session);
        },
        [session],
    );
    const age = sessionAgeLabel(session.sessionActivityAt, now, t);
    const stateLabel = sessionStateLabel(session.stateLabel, savedAt, now, t);
    const pullRequest = sessionRowPullRequest(session, savedAt !== null, t);
    const worktree = session.worktreeTitle;
    const row = (
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
                ...(canMarkDone
                    ? [{ name: 'markDone', label: t('sessions.detail.markDone') }]
                    : []),
                ...(canArchive ? [{ name: 'archive', label: t('sessions.actions.archive') }] : []),
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            delayLongPress={350}
            onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === 'longpress') onLongPress?.(session);
                else if (isActionPending) return;
                else if (canMarkDone && nativeEvent.actionName === 'markDone') onMarkDone(session);
                else if (canArchive && nativeEvent.actionName === 'archive') onArchive(session);
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
        </Pressable>
    );
    if (swipeActions.length === 0) return row;
    return (
        <ReanimatedSwipeable
            childrenContainerStyle={{ backgroundColor: theme.background }}
            dragOffsetFromLeft={dragOffsetFromLeft}
            dragOffsetFromRight={-SWIPE_ACTIVATION_DP}
            friction={1}
            onSwipeableWillClose={() => dragOffsetFromLeft.set(SWIPE_CLOSED_RIGHT_OFFSET)}
            onSwipeableWillOpen={() => {
                dragOffsetFromLeft.set(SWIPE_ACTIVATION_DP);
                if (swipeable.current) onSwipeOpen?.(swipeable.current);
            }}
            overshootRight={false}
            ref={swipeable}
            renderRightActions={() => (
                <View style={styles.swipeActions}>
                    {canMarkDone ? (
                        <SwipeAction
                            accessibilityLabel={t('sessions.row.markDone', { title })}
                            background={theme.success}
                            disabled={isActionPending}
                            foreground={theme.background}
                            icon={Check}
                            label={t('sessions.row.done')}
                            onPress={() => runAction(onMarkDone)}
                            testID={`session-row-mark-done-${session.id}`}
                        />
                    ) : null}
                    {canArchive ? (
                        <SwipeAction
                            accessibilityLabel={t('sessions.row.archive', { title })}
                            background={theme.elevated}
                            disabled={isActionPending}
                            foreground={theme.text}
                            icon={Archive}
                            label={t('sessions.actions.archive')}
                            onPress={() => runAction(onArchive)}
                            testID={`session-row-archive-${session.id}`}
                        />
                    ) : null}
                </View>
            )}
            rightThreshold={SWIPE_ACTION_WIDTH / 2}
            testID={`session-row-swipe-${session.id}`}
        >
            {row}
        </ReanimatedSwipeable>
    );
};
