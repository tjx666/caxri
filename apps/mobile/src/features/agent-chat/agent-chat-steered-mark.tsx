/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import { CornerDownRight } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { AgentChatHintMark } from './agent-chat-hint-mark';

/**
 * Desktop's quiet ↳ beside a message steered into a running turn, so the mark adds no line under the message. Tapping
 * it says what it means, as hovering does on Desktop.
 */
export const AgentChatSteeredMark = ({ theme }: { theme: MobileTheme }) => {
    const { t } = useTranslation();
    return (
        <View style={styles.root}>
            <AgentChatHintMark
                hint={t('chat.steeredHint')}
                testID="agent-chat-steered"
                theme={theme}
            >
                <CornerDownRight color={theme.muted} size={15} />
            </AgentChatHintMark>
        </View>
    );
};

const styles = StyleSheet.create({
    // Level with the bubble's first line of text.
    root: { flexShrink: 1, paddingTop: 13 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
