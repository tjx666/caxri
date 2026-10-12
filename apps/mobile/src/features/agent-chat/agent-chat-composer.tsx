import { useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentProvider } from '@caxri/protocol';
import {
    agentChatDraftWithReturnedMessage,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
    parseAgentChatCommand,
    sentenceStartProvider,
} from '@caxri/protocol';
import * as Crypto from 'expo-crypto';
import { ArrowUp, CornerDownLeft, Paperclip, Square } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { ImageSourceSheet } from '../sessions/components/image-source-sheet';
import { SessionComposerAttachments } from '../sessions/components/session-composer-extras';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { useImageAttachments } from '../sessions/hooks/use-image-attachments';
import { imageAttachmentBudgetNote } from '../sessions/image-attachment-store';
import { AgentChatCommandList } from './agent-chat-command-list';
import { AgentChatComposerInput } from './agent-chat-composer-input';
import {
    agentChatComposerAvailability,
    agentChatComposerButton,
    agentChatComposerHint,
    agentChatComposerSubmission,
    agentChatDisabledReason,
    agentChatImagesUnsupportedReason,
    isAgentChatStopping,
} from './agent-chat-model';
import { AgentChatModelButton } from './agent-chat-model-sheet';
import { sendAgentChatMessageOptimistically } from './agent-chat-pending';
import { AgentChatPermissionButton } from './agent-chat-permission-sheet';
import { sheetStyles } from './agent-chat-sheet-styles';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatCommandRun } from './use-agent-chat-command-run';

/**
 * A Chat message's images, as many and as large in total as the protocol takes. The strip scrolls sideways, and an
 * image that would pass the combined limit is refused once prepared, in Desktop's words, before any of it uploads.
 */
const CHAT_IMAGE_LIMITS = {
    maxAttachments: MAX_AGENT_CHAT_IMAGES,
    maxTotal: {
        base64Length: MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
        message: `Images in one message must add up to ${MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES / 1_024 / 1_024} MB or less.`,
    },
    surface: 'chat',
    withThumbnail: true,
} as const;

/**
 * Runs the composer's one action (send, or Stop on an empty draft during a turn) and keeps its error state. A message
 * leaves the composer at once and shows as `Sending…` where it lands, as on Desktop (`agent-chat-pending.ts`); a failed
 * send puts its text and images back ahead of anything typed since. Stop stays pending, keyed by the turn it stopped,
 * until that turn ends, like the Desktop composer and the Terminal composer's "Stopping Agent…" state; the interrupt
 * request returning only means the provider was asked. A draft naming a listed slash command runs it instead of sending
 * (`useAgentChatCommandRun`).
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
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const [error, setError] = useState<string | null>(null);
    const isStopping = isAgentChatStopping(stoppingTurnId, activeTurnId);
    /**
     * What the user has typed by the time a send fails, so the returned message goes ahead of it.
     */
    const latestDraft = useRef(draft);
    useEffect(() => {
        latestDraft.current = draft;
    }, [draft]);
    const commands = useAgentChatCommandRun({ chat, onDraftChange, reportError: setError });
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
        const command = parseAgentChatCommand(draft, chat.snapshot?.commands);
        if (command) {
            await commands.run(command);
            return;
        }
        if (chat.pendingKey === null) return;
        const text = draft.trim();
        const sentImages = images.attachments;
        const references = images.readyChatImages;
        await sendAgentChatMessageOptimistically({
            clearComposer: () => {
                onDraftChange('');
                images.clear();
            },
            key: chat.pendingKey,
            message: {
                id: Crypto.randomUUID(),
                text,
                imageUris: sentImages.map((image) => image.uri),
                delivery,
            },
            reportError: setError,
            returnUnsent: () => {
                if (text)
                    onDraftChange(agentChatDraftWithReturnedMessage(latestDraft.current, text));
                images.restore(sentImages);
            },
            send: () => chat.send(text, references, delivery),
            snapshot: chat.snapshot,
        });
    };
    return {
        chooseCommand: commands.choose,
        error,
        isRunningCommand: commands.isRunning,
        isStopping,
        run,
    };
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

/**
 * A provider that cannot read images in a Chat (Grok Build) keeps the button, disabled, so the reader learns why
 * instead of wondering where attaching went.
 */
