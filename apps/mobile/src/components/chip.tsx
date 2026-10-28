/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType, ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import type { LucideProps } from 'lucide-react-native';

import {
    chipHitSlop,
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';

/**
 * The app's one pill: Project filters, the Session header's pull request and preview chips, path chips above the
 * composer, and inline actions on a card. It draws at 32dp and reaches the 48dp touch minimum through its hit slop.
 * `selected` fills it with `primary`; otherwise `tint` colors the glyph and label over the `elevated` fill, so a state
 * such as a merged pull request reads from the glyph, not from a differently shaped pill.
 */
export const Chip = ({
    accessibilityHint,
    accessibilityLabel,
    children,
    disabled = false,
    icon: Icon,
    label,
    onPress,
    selected = false,
    testID,
    theme,
    tint,
    trailing,
}: {
    accessibilityHint?: string;
    accessibilityLabel?: string;
    /**
     * A custom glyph (such as a pull request state glyph) drawn before the label, used instead of `icon`.
     */
    children?: ReactNode;
    /**
     * A read-only chip: it keeps its look (it still names a state, such as the model that answers) but takes no press.
     */
    disabled?: boolean;
    icon?: ComponentType<LucideProps>;
    label?: string;
    onPress: () => void;
    selected?: boolean;
    testID: string;
    theme: MobileTheme;
    tint?: string;
    /**
     * Extra content drawn after the label, such as a mode word.
     */
    trailing?: ReactNode;
}) => {
    const foreground = selected ? theme.primaryForeground : (tint ?? theme.text);
    return (
        <Pressable
            accessibilityHint={accessibilityHint}
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected }}
            disabled={disabled}
            hitSlop={chipHitSlop}
            onPress={onPress}
            style={({ pressed }) => [
                styles.chip,
                {
                    backgroundColor: selected ? theme.primary : theme.elevated,
                    opacity: pressed ? PRESSED_OPACITY : 1,
                },
            ]}
            testID={testID}
        >
            {children ?? (Icon ? <Icon color={foreground} size={16} /> : null)}
            {label ? (
                <Text
                    numberOfLines={1}
                    style={[mobileType.meta, styles.label, { color: foreground }]}
                >
                    {label}
                </Text>
            ) : null}
            {trailing}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    chip: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        flexDirection: 'row',
        gap: mobileSpace.xs,
        height: mobileControl.chip,
        paddingHorizontal: mobileSpace.md,
    },
    label: { flexShrink: 1, fontVariant: ['tabular-nums'], fontWeight: '600' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
