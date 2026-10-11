import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { ArrowUp, Paperclip, Square } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { ImageSourceSheet } from '../sessions/components/image-source-sheet';
import { SessionComposerAttachments } from '../sessions/components/session-composer-extras';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { useImageAttachments } from '../sessions/hooks/use-image-attachments';
import {
    agentChatComposerAvailability,
    agentChatComposerButton,
    agentChatComposerSubmission,
    agentChatDisabledReason,
    isAgentChatStopping,
    sentenceStartProvider,
} from './agent-chat-model';
import { AgentChatModelButton } from './agent-chat-model-sheet';
import type { AgentChatController } from './use-agent-chat';

/**
 * The phone keeps its own cap below the protocol's `MAX_AGENT_CHAT_IMAGES`: the attachment strip is a single
 * non-scrolling row sized for four thumbnails, so more would overflow off screen.
 */
const MOBILE_CHAT_MAX_IMAGES = 4;

/**
 * Runs the composer's one action (send, or Stop on an empty draft during a turn) and keeps its busy and error state.
 * Stop stays pending, keyed by the turn it stopped, until that turn ends, like the Desktop composer and the Terminal
 * composer's "Stopping Agent…" state; the interrupt request returning only means the provider was asked.
 */
const useComposerAction = ({
    activeTurnId,
    chat,
    draft,
    images,
    isStopAction,
    onDraftChange,
    provider,
}: {
    activeTurnId: string | undefined;
    chat: AgentChatController;
    draft: string;
    images: ReturnType<typeof useImageAttachments>;
    isStopAction: boolean;
    onDraftChange: (draft: string) => void;
    provider: string;
}) => {
    const [isSending, setSending] = useState(false);
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const [error, setError] = useState<string | null>(null);
    const isStopping = isAgentChatStopping(stoppingTurnId, activeTurnId);
    const run = async (delivery?: 'steer'): Promise<void> => {
        setError(null);
        if (isStopAction) {
            if (!activeTurnId || isStopping) return;
            setStoppingTurnId(activeTurnId);
            try {
                await chat.interrupt();
            } catch {
                setStoppingTurnId(undefined);
                setError(`${sentenceStartProvider(provider)} could not be stopped. Try again.`);
            }
            return;
        }
        setSending(true);
        try {
            await chat.send(draft.trim(), images.readyChatImages, delivery);
            onDraftChange('');
            images.clear();
        } catch {
            setError('Your message was not sent. Try again.');
        } finally {
            setSending(false);
        }
    };
    return { error, isSending, isStopping, run };
};

/**
 * Focuses the input once when the Session asks for it (a notification reply), as the Terminal composer does.
 */
const useFocusRequest = ({
    focusComposer,
    isEditable,
    isVisible,
    onComposerFocused,
}: {
    focusComposer?: boolean;
    isEditable: boolean;
    isVisible: boolean;
    onComposerFocused?: () => void;
}) => {
    const inputReference = useRef<TextInput>(null);
    useEffect(() => {
        if (!focusComposer || !isVisible || !isEditable || !inputReference.current) return;
        inputReference.current.focus();
        if (inputReference.current.isFocused()) onComposerFocused?.();
    }, [focusComposer, isEditable, isVisible, onComposerFocused]);
    return inputReference;
};

const AttachButton = ({
    canAdd,
    isEditable,
    onPress,
    theme,
}: {
    canAdd: boolean;
    isEditable: boolean;
    onPress: () => void;
    theme: MobileTheme;
}) => (
    <IconButton
        accessibilityHint={
            canAdd ? undefined : `Up to ${MOBILE_CHAT_MAX_IMAGES} images per message.`
        }
        accessibilityLabel="Attach image"
        color={theme.muted}
        disabled={!isEditable || !canAdd}
        icon={Paperclip}
        onPress={onPress}
        size={22}
        testID="agent-chat-attach-image"
        theme={theme}
    />
);

