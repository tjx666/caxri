import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MAX_AGENT_CHAT_IMAGES } from '@caxri/protocol';
import { ArrowUp, ArrowUpToLine, Paperclip, Square } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType, PRESSED_OPACITY } from '../../theme/scale';
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
    onUnsupported,
    provider,
    supportsImages,
    theme,
}: {
    canAdd: boolean;
    isEditable: boolean;
    onPress: () => void;
    /**
     * Receives the reason a provider without image support gives when its disabled button is tapped; the composer shows
     * it on its status line instead of in a system dialog.
     */
    onUnsupported: (reason: string) => void;
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
                    supportsImages ? undefined : () => onUnsupported(unsupportedReason)
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
 * The send area's shared shape while a turn runs: with Queue and Steer side by side, both are 52dp pills with a text
 * label, so neither reads as the odd one out. Kept compact (`sm` padding) so that, with attach stepped aside
 * (`agentChatComposerRowControls`), the input keeps at least about 60% of a 360dp phone's composer row.
 */
const pillStyles = StyleSheet.create({
    pill: {
        alignItems: 'center',
        borderRadius: mobileControl.primary / 2,
        height: mobileControl.primary,
        justifyContent: 'center',
        minWidth: mobileControl.primary,
        paddingHorizontal: mobileSpace.sm,
        // Overrides the round send button's fixed 52dp width, so the label sets the pill's width.
        width: 'auto',
    },
    outlined: { borderWidth: 1.5 },
    label: { ...mobileType.bodyStrong },
});

/**
 * Queues the draft for the end of the running turn, the visible route to what holding the composer's button does and
 * the phone's stand-in for Desktop's Cmd+Enter. Shown beside Steer only while a turn runs and there is a draft; it is
 * outlined so the filled Steer button stays the default, as Enter steers on Desktop (#2611).
 */
export const AgentChatQueueButton = ({
    onQueue,
    provider,
    theme,
}: {
    onQueue: () => Promise<void>;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <Pressable
            accessibilityHint={t('chat.composer.queueButtonHint', { provider })}
            accessibilityLabel={t('chat.composer.queueMessage')}
            accessibilityRole="button"
            onPress={() => {
                void onQueue();
            }}
            style={({ pressed }) => [
                pillStyles.pill,
                pillStyles.outlined,
                { borderColor: theme.primary, opacity: pressed ? PRESSED_OPACITY : 1 },
            ]}
            testID="agent-chat-composer-queue"
        >
            <Text style={[pillStyles.label, { color: theme.primary }]}>
                {t('chat.composer.queue')}
            </Text>
        </Pressable>
    );
};

/**
 * The composer's main button: Send, Steer during a turn, or Stop on an empty draft during a turn. Steer wears Desktop's
 * steer glyph (`ArrowUpToLine`) instead of the send arrow, so a tap visibly does something different mid-turn. Holding
 * it, or the screen reader's long-press action, queues the message for the turn's end instead; the Queue button beside
 * it is the visible route to the same result (`agentChatComposerPressDeliveries`).
 */
export const AgentChatComposerButton = ({
    canQueue,
    canSubmit,
    isBusy,
    isRunning,
    isStopAction,
    isStopping,
    onPress,
    onQueue,
    provider,
    theme,
}: {
    canQueue: boolean;
    canSubmit: boolean;
    isBusy: boolean;
    isRunning: boolean;
    isStopAction: boolean;
    isStopping: boolean;
    onPress: () => Promise<void>;
    onQueue: () => Promise<void>;
    provider: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const action = agentChatComposerButton({ isRunning, isStopAction, isStopping, provider }, t);
    const Icon = action.kind === 'stop' ? Square : isRunning ? ArrowUpToLine : ArrowUp;
    // A button that cannot act (offline, no access, an empty draft) drops the brand color for the neutral surface,
    // since a dimmed pink still read as enabled beside `Reconnect to send messages.`; busy keeps its color.
    const isDisabled = !canSubmit && !isBusy;
    // Steer beside Queue wears a text label in Queue's pill shape; every other state is the round icon button.
    const isSteerPill = canQueue && isRunning && action.kind === 'send';
    return (
        <Pressable
            accessibilityActions={
                canQueue ? [{ name: 'longpress', label: t('chat.composer.queueMessage') }] : []
            }
            accessibilityHint={
                canQueue ? t('chat.composer.holdToQueueHint', { provider }) : undefined
            }
            accessibilityLabel={action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit, busy: isBusy }}
            disabled={!canSubmit}
            onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === 'longpress') void onQueue();
            }}
            onLongPress={canQueue ? onQueue : undefined}
            onPress={onPress}
            style={[
                styles.sendButton,
                isSteerPill ? pillStyles.pill : null,
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
            ) : isSteerPill ? (
                <Text style={[pillStyles.label, { color: theme.primaryForeground }]}>
                    {t('chat.composer.steer')}
                </Text>
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
