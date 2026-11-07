import { Pressable, StyleSheet, Text } from 'react-native';

import { MAX_AGENT_CHAT_IMAGES } from '@caxri/protocol';
import { ArrowUp, ArrowUpToLine, Square } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType, PRESSED_OPACITY } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ComposerAddButton } from '../sessions/components/composer-add-button';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import type { AgentChatComposerButtonLook } from './agent-chat-composer-button-look';
import { agentChatComposerButtonLook } from './agent-chat-composer-button-look';
import { agentChatComposerButton } from './agent-chat-model';

/**
 * Opens the Chat's add sheet: attachment sources and the Chat's settings. Every provider takes files, so a provider
 * without image input (Grok Build) still gets the attachment tiles; its photos go as files. The sheet also holds the
 * settings, so the button stays usable whenever it has a row to show: at the attachment limit, offline, or without
 * reply access the sheet leaves out its tiles and still names the model and permission level.
 */
export const AddButton = ({
    isAtLimit,
    isEnabled,
    onPress,
    theme,
}: {
    /**
     * Every image or file slot is taken, so the sheet offers no tiles.
     */
    isAtLimit: boolean;
    isEnabled: boolean;
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <ComposerAddButton
            accessibilityHint={
                isAtLimit
                    ? t('chat.composer.imageLimit', { count: MAX_AGENT_CHAT_IMAGES })
                    : undefined
            }
            accessibilityLabel={t('chat.composer.add')}
            disabled={!isEnabled}
            onPress={onPress}
            testID="agent-chat-attach-image"
            theme={theme}
        />
    );
};

/**
 * The send area's shared shape while a turn runs: with Queue and Steer side by side, both are pills with a text label
 * at the round send button's height, so neither reads as the odd one out.
 */
const pillStyles = StyleSheet.create({
    pill: {
        paddingHorizontal: mobileSpace.md,
        // Overrides the round send button's fixed width, so the label sets the pill's width.
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
                styles.sendButton,
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

const composerButtonBackground: Record<
    AgentChatComposerButtonLook['background'],
    (theme: MobileTheme) => string
> = {
    danger: (theme) => theme.danger,
    neutral: (theme) => theme.elevated,
    primary: (theme) => theme.primary,
};

const composerButtonIcon = { send: ArrowUp, steer: ArrowUpToLine, stop: Square } as const;

/**
 * What the main button shows inside: a spinner while busy, the Steer label in its pill, otherwise the state's glyph.
 */
const ComposerButtonContent = ({
    isBusy,
    look,
    theme,
}: {
    isBusy: boolean;
    look: AgentChatComposerButtonLook;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (isBusy) return <Spinner color={theme.primaryForeground} />;
    if (look.isSteerPill)
        return (
            <Text style={[pillStyles.label, { color: theme.primaryForeground }]}>
                {t('chat.composer.steer')}
            </Text>
        );
    const Icon = composerButtonIcon[look.icon];
    return (
        <Icon
            color={look.isDisabled ? theme.muted : theme.primaryForeground}
            size={20}
            strokeWidth={2.5}
        />
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
    const look = agentChatComposerButtonLook({
        canQueue,
        canSubmit,
        isBusy,
        isRunning,
        kind: action.kind,
    });
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
            hitSlop={4}
            onPress={onPress}
            style={[
                styles.sendButton,
                look.isSteerPill ? pillStyles.pill : null,
                {
                    backgroundColor: composerButtonBackground[look.background](theme),
                    opacity: look.isDisabled ? 0.7 : 1,
                },
            ]}
            testID={action.testID}
        >
            <ComposerButtonContent isBusy={isBusy} look={look} theme={theme} />
        </Pressable>
    );
};
