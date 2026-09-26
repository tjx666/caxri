import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Check } from 'lucide-react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionChoice = ({
    disabled,
    isCompact,
    label,
    leading,
    onPress,
    reason,
    selected,
    testID,
    theme,
}: {
    disabled?: boolean;
    isCompact?: boolean;
    label: string;
    leading?: ReactNode;
    onPress: () => void;
    reason?: string;
    selected: boolean;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={reason}
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
            {reason ? (
                <Text numberOfLines={2} style={[styles.choiceReason, { color: theme.muted }]}>
                    {reason}
                </Text>
            ) : null}
        </View>
        {selected && !isCompact ? <Check color={theme.primary} size={18} /> : null}
    </Pressable>
);
