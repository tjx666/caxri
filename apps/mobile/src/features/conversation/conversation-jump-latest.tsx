import { Pressable } from 'react-native';

import { ArrowDown } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';

/**
 * The floating button that returns a reader parked on earlier rows to the Conversation's end.
 */
export const ConversationJumpLatest = ({
    onPress,
    theme,
}: {
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityLabel={t('conversation.jumpToLatest')}
            accessibilityRole="button"
            onPress={onPress}
            style={[
                styles.jump,
                {
                    backgroundColor: theme.elevated,
                    borderColor: theme.border,
                    boxShadow: `0px 2px 8px ${theme.shadow}`,
                },
            ]}
            testID="conversation-jump-latest"
        >
            <ArrowDown color={theme.text} size={20} />
        </Pressable>
    );
};
