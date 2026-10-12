import type { ComponentType } from 'react';
import { Pressable } from 'react-native';

import type { LucideProps } from 'lucide-react-native';

import type { MobileTheme } from '../theme/tokens';

/**
 * A glyph-only control with a 44dp touch target, expanded by a 4dp `hitSlop` on every edge. The accessible name is
 * mandatory because nothing visible names it.
 */
export const IconButton = ({
    accessibilityHint,
    accessibilityLabel,
    color,
    disabled,
    expanded,
    icon: Icon,
    onDisabledPress,
    onPress,
    size = 22,
    testID,
    theme,
}: {
    accessibilityHint?: string;
    accessibilityLabel: string;
    color?: string;
    disabled?: boolean;
    expanded?: boolean;
    icon: ComponentType<LucideProps>;
    /**
     * Explains a disabled control on tap. The button still looks and announces as disabled, but a tap reaches this
     * instead of doing nothing, so the reason is visible and not only a screen reader hint.
     */
    onDisabledPress?: () => void;
    onPress: () => void;
    size?: number;
    testID?: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled, expanded }}
        disabled={disabled && !onDisabledPress}
        hitSlop={4}
        onPress={disabled ? onDisabledPress : onPress}
        style={({ pressed }) => ({
            alignItems: 'center',
            borderRadius: 24,
            height: 44,
            justifyContent: 'center',
            opacity: disabled ? 0.38 : pressed ? 0.6 : 1,
            width: 44,
        })}
        testID={testID}
    >
        <Icon color={color ?? theme.text} size={size} strokeWidth={2} />
    </Pressable>
);
