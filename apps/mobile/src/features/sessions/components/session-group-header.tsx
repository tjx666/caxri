/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { LucideIcon } from 'lucide-react-native';
import {
    CheckCheck,
    ChevronDown,
    ChevronRight,
    Hand,
    Hourglass,
    Moon,
    Pin,
    TriangleAlert,
    Zap,
} from 'lucide-react-native';

import { SectionLabel } from '../../../components/section-label';
import { useTranslation } from '../../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import type { MobileSessionListGroup } from '../session-model';

/**
 * A glyph before each section heading so the eye finds a group by shape, as Desktop's Activity headings do, with the
 * same shape per group. The shapes differ from the row status glyphs on purpose: repeating a row's spinner above its
 * own rows would say the same thing twice, and a still heading never competes with a row that is working.
 */
const GROUP_ICONS: Record<MobileSessionListGroup, LucideIcon> = {
    pinned: Pin,
    attention: Hand,
    working: Zap,
    waiting: Hourglass,
    failed: TriangleAlert,
    finished: CheckCheck,
    idle: Moon,
};

/**
 * A group's heading, which collapses the group to itself and opens it again, as Desktop's Pinned and Project headings
 * do. The chevron says which way it is, and a collapsed group shows how many Sessions it holds so nothing reads as
 * gone.
 */
export const SessionGroupHeader = ({
    count,
    group,
    isCollapsed,
    label,
    onToggle,
    theme,
}: {
    count: number;
    group: MobileSessionListGroup;
    isCollapsed: boolean;
    label: string;
    onToggle: (group: MobileSessionListGroup) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const Icon = GROUP_ICONS[group];
    const Chevron = isCollapsed ? ChevronRight : ChevronDown;
    return (
        <Pressable
            accessibilityHint={t(
                isCollapsed ? 'sessions.list.expandHint' : 'sessions.list.collapseHint',
            )}
            accessibilityLabel={t('sessions.list.groupLabel', { count, label })}
            accessibilityRole="button"
            accessibilityState={{ expanded: !isCollapsed }}
            onPress={() => onToggle(group)}
            style={styles.row}
            testID={`session-group-${group}`}
        >
            <Icon color={theme.muted} size={13} strokeWidth={2.25} />
            <SectionLabel theme={theme}>{label}</SectionLabel>
            {isCollapsed ? (
                <Text style={[styles.count, { color: theme.muted }]}>{count}</Text>
            ) : null}
            <View style={styles.fill} />
            <Chevron color={theme.muted} size={14} />
        </Pressable>
    );
};

/**
 * The row under a windowed group that shows its next Sessions (`Show 10 more`), as Desktop's sidebar reveal row.
 */
export const SessionGroupReveal = ({
    count,
    group,
    onReveal,
    theme,
    windowCount,
}: {
    count: number;
    group: MobileSessionListGroup;
    onReveal: (group: MobileSessionListGroup, windowCount: number) => void;
    theme: MobileTheme;
    windowCount: number;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityRole="button"
            onPress={() => onReveal(group, windowCount)}
            style={styles.reveal}
            testID={`session-group-reveal-${group}`}
        >
            <Text style={[styles.revealText, { color: theme.primary }]}>
                {t('sessions.list.showMore', { count })}
            </Text>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    /**
     * The 48dp minimum touch target, with the heading's own spacing kept above the label.
     */
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingBottom: mobileSpace.sm,
        paddingHorizontal: mobileSpace.lg,
        paddingTop: mobileSpace.lg,
    },
    count: { ...mobileType.caption, fontVariant: ['tabular-nums'], fontWeight: '600' },
    fill: { flex: 1 },
    reveal: {
        justifyContent: 'center',
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    revealText: { ...mobileType.meta, fontWeight: '600' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
