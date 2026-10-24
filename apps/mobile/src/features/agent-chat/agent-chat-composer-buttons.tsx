import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { MAX_AGENT_CHAT_IMAGES } from '@caxri/protocol';
import { ArrowUp, CornerDownLeft, Paperclip, Square } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { agentChatComposerButton, agentChatImagesUnsupportedReason } from './agent-chat-model';

/**
 * A provider that cannot read images in a Chat (Grok Build) keeps the button, disabled, so the reader learns why
 * instead of wondering where attaching went.
 */
export const AttachButton = ({
    canAdd,
    isEditable,
    onPress,
    provider,
    supportsImages,
    theme,
}: {
    canAdd: boolean;
    isEditable: boolean;
    onPress: () => void;
    provider: string;
    supportsImages: boolean;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const unsupportedReason = agentChatImagesUnsupportedReason(provider, t);
    return (
        <View style={styles.attachSlot}>
            <IconButton
                accessibilityHint={
                    !supportsImages
                        ? unsupportedReason
                        : canAdd
                          ? undefined
                          : t('chat.composer.imageLimit', { count: MAX_AGENT_CHAT_IMAGES })
                }
                accessibilityLabel={t('chat.composer.attachImage')}
                color={theme.muted}
                disabled={!supportsImages || !isEditable || !canAdd}
                icon={Paperclip}
                onDisabledPress={
                    supportsImages
                        ? undefined
                        : () => Alert.alert(t('chat.composer.imagesUnavailable'), unsupportedReason)
                }
                onPress={onPress}
                size={22}
                testID="agent-chat-attach-image"
                theme={theme}
            />
        </View>
    );
};

/**
 * A compact outlined pill: with Queue beside it and attach stepped aside (`agentChatComposerRowControls`), the input
 * keeps at least about 60% of a 360dp phone's composer row.
 */
const steerStyles = StyleSheet.create({
    button: {
        alignItems: 'center',
        borderRadius: 26,
        borderWidth: 1.5,
        height: 52,
        justifyContent: 'center',
        minWidth: 52,
        paddingHorizontal: 9,
    },
    label: { fontSize: 14, fontWeight: '700' },
});

/**
 * Steers the running turn with the draft, the phone's visible stand-in for Desktop's ⌘Enter, shown beside Queue only
 * while a turn runs and there is a draft to steer with. It reads `Steer` like the queue card's action and Desktop's,
 * and is outlined so the filled Queue button stays the default.
 */
export const AgentChatSteerButton = ({
    onSteer,
    provider,
    theme,
}: {
    onSteer: () => Promise<void>;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityHint={t('chat.composer.steerButtonHint', { provider })}
            accessibilityLabel={t('chat.queue.steerNow')}
            accessibilityRole="button"
            onPress={() => {
                void onSteer();
            }}
            style={({ pressed }) => [
                steerStyles.button,
                { borderColor: theme.primary, opacity: pressed ? 0.7 : 1 },
            ]}
            testID="agent-chat-steer"
        >
            <Text style={[steerStyles.label, { color: theme.primary }]}>
                {t('chat.composer.steer')}
            </Text>
        </Pressable>
    );
};

/**
 * The composer's one button: Send, Queue during a turn, or Stop on an empty draft during a turn. Queue wears Desktop's
 * queue glyph (`CornerDownLeft`) instead of the send arrow, so a tap visibly does something different mid-turn. Holding
 * it, or the screen reader's long-press action, still steers the running turn as a shortcut; the Steer button beside it
 * is the visible route to the same result.
 */
export const AgentChatComposerButton = ({
    canSteer,
    canSubmit,
    isBusy,
    isRunning,
    isStopAction,
    isStopping,
    onPress,
    onSteer,
    provider,
    theme,
}: {
    canSteer: boolean;
    canSubmit: boolean;
    isBusy: boolean;
    isRunning: boolean;
    isStopAction: boolean;
    isStopping: boolean;
    onPress: () => Promise<void>;
    onSteer: () => Promise<void>;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const action = agentChatComposerButton({ isRunning, isStopAction, isStopping, provider }, t);
    const Icon = action.kind === 'stop' ? Square : isRunning ? CornerDownLeft : ArrowUp;
    // A button that cannot act (offline, no access, an empty draft) drops the brand color for the neutral surface,
    // since a dimmed pink still read as enabled beside `Reconnect to send messages.`; busy keeps its color.
    const isDisabled = !canSubmit && !isBusy;
    return (
        <Pressable
            accessibilityActions={
                canSteer ? [{ name: 'longpress', label: t('chat.queue.steerNow') }] : []
            }
            accessibilityHint={
                canSteer ? t('chat.composer.holdToSteerHint', { provider }) : undefined
            }
            accessibilityLabel={action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit, busy: isBusy }}
            disabled={!canSubmit}
            onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === 'longpress') void onSteer();
            }}
            onLongPress={canSteer ? onSteer : undefined}
            onPress={onPress}
            style={[
                styles.sendButton,
                {
                    backgroundColor: isDisabled
                        ? theme.elevated
                        : action.kind === 'stop'
                          ? theme.danger
                          : theme.primary,
                    opacity: isDisabled ? 0.7 : 1,
                },
            ]}
            testID={action.testID}
        >
            {isBusy ? (
                <Spinner color={theme.primaryForeground} />
            ) : (
                <Icon
                    color={isDisabled ? theme.muted : theme.primaryForeground}
                    size={20}
                    strokeWidth={2.5}
                />
            )}
        </Pressable>
    );
};
