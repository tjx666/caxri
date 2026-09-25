import { Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../../theme/tokens';
import { newSessionStyles as styles } from './new-session-styles';

export const NewSessionChoice = ({
    disabled,
    isCompact,
    label,
    onPress,
    reason,
    selected,
    testID,
    theme,
}: {
    disabled?: boolean;
    isCompact?: boolean;
    label: string;
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
        style={[
            styles.choice,
            {
                backgroundColor: theme.surface,
                borderColor: selected ? theme.primary : theme.border,
            },
            isCompact ? styles.agentChoice : null,
        ]}
        testID={testID}
    >
        <View style={[styles.radio, { borderColor: selected ? theme.primary : theme.muted }]}>
            {selected ? (
                <View style={[styles.radioDot, { backgroundColor: theme.primary }]} />
            ) : null}
        </View>
        <View style={styles.choiceBody}>
            <Text style={[styles.choiceTitle, { color: disabled ? theme.muted : theme.text }]}>
                {label}
            </Text>
            {reason ? (
                <Text style={[styles.choiceReason, { color: theme.muted }]}>{reason}</Text>
            ) : null}
        </View>
    </Pressable>
);
