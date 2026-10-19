/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import type { LucideIcon } from 'lucide-react-native';
import { CheckCheck, Hand, Hourglass, Moon, Pin, TriangleAlert, Zap } from 'lucide-react-native';

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

export const SessionGroupHeader = ({
    group,
    label,
    theme,
}: {
    group: MobileSessionListGroup;
    label: string;
    theme: MobileTheme;
}) => {
    const Icon = GROUP_ICONS[group];
    return (
        <View accessibilityRole="header" style={styles.row} testID={`session-group-${group}`}>
            <Icon color={theme.muted} size={13} strokeWidth={2.25} />
            <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
        </View>
    );
};

const styles = StyleSheet.create({
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        paddingBottom: 6,
        paddingHorizontal: 18,
        paddingTop: 16,
    },
    label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
