import { useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Text, View } from 'react-native';

import { Button } from '../../components/button';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles as styles } from './conversation-styles';

/**
 * The header above the oldest loaded message: the load-earlier button, its offline, expired, truncated, and error
 * notes, and the start-of-conversation marker once no older page remains.
 */
export const ConversationHistory = ({
    error,
    historyExpired,
    isLoadingOlder,
    needsConnection,
    onLoadOlder,
    olderCursor,
    theme,
    truncated,
}: {
    error: string | null;
    historyExpired: boolean;
    isLoadingOlder: boolean;
    needsConnection: boolean;
    onLoadOlder: () => void;
    olderCursor?: string;
    theme: MobileTheme;
    truncated: boolean;
}) => {
    const { t } = useTranslation();
    /**
     * The tallest the header has been while it offered older messages. FlashList keeps the reader's row in place only
     * against rows, not this header, so when the last older page removed the load-earlier button the shorter header
     * pulled every row up by its height. Keeping the space trades a gap above the conversation's start for a list that
     * stays put; a passing error or offline note does not count, so it leaves no lasting gap.
     */
    const [minHeight, setMinHeight] = useState(0);
    const onLayout = (event: LayoutChangeEvent): void => {
        if (!olderCursor || error || needsConnection || historyExpired) return;
        const { height } = event.nativeEvent.layout;
        setMinHeight((current) => Math.max(current, height));
    };
    /**
     * Once the last older page has loaded, the space kept for the load-earlier button names the start instead of
     * reading as a gap. Only a header that offered older pages reserved space, so a short conversation shows nothing.
     */
    const isStartMarkerShown =
        minHeight > 0 &&
        !olderCursor &&
        !error &&
        !needsConnection &&
        !historyExpired &&
        !truncated;
    return (
        <View onLayout={onLayout} style={[styles.history, { minHeight }]}>
            {historyExpired ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-expired"
                >
                    {t('conversation.historyExpired')}
                </Text>
            ) : null}
            {olderCursor ? (
                <Button
                    isBusy={isLoadingOlder}
                    label={t(
                        isLoadingOlder ? 'conversation.loadingEarlier' : 'conversation.loadEarlier',
                    )}
                    onPress={onLoadOlder}
                    style={styles.stateButton}
                    testID="conversation-load-earlier"
                    theme={theme}
                    variant="secondary"
                />
            ) : null}
            {needsConnection ? (
                <Text
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-offline"
                >
                    {t('conversation.connectToLoadEarlier')}
                </Text>
            ) : null}
            {truncated ? (
                <Text
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-truncated"
                >
                    {t('conversation.earlierOnComputer')}
                </Text>
            ) : null}
            {isStartMarkerShown ? (
                <Text
                    style={[styles.historyText, { color: theme.muted }]}
                    testID="conversation-history-start"
                >
                    {t('conversation.startOfConversation')}
                </Text>
            ) : null}
            {error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.historyText, { color: theme.danger }]}
                    testID="conversation-history-error"
                >
                    {error}
                </Text>
            ) : null}
        </View>
    );
};
