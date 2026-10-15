/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Image, StyleSheet, Text, View } from 'react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';

const THUMBNAIL_SIZE = 96;

/**
 * A message on its way, laid out like the user message it becomes but faded, with Desktop's `Sending…` caption and none
 * of its actions, since nothing can act on a message the conversation does not hold yet. Its images show from the
 * prepared JPEGs still on the phone.
 */
export const AgentChatPendingMessage = ({
    id,
    imageUris,
    text,
    theme,
}: {
    id: string;
    imageUris: readonly string[];
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View
            accessibilityState={{ busy: true }}
            style={[conversationStyles.message, conversationStyles.userRow, styles.pending]}
            testID={`agent-chat-pending-${id}`}
        >
            {imageUris.length > 0 ? (
                <View style={styles.images}>
                    {imageUris.map((uri, index) => (
                        <Image
                            accessibilityLabel={t('chat.attachment', { number: index + 1 })}
                            key={uri}
                            resizeMode="cover"
                            source={{ uri }}
                            style={[styles.thumbnail, { borderColor: theme.border }]}
                        />
                    ))}
                </View>
            ) : null}
            {text.length > 0 ? (
                <View style={[conversationStyles.userBubble, { backgroundColor: theme.surface }]}>
                    <Text selectable style={[conversationStyles.userText, { color: theme.text }]}>
                        {text}
                    </Text>
                </View>
            ) : null}
            <Text
                accessibilityLiveRegion="polite"
                style={[styles.caption, { color: theme.muted }]}
                testID="agent-chat-pending-sending"
            >
                {t('chat.sending')}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    pending: { opacity: 0.6 },
    images: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
    thumbnail: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        height: THUMBNAIL_SIZE,
        width: THUMBNAIL_SIZE,
    },
    caption: { fontSize: 11, lineHeight: 16, marginTop: -2 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
