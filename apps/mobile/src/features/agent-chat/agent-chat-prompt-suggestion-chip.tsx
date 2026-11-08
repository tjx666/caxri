/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import { Sparkles } from 'lucide-react-native';

import { Chip } from '../../components/chip';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';

/**
 * The provider's suggested next message right above the capsule (`agentChatOfferedPromptSuggestion`). Tapping it fills
 * the input without sending, the phone's stand-in for Desktop's Tab in an empty input, so the user can still edit it.
 */
export const AgentChatPromptSuggestionChip = ({
    onUse,
    suggestion,
    theme,
}: {
    onUse: (suggestion: string) => void;
    suggestion: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.row}>
            <Chip
                accessibilityHint={t('chat.promptSuggestion.useHint')}
                accessibilityLabel={t('chat.promptSuggestion.label', { suggestion })}
                icon={Sparkles}
                label={suggestion}
                onPress={() => onUse(suggestion)}
                testID="agent-chat-prompt-suggestion"
                theme={theme}
                tint={theme.muted}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    /**
     * Sizes the chip to its text but no wider than the composer, so a long suggestion ends in an ellipsis.
     */
    row: { alignItems: 'flex-start' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
