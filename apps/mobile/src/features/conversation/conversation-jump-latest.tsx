import type { ComponentType } from 'react';
import { Pressable } from 'react-native';

import type { LucideProps } from 'lucide-react-native';
import { ArrowDown, MessageSquareText } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';

const JumpButton = ({
    icon: Icon,
    isAbove = false,
    label,
    onPress,
    testID,
    theme,
}: {
    icon: ComponentType<LucideProps>;
    /**
     * Stacks the button above Jump to latest.
     */
    isAbove?: boolean;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onPress}
        style={[
            styles.jump,
            isAbove && styles.jumpMessages,
            {
                backgroundColor: theme.elevated,
                borderColor: theme.border,
                boxShadow: `0px 2px 8px ${theme.shadow}`,
            },
        ]}
        testID={testID}
    >
        <Icon color={theme.text} size={20} />
    </Pressable>
);

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
        <JumpButton
            icon={ArrowDown}
            label={t('conversation.jumpToLatest')}
            onPress={onPress}
            testID="conversation-jump-latest"
            theme={theme}
        />
    );
};

/**
 * The floating button above Jump to latest that opens the list of the user's messages, so a reader scrolling back
 * through a long Conversation picks the message to return to instead of flinging past replies.
 */
export const ConversationJumpMessages = ({
    onPress,
    theme,
}: {
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <JumpButton
            icon={MessageSquareText}
            isAbove
            label={t('conversation.messages.open')}
            onPress={onPress}
            testID="conversation-jump-messages"
            theme={theme}
        />
    );
};
