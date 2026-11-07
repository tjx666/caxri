import { Pressable } from 'react-native';

import { Plus } from 'lucide-react-native';

import { PRESSED_OPACITY } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { sessionDetailStyles as styles } from './session-detail-styles';

/**
 * The composer capsule's leading `+`, a filled circle like LobeHub's: it opens the composer's add sheet
 * (`ComposerAddSheet`), with attachment sources and, in a Chat, its settings.
 */
export const ComposerAddButton = ({
    accessibilityHint,
    accessibilityLabel,
    disabled = false,
    onPress,
    testID,
    theme,
}: {
    accessibilityHint?: string;
    accessibilityLabel: string;
    disabled?: boolean;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={4}
        onPress={onPress}
        style={({ pressed }) => [
            styles.sendButton,
            {
                backgroundColor: theme.elevated,
                opacity: disabled ? 0.38 : pressed ? PRESSED_OPACITY : 1,
            },
        ]}
        testID={testID}
    >
        <Plus color={theme.text} size={22} strokeWidth={2} />
    </Pressable>
);
