import type { ComponentType } from 'react';
import { Pressable } from 'react-native';

import type { LucideProps } from 'lucide-react-native';

import type { MobileTheme } from '../theme/tokens';
import { iconPressFeedback } from './icon-press-feedback';

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
    variant = 'default',
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
    /**
     * `toolbar` narrows the layout box to 40dp for a header's trailing actions, so two neighboring glyphs do not read
     * as spaced apart; its `hitSlop` keeps the 48dp target.
     */
    variant?: 'default' | 'toolbar';
}) => {
    const feedback = iconPressFeedback(theme);
    return (
        <Pressable
            accessibilityHint={accessibilityHint}
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="button"
            accessibilityState={{ disabled, expanded }}
            android_ripple={disabled ? undefined : feedback.android_ripple}
            disabled={disabled && !onDisabledPress}
            hitSlop={4}
            onPress={disabled ? onDisabledPress : onPress}
            style={({ pressed }) => ({
                alignItems: 'center',
                borderRadius: 24,
                height: 44,
                justifyContent: 'center',
                opacity: disabled ? 0.38 : pressed ? feedback.pressedOpacity : 1,
                width: variant === 'toolbar' ? 40 : 44,
            })}
            testID={testID}
        >
            <Icon color={color ?? theme.text} size={size} strokeWidth={2} />
        </Pressable>
    );
};