const AttachButton = ({
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
    const unsupportedReason = agentChatImagesUnsupportedReason(provider);
    return (
        <View style={styles.attachSlot}>
            <IconButton
                accessibilityHint={
                    !supportsImages
                        ? unsupportedReason
                        : canAdd
                          ? undefined
                          : `Up to ${MAX_AGENT_CHAT_IMAGES} images per message.`
                }
                accessibilityLabel="Attach image"
                color={theme.muted}
                disabled={!supportsImages || !isEditable || !canAdd}
                icon={Paperclip}
                onDisabledPress={
                    supportsImages
                        ? undefined
                        : () => Alert.alert("Images aren't available", unsupportedReason)
                }
                onPress={onPress}
                size={22}
                testID="agent-chat-attach-image"
                theme={theme}
            />
        </View>
    );
};

const steerStyles = StyleSheet.create({
    button: {
        alignItems: 'center',
        borderRadius: 26,
        borderWidth: 1.5,
        height: 52,
        justifyContent: 'center',
        paddingHorizontal: 14,
    },
    label: { fontSize: 15, fontWeight: '700' },
});

/**
 * Steers the running turn with the draft, the phone's visible stand-in for Desktop's ⌘Enter, shown beside Queue only
 * while a turn runs and there is a draft to steer with. It reads `Steer` like the queue card's action and Desktop's,
 * and is outlined so the filled Queue button stays the default.
 */
const AgentChatSteerButton = ({
    onSteer,
    provider,
    theme,
}: {
    onSteer: () => Promise<void>;
    provider: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityHint={`Adds this message to ${provider}'s running turn now instead of queuing it.`}
        accessibilityLabel="Steer now"
        accessibilityRole="button"
        onPress={() => {
            // eslint-disable-next-line no-void -- The composer reports a failed send itself.
            void onSteer();
        }}
        style={({ pressed }) => [
            steerStyles.button,
            { borderColor: theme.primary, opacity: pressed ? 0.7 : 1 },
        ]}
        testID="agent-chat-steer"
    >
        <Text style={[steerStyles.label, { color: theme.primary }]}>Steer</Text>
    </Pressable>
);

/**
 * The composer's one button: Send, Queue during a turn, or Stop on an empty draft during a turn. Queue wears Desktop's
 * queue glyph (`CornerDownLeft`) instead of the send arrow, so a tap visibly does something different mid-turn. Holding
 * it, or the screen reader's long-press action, still steers the running turn as a shortcut; the Steer button beside it
 * is the visible route to the same result.
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
    const Icon = action.kind === 'stop' ? Square : isRunning ? CornerDownLeft : ArrowUp;
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
 * The lines under the input: why the composer is disabled, a pending Stop, the steer hint, and a failed send or Stop.
 */
const AgentChatComposerStatus = ({
    error,
    hint,
    isStopping,
    provider,
    reason,
    theme,
}: {
    error: string | null;
    /**
     * From `agentChatComposerHint`: how to steer, shown only while no failure or Stop owns the line.
     */
    hint: string | undefined;
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
        {hint ? (
            <Text
                style={[styles.sendState, { color: theme.muted }]}
                testID="agent-chat-composer-hint"
            >
                {hint}
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
 * matching the Desktop composer. A message sent during a turn joins the follow-up queue, as Desktop's Enter does; the
 * Steer button beside it (or holding Queue) steers the running turn instead, the phone's stand-in for Desktop's
 * ⌘Enter.
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
    providerId,
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
    providerId: AgentProvider | undefined;
    /**
     * Uploaded images are scoped to the Chat's Session on the Server.
     */
    sessionId: string;
    supportsImages: boolean;
    theme: MobileTheme;
}) => {
    const images = useImageAttachments(sessionId, CHAT_IMAGE_LIMITS);
    const [isChoosingImage, setChoosingImage] = useState(false);
    const access = { deviceRole, isConnected, isHandedOff, snapshot: chat.snapshot };
    const availability = agentChatComposerAvailability(access);
    const activeTurnId = chat.snapshot?.activeTurnId;
    const isRunning = activeTurnId !== undefined;
    const hasDraft = draft.trim().length > 0 || images.attachments.length > 0;
    const canStop = isRunning && deviceRole === 'control';
    const isStopAction = canStop && !hasDraft;
    const { chooseCommand, error, isRunningCommand, isStopping, run } = useComposerAction({
        activeTurnId,
        chat,
        draft,
        images,
        isStopAction,
        onDraftChange,
        provider,
    });
    const isEditable = availability.isEnabled && !isRunningCommand;
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
    const canAttach = deviceRole === 'reply' || deviceRole === 'control';
    const statusReason =
        availability.reason ??
        images.waitReason ??
        imageAttachmentBudgetNote(
            images.attachments,
            MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
            MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
        ) ??
        undefined;
    return (
        <View
            style={[styles.composerBlock, { borderColor: theme.border }]}
            testID="agent-chat-composer"
        >
            <View style={sheetStyles.choices}>
                <AgentChatPermissionButton
                    chat={chat}
                    disabledReason={agentChatDisabledReason({ ...access, action: 'permission' })}
                    provider={providerId}
                    theme={theme}
                />
                <AgentChatModelButton
                    chat={chat}
                    disabledReason={agentChatDisabledReason({ ...access, action: 'configure' })}
                    theme={theme}
                />
            </View>
            <SessionComposerAttachments images={images} theme={theme} />
            <AgentChatCommandList
                commands={availability.isEnabled ? chat.snapshot?.commands : undefined}
                draft={draft}
                isEnabled={isEditable}
                onChoose={chooseCommand}
                theme={theme}
            />
            <View style={styles.composerRow}>
                {canAttach ? (
                    <AttachButton
                        canAdd={images.canAdd}
                        isEditable={isEditable}
                        onPress={() => setChoosingImage(true)}
                        provider={provider}
                        supportsImages={supportsImages}
                        theme={theme}
                    />
                ) : null}
                <AgentChatComposerInput
                    draft={draft}
                    focusComposer={focusComposer}
                    inputReference={inputReference}
                    isEditable={isEditable}
                    isRunning={isRunning}
                    onComposerFocused={onComposerFocused}
                    onDraftChange={onDraftChange}
                    provider={provider}
                    theme={theme}
                />
                {canSteer ? (
                    <AgentChatSteerButton onSteer={steer} provider={provider} theme={theme} />
                ) : null}
                <AgentChatComposerButton
                    canSteer={canSteer}
                    canSubmit={canSubmit}
                    isBusy={isStopping || isRunningCommand}
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
                hint={agentChatComposerHint({ canSteer, hasError: error !== null, isStopping })}
                isStopping={isStopping}
                provider={provider}
                reason={statusReason}
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
