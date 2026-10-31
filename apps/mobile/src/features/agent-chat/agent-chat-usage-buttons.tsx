/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '../../components/button';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import type { AgentChatUsageAction, AgentChatUsageButton } from './agent-chat-usage-actions';

/**
 * A usage card's buttons, wrapping onto a second line on a narrow phone. While this device cannot act (no reply access,
 * offline) every button is disabled and the reason sits beneath them, so a disabled button never stands unexplained.
 */
export const AgentChatUsageButtons = ({
    blockedReason,
    buttons,
    onPress,
    pending,
    provider,
    testID,
    theme,
}: {
    blockedReason: string | undefined;
    buttons: readonly AgentChatUsageButton[];
    onPress: (action: AgentChatUsageAction) => void;
    pending: AgentChatUsageAction | undefined;
    /**
     * The Agent's name, for the hints that say whose allowance an action spends.
     */
    provider: string;
    testID: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (buttons.length === 0) return null;
    return (
        <View style={styles.root}>
            <View style={styles.row}>
                {buttons.map((button) => (
                    <Button
                        accessibilityHint={button.hint ? t(button.hint, { provider }) : undefined}
                        isBusy={pending === button.action}
                        isDisabled={
                            blockedReason !== undefined ||
                            (pending !== undefined && pending !== button.action)
                        }
                        key={button.action}
                        label={t(button.label)}
                        onPress={() => onPress(button.action)}
                        testID={`${testID}-${button.action}`}
                        theme={theme}
                        variant={button.isPrimary ? 'primary' : 'outline'}
                    />
                ))}
            </View>
            {blockedReason ? (
                <Text style={[styles.reason, { color: theme.muted }]} testID={`${testID}-blocked`}>
                    {blockedReason}
                </Text>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { gap: mobileSpace.xs },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: mobileSpace.sm },
    reason: mobileType.caption,
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