/**
 * The composer's one button: Send (or Queue during a turn), or Stop on an empty draft during a turn. Holding it, or the
 * screen reader's long-press action, steers the running turn when there is a draft to steer with.
 */
const AgentChatComposerButton = ({
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
    const action = agentChatComposerButton({ isRunning, isStopAction, isStopping, provider });
    const Icon = action.kind === 'stop' ? Square : ArrowUp;
    return (
        <Pressable
            accessibilityActions={canSteer ? [{ name: 'longpress', label: 'Steer now' }] : []}
            accessibilityHint={
                canSteer ? `Hold to steer ${provider}'s current turn now.` : undefined
            }
            accessibilityLabel={action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit, busy: isBusy }}
            disabled={!canSubmit}
            onAccessibilityAction={({ nativeEvent }) => {
                // eslint-disable-next-line no-void -- The composer reports a failed send itself.
                if (nativeEvent.actionName === 'longpress') void onSteer();
            }}
            onLongPress={canSteer ? onSteer : undefined}
            onPress={onPress}
            style={[
                styles.sendButton,
                {
                    backgroundColor: action.kind === 'stop' ? theme.danger : theme.primary,
                    opacity: canSubmit || isBusy ? 1 : 0.38,
                },
            ]}
            testID={action.testID}
        >
            {isBusy ? (
                <ActivityIndicator color={theme.primaryForeground} />
            ) : (
                <Icon color={theme.primaryForeground} size={20} strokeWidth={2.5} />
            )}
        </Pressable>
    );
};

/**
 * The lines under the input: why the composer is disabled, a pending Stop, and a failed send or Stop.
 */
const AgentChatComposerStatus = ({
    error,
    isStopping,
    provider,
    reason,
    theme,
}: {
    error: string | null;
    isStopping: boolean;
    provider: string;
    reason: string | undefined;
    theme: MobileTheme;
}) => (
    <>
        {/* `reason` flexes along the meta row; placed directly in the column block it collapses to zero height. */}
        {reason ? (
            <View style={styles.composerMeta}>
                <Text
                    style={[styles.reason, { color: theme.muted }]}
                    testID="agent-chat-composer-reason"
                >
                    {reason}
                </Text>
            </View>
        ) : null}
        {isStopping ? (
            <Text
                accessibilityLiveRegion="polite"
                style={[styles.sendState, { color: theme.muted }]}
                testID="agent-chat-composer-stopping"
            >
                {`Stopping ${provider}…`}
            </Text>
        ) : null}
        {error ? (
            <Text
                accessibilityRole="alert"
                style={[styles.sendState, { color: theme.danger }]}
                testID="agent-chat-composer-error"
            >
                {error}
            </Text>
        ) : null}
    </>
);

/**
 * Sends a message to a Chat. While a turn runs, a control device gets Stop in place of Send when the draft is empty,
 * matching the Desktop composer. A message sent during a turn joins the follow-up queue, as Desktop's Enter does;
 * holding Send steers the running turn instead, the phone's stand-in for Desktop's ⌘Enter.
 */
