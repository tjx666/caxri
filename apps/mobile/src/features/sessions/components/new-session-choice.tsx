import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Check } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionChoice = ({
    detail,
    disabled,
    isCompact,
    label,
    leading,
    onPress,
    selected,
    testID,
    theme,
}: {
    /**
     * The muted second line, also the accessibility hint: why a choice is unavailable, or what it does.
     */
    detail?: string;
    disabled?: boolean;
    isCompact?: boolean;
    label: string;
    leading?: ReactNode;
    onPress: () => void;
    selected: boolean;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={detail}
        accessibilityLabel={label}
        accessibilityRole="radio"
        accessibilityState={{ disabled, selected }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
            styles.choice,
            {
                backgroundColor: selected || pressed ? theme.surface : 'transparent',
                borderColor: selected ? theme.primary : theme.border,
                opacity: disabled ? 0.5 : 1,
            },
            isCompact ? styles.agentChoice : null,
        ]}
        testID={testID}
    >
        {leading}
        <View style={styles.choiceBody}>
            <Text
                numberOfLines={1}
                style={[styles.choiceTitle, { color: disabled ? theme.muted : theme.text }]}
            >
                {label}
            </Text>
            {detail ? (
                <Text numberOfLines={2} style={[styles.choiceReason, { color: theme.muted }]}>
                    {detail}
                </Text>
            ) : null}
        </View>
        {selected && !isCompact ? <Check color={theme.primary} size={18} /> : null}
    </Pressable>
);
