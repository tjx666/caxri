/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import type { AccessibilityRole, AccessibilityState } from 'react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { mobileRadius, mobileSpace } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

/**
 * The one row a finished turn's result cards share (the edited-files card and a tracker's pull request, issue, or
 * acceptance card): a 36dp glyph tile, a text column the caller fills, and an optional trailing affordance. The caller
 * wraps it in a `Card` with `padded={false}` so the row owns its inset and pressed fill.
 */
export const AgentChatResultRow = ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    onPress,
    testID,
    theme,
    tile,
    trailing,
}: {
    accessibilityLabel: string;
    accessibilityRole: AccessibilityRole;
    accessibilityState?: AccessibilityState;
    /**
     * The text column: title, then detail lines.
     */
    children: ReactNode;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
    /**
     * The glyph drawn in the tile.
     */
    tile: ReactNode;
    trailing?: ReactNode;
}) => (
    <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
        accessibilityState={accessibilityState}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.elevated } : null]}
        testID={testID}
    >
        <View style={[styles.tile, { backgroundColor: theme.background }]}>{tile}</View>
        <View style={styles.text}>{children}</View>
        {trailing}
    </Pressable>
);

const styles = StyleSheet.create({
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: 56,
        padding: mobileSpace.md,
    },
    tile: {
        alignItems: 'center',
        borderRadius: mobileRadius.sm,
        height: 36,
        justifyContent: 'center',
        width: 36,
    },
    text: { flex: 1, gap: mobileSpace.xxs, minWidth: 0 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
