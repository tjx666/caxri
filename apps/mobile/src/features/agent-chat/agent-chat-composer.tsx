import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { ArrowUp, Paperclip, Square } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { ImageSourceSheet } from '../sessions/components/image-source-sheet';
import { SessionComposerAttachments } from '../sessions/components/session-composer-extras';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { useImageAttachments } from '../sessions/hooks/use-image-attachments';
import { agentChatDisabledReason } from './agent-chat-model';
import { AgentChatModelButton } from './agent-chat-model-sheet';
import type { AgentChatController } from './use-agent-chat';

/**
 * The phone keeps its own cap below the protocol's `MAX_AGENT_CHAT_IMAGES`: the attachment strip is a single
 * non-scrolling row sized for four thumbnails, so more would overflow off screen.
 */
const MOBILE_CHAT_MAX_IMAGES = 4;

/**
 * Runs the composer's one action (send, or Stop on an empty draft during a turn) and keeps its busy and error state.
 */
const useComposerAction = ({
    chat,
    draft,
    images,
    isStopAction,
    onDraftChange,
    provider,
}: {
    chat: AgentChatController;
    draft: string;
    images: ReturnType<typeof useImageAttachments>;
    isStopAction: boolean;
    onDraftChange: (draft: string) => void;
    provider: string;
}) => {
    const [isBusy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const run = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            if (isStopAction) await chat.interrupt();
            else {
                await chat.send(draft.trim(), images.readyChatImages);
                onDraftChange('');
                images.clear();
            }
        } catch {
            setError(
                isStopAction
                    ? `${provider} could not be stopped. Try again.`
                    : 'Your message was not sent. Try again.',
            );
        } finally {
            setBusy(false);
        }
    };
    return { error, isBusy, run };
};

const composerAction = (isStopAction: boolean, provider: string, theme: MobileTheme) =>
    isStopAction
        ? {
              Icon: Square,
              color: theme.danger,
              label: `Stop ${provider}`,
              testID: 'agent-chat-composer-stop',
          }
        : {
              Icon: ArrowUp,
              color: theme.primary,
              label: 'Send message',
              testID: 'agent-chat-composer-send',
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
 * Why the composer is disabled, and the last send or stop failure.
 */
const ComposerNotes = ({
    disabledReason,
    error,
    theme,
}: {
    disabledReason: string | undefined;
    error: string | null;
    theme: MobileTheme;
}) => (
    <>
        {/* `reason` flexes along the meta row; placed directly in the column block it collapses to zero height. */}
        {disabledReason ? (
            <View style={styles.composerMeta}>
                <Text
                    style={[styles.reason, { color: theme.muted }]}
                    testID="agent-chat-composer-reason"
                >
                    {disabledReason}
                </Text>
            </View>
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
 * matching the Desktop composer; a message typed during a turn steers it.
 */
export const AgentChatComposer = ({
    chat,
    deviceRole,
    draft,
    isConnected,
    isHandedOff,
    onDraftChange,
    provider,
    sessionId,
    supportsImages,
    theme,
}: {
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: string;
    isConnected: boolean;
    /**
     * A detached Chat refuses input until its Session resumes, so the composer says so instead of failing a send.
     */
    isHandedOff: boolean;
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
    const disabledReason = agentChatDisabledReason(access);
    const isRunning = Boolean(chat.snapshot?.activeTurnId);
    const hasDraft = draft.trim().length > 0 || images.attachments.length > 0;
    const isStopAction = isRunning && deviceRole === 'control' && !hasDraft;
    const { error, isBusy, run } = useComposerAction({
        chat,
        draft,
        images,
        isStopAction,
        onDraftChange,
        provider,
    });
    const isEditable = !isBusy && disabledReason === undefined;
    // A message waits for its images to finish uploading, as the Terminal composer does.
    const canSubmit = isEditable && (isStopAction || (hasDraft && !images.hasUnsentAttachment));
    const canAttach = supportsImages && (deviceRole === 'reply' || deviceRole === 'control');
    const submit = async (): Promise<void> => {
        if (canSubmit) await run();
    };
    const action = composerAction(isStopAction, provider, theme);
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
                    accessibilityHint="Return inserts a new line. Use Send message to submit."
                    accessibilityLabel={`Message ${provider}`}
                    editable={isEditable}
                    multiline
                    numberOfLines={6}
                    onChangeText={onDraftChange}
                    placeholder={
                        isRunning ? `Steer ${provider}'s current turn` : `Message ${provider}`
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
                <Pressable
                    accessibilityLabel={action.label}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canSubmit, busy: isBusy }}
                    disabled={!canSubmit}
                    onPress={submit}
                    style={[
                        styles.sendButton,
                        {
                            backgroundColor: action.color,
                            opacity: canSubmit ? 1 : 0.38,
                        },
                    ]}
                    testID={action.testID}
                >
                    {isBusy ? (
                        <ActivityIndicator color={theme.primaryForeground} />
                    ) : (
                        <action.Icon color={theme.primaryForeground} size={20} strokeWidth={2.5} />
                    )}
                </Pressable>
            </View>
            <ComposerNotes disabledReason={disabledReason} error={error} theme={theme} />
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
