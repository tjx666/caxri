import type { ComponentType } from 'react';
import { Pressable } from 'react-native';

import type { LucideProps } from 'lucide-react-native';

import type { MobileTheme } from '../theme/tokens';

/**
 * A glyph-only control with a 48dp touch target. The accessible name is mandatory because nothing visible names it.
 */
export const IconButton = ({
    accessibilityHint,
    accessibilityLabel,
    color,
    disabled,
    expanded,
    icon: Icon,
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
        disabled={disabled}
        hitSlop={4}
        onPress={onPress}
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