export const AgentChatComposer = ({
    chat,
    deviceRole,
    draft,
    focusComposer,
    isConnected,
    isHandedOff,
    isVisible,
    onComposerFocused,
    onDraftChange,
    provider,
    sessionId,
    supportsImages,
    theme,
}: {
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    focusComposer?: boolean;
    isConnected: boolean;
    /**
     * A detached Chat refuses input until its Session resumes; its banner says so and the composer only disables.
     */
    isHandedOff: boolean;
    isVisible: boolean;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    provider: string;
    /**
     * Uploaded images are scoped to the Chat's Session on the Server.
     */
    sessionId: string;
    supportsImages: boolean;
    theme: MobileTheme;
}) => {
    const images = useImageAttachments(sessionId, {
        maxAttachments: MOBILE_CHAT_MAX_IMAGES,
        withThumbnail: true,
    });
    const [isChoosingImage, setChoosingImage] = useState(false);
    const access = { deviceRole, isConnected, isHandedOff, snapshot: chat.snapshot };
    const availability = agentChatComposerAvailability(access);
    const activeTurnId = chat.snapshot?.activeTurnId;
    const isRunning = activeTurnId !== undefined;
    const hasDraft = draft.trim().length > 0 || images.attachments.length > 0;
    const canStop = isRunning && deviceRole === 'control';
    const isStopAction = canStop && !hasDraft;
    const { error, isSending, isStopping, run } = useComposerAction({
        activeTurnId,
        chat,
        draft,
        images,
        isStopAction,
        onDraftChange,
        provider,
    });
    const isEditable = !isSending && availability.isEnabled;
    const inputReference = useFocusRequest({
        focusComposer,
        isEditable,
        isVisible,
        onComposerFocused,
    });
    const { canSteer, canSubmit } = agentChatComposerSubmission({
        // A message waits for its images to finish uploading, as the Terminal composer does.
        hasDraft: hasDraft && !images.hasUnsentAttachment,
        isEditable,
        isRunning,
        isStopAction,
        isStopping,
    });
    const submit = async (): Promise<void> => {
        if (canSubmit) await run();
    };
    const steer = async (): Promise<void> => {
        if (canSteer) await run('steer');
    };
    const canAttach = supportsImages && (deviceRole === 'reply' || deviceRole === 'control');
    return (
        <View
            style={[styles.composerBlock, { borderColor: theme.border }]}
            testID="agent-chat-composer"
        >
            <AgentChatModelButton
                chat={chat}
                disabledReason={agentChatDisabledReason({ ...access, action: 'configure' })}
                theme={theme}
            />
            <SessionComposerAttachments images={images} theme={theme} />
            <View style={styles.composerRow}>
                {canAttach ? (
                    <AttachButton
                        canAdd={images.canAdd}
                        isEditable={isEditable}
                        onPress={() => setChoosingImage(true)}
                        theme={theme}
                    />
                ) : null}
                <TextInput
                    accessibilityHint={`Return inserts a new line. Use ${isRunning ? 'Queue' : 'Send'} message to submit.`}
                    accessibilityLabel={`Message ${provider}`}
                    editable={isEditable}
                    multiline
                    numberOfLines={6}
                    onChangeText={onDraftChange}
                    onFocus={() => {
                        if (focusComposer) onComposerFocused?.();
                    }}
                    ref={inputReference}
                    placeholder={
                        isRunning ? 'Queue a follow-up (hold Send to steer)' : `Message ${provider}`
                    }
                    placeholderTextColor={theme.muted}
                    scrollEnabled
                    submitBehavior="newline"
                    style={[
                        styles.composer,
                        {
                            backgroundColor: theme.surface,
                            borderColor: theme.border,
                            color: theme.text,
                        },
                    ]}
                    testID="agent-chat-composer-input"
                    textAlignVertical="top"
                    value={draft}
                />
                <AgentChatComposerButton
                    canSteer={canSteer}
                    canSubmit={canSubmit}
                    isBusy={isSending || isStopping}
                    isRunning={isRunning}
                    isStopAction={isStopAction}
                    isStopping={isStopping}
                    onPress={submit}
                    onSteer={steer}
                    provider={provider}
                    theme={theme}
                />
            </View>
            <AgentChatComposerStatus
                error={error}
                isStopping={isStopping}
                provider={provider}
                reason={availability.reason}
                theme={theme}
            />
            {isChoosingImage ? (
                <ImageSourceSheet
                    onClose={() => setChoosingImage(false)}
                    onPick={(source) => {
                        // eslint-disable-next-line no-void -- The hook reports attach failures itself.
                        void images.add(source);
                    }}
                    theme={theme}
                />
            ) : null}
        </View>
    );
};
