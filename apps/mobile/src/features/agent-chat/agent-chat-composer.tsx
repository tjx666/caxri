import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';

import type { AgentAction, AgentProvider } from '@caxri/protocol';
import {
    agentChatDraftWithReturnedMessage,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
    parseAgentChatCommand,
    sentenceStartProvider,
} from '@caxri/protocol';
import * as Crypto from 'expo-crypto';

import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ImageSourceSheet } from '../sessions/components/image-source-sheet';
import { SessionComposerAttachments } from '../sessions/components/session-composer-extras';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { useImageAttachments } from '../sessions/hooks/use-image-attachments';
import { imageAttachmentBudgetNote } from '../sessions/image-attachment-store';
import { AgentChatCommandList } from './agent-chat-command-list';
import {
    agentChatMenuMatches,
    agentChatSkillNotice,
    shouldHoldAgentChatSendAsText,
} from './agent-chat-commands';
import {
    AgentChatComposerButton,
    AgentChatQueueButton,
    AttachButton,
} from './agent-chat-composer-buttons';
import { AgentChatComposerInput } from './agent-chat-composer-input';
import { AgentChatEditBanner } from './agent-chat-edit-banner';
import {
    agentChatComposerAvailability,
    agentChatComposerPressDeliveries,
    agentChatComposerRowControls,
    agentChatComposerSubmission,
    agentChatDisabledReason,
    isAgentChatStopping,
} from './agent-chat-model';
import { sendAgentChatMessageOptimistically } from './agent-chat-pending';
import { AgentChatPlanPaceNotice } from './agent-chat-plan-pace-notice';
import { AgentChatSessionUsageButton } from './agent-chat-session-usage-sheet';
import { AgentChatSettings } from './agent-chat-settings';
import { sheetStyles } from './agent-chat-sheet-styles';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatCommandRun } from './use-agent-chat-command-run';
import { useAgentChatSkills } from './use-agent-chat-skills';
import { useTransientNotice } from './use-transient-notice';

/**
 * A Chat message's images, as many and as large in total as the protocol takes. The strip scrolls sideways, and an
 * image that would pass the combined limit is refused once prepared, in Desktop's words, before any of it uploads.
 */
const chatImageLimits = (t: Translate) =>
    ({
        maxAttachments: MAX_AGENT_CHAT_IMAGES,
        maxTotal: {
            base64Length: MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
            message: t('chat.composer.imagesTotalLimit', {
                size: MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES / 1_024 / 1_024,
            }),
        },
        surface: 'chat',
        withThumbnail: true,
    }) as const;

/**
 * Runs the composer's one action (send, or Stop on an empty draft during a turn) and keeps its error state. A message
 * leaves the composer at once and shows as `Sending…` where it lands, as on Desktop (`agent-chat-pending.ts`); a failed
 * send puts its text and images back ahead of anything typed since. Stop stays pending, keyed by the turn it stopped,
 * until that turn ends, like the Desktop composer and the Terminal composer's "Stopping Agent…" state; the interrupt
 * request returning only means the provider was asked. A draft naming a listed slash command runs it instead of sending
 * (`useAgentChatCommandRun`); a bare `/word` the menu has no row for is held once, as Desktop's first Enter is, and a
 * second tap on the same draft sends it as text (`shouldHoldAgentChatSendAsText`).
 */
const useComposerAction = ({
    activeTurnId,
    chat,
    draft,
    images,
    isStopAction,
    menuMatches,
    onDraftChange,
    provider,
}: {
    activeTurnId: string | undefined;
    chat: AgentChatController;
    draft: string;
    images: ReturnType<typeof useImageAttachments>;
    isStopAction: boolean;
    /**
     * The command menu's rows for `draft` (`agentChatMenuMatches`).
     */
    menuMatches: readonly AgentAction[] | undefined;
    onDraftChange: (draft: string) => void;
    provider: string;
}) => {
    const { t } = useTranslation();
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const [error, setError] = useState<string | null>(null);
    const [isSendingEdit, setSendingEdit] = useState(false);
    /**
     * The draft a first tap was held for because no command matches it. Any edit ends the confirmation; reset during
     * render, as Desktop's command menu does.
     */
    const [confirmedDraft, setConfirmedDraft] = useState<string>();
    if (confirmedDraft !== undefined && confirmedDraft !== draft) setConfirmedDraft(undefined);
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
                setError(
                    t('chat.composer.stopFailed', { provider: sentenceStartProvider(provider) }),
                );
            }
            return;
        }
        /**
         * An edit sends its text as the replacement message, never as a command. It shows at once as a pending row
         * while the message it replaces and everything after it leave the timeline (`replaces`); the composer gets back
         * the draft the edit held. A failed edit brings the old content back and puts the edit, with its text, back.
         */
        const edit = chat.editing;
        if (edit) {
            if (chat.pendingKey === null) return;
            const text = draft.trim();
            setSendingEdit(true);
            try {
                await sendAgentChatMessageOptimistically({
                    clearComposer: () => {
                        chat.setEditing(undefined);
                        onDraftChange(edit.previousDraft);
                    },
                    key: chat.pendingKey,
                    message: {
                        id: Crypto.randomUUID(),
                        text,
                        imageUris: [],
                        delivery: undefined,
                        replaces: edit.itemId,
                    },
                    reportError: (message) =>
                        setError(message === null ? null : t('chat.edit.failed')),
                    returnUnsent: () => {
                        chat.setEditing(edit);
                        onDraftChange(text);
                    },
                    send: () => chat.rewind(edit.itemId, text),
                    snapshot: chat.snapshot,
                });
            } finally {
                setSendingEdit(false);
            }
            return;
        }
        if (shouldHoldAgentChatSendAsText({ confirmedDraft, draft, matches: menuMatches })) {
            setConfirmedDraft(draft);
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
        confirmsSendAsText: confirmedDraft === draft,
        error,
        isRunningCommand: commands.isRunning,
        isSendingEdit,
        isStopping,
        run,
    };
};

/**
 * The composer menu's rows and skill status for the draft: the provider's commands plus the skills the Server finds for
 * the Chat's Terminal, as on Desktop. Nothing shows while the composer cannot send.
 */
const useComposerMenu = ({
    chat,
    draft,
    isEnabled,
    sessionId,
}: {
    chat: AgentChatController;
    draft: string;
    isEnabled: boolean;
    sessionId: string;
}) => {
    const { t } = useTranslation();
    const skills = useAgentChatSkills({
        draft,
        isEnabled,
        sessionId,
        terminalId: chat.snapshot?.terminalId,
    });
    if (!isEnabled) return { matches: undefined, notice: undefined };
    return {
        matches: agentChatMenuMatches(draft, chat.snapshot?.commands, skills.skills),
        notice: agentChatSkillNotice(skills, t),
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
    const inputReference = useRef<TextInputInstance>(null);
    useEffect(() => {
        if (!focusComposer || !isVisible || !isEditable || !inputReference.current) return;
        inputReference.current.focus();
        if (inputReference.current.isFocused()) onComposerFocused?.();
    }, [focusComposer, isEditable, isVisible, onComposerFocused]);
    return inputReference;
};

/**
 * The lines under the input, the composer's one place for explanations: why the composer or a control is disabled
 * (muted), a pending Stop, and a failed send, Stop, or image attach (danger). Nothing here opens a system dialog.
 */
const statusStyles = StyleSheet.create({
    line: { ...mobileType.meta },
});

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
}) => {
    const { t } = useTranslation();
    return (
        <>
            {reason ? (
                <Text
                    style={[statusStyles.line, { color: theme.muted }]}
                    testID="agent-chat-composer-reason"
                >
                    {reason}
                </Text>
            ) : null}
            {isStopping ? (
                <Text
                    accessibilityLiveRegion="polite"
                    style={[statusStyles.line, { color: theme.muted }]}
                    testID="agent-chat-composer-stopping"
                >
                    {t('chat.composer.stopping', { provider })}
                </Text>
            ) : null}
            {error ? (
                <Text
                    accessibilityRole="alert"
                    style={[statusStyles.line, { color: theme.danger }]}
                    testID="agent-chat-composer-error"
                >
                    {error}
                </Text>
            ) : null}
        </>
    );
};

/**
 * Sends a message to a Chat. While a turn runs, a control device gets Stop in place of Send when the draft is empty,
 * matching the Desktop composer. A message sent during a turn steers it, as Desktop's Enter does; the Queue button
 * beside it (or holding Steer) queues it for the turn's end instead, the phone's stand-in for Desktop's ⌘Enter.
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
    const { t } = useTranslation();
    const imageLimits = useMemo(() => chatImageLimits(t), [t]);
    const images = useImageAttachments(sessionId, imageLimits);
    const [isChoosingImage, setChoosingImage] = useState(false);
    /**
     * Why a disabled attach button cannot attach, shown on the status line for a few seconds after a tap on it.
     */
    const [attachNotice, showAttachNotice] = useTransientNotice();
    const access = { deviceRole, isConnected, isHandedOff, snapshot: chat.snapshot };
    const availability = agentChatComposerAvailability(access, t);
    const activeTurnId = chat.snapshot?.activeTurnId;
    const isRunning = activeTurnId !== undefined;
    const hasDraft = draft.trim().length > 0 || images.attachments.length > 0;
    const canStop = isRunning && deviceRole === 'control';
    const isStopAction = canStop && !hasDraft;
    const { editing } = chat;
    const menu = useComposerMenu({
        chat,
        draft,
        // An edit's text is the replacement message, so the command menu does not offer to run it.
        isEnabled: availability.isEnabled && !editing,
        sessionId,
    });
    const {
        chooseCommand,
        confirmsSendAsText,
        error,
        isRunningCommand,
        isSendingEdit,
        isStopping,
        run,
    } = useComposerAction({
        activeTurnId,
        chat,
        draft,
        images,
        isStopAction,
        menuMatches: menu.matches,
        onDraftChange,
        provider,
    });
    const isEditable = availability.isEnabled && !isRunningCommand && !isSendingEdit;
    /**
     * An edit waits for the running turn (or a compaction) to end, as on Desktop; Core would refuse it.
     */
    const editWaitReason =
        editing && (isRunning || chat.snapshot?.operation === 'compacting')
            ? t('chat.edit.stopToSend')
            : undefined;
    const inputReference = useFocusRequest({
        focusComposer,
        isEditable,
        isVisible,
        onComposerFocused,
    });
    const { canSteer, canSubmit } = agentChatComposerSubmission({
        // A message waits for its images to finish uploading, as the Terminal composer does.
        hasDraft:
            hasDraft &&
            !images.hasUnsentAttachment &&
            // An edit replaces the message with text only; Core refuses an empty one.
            (!editing || (draft.trim().length > 0 && editWaitReason === undefined)),
        isEditable,
        isRunning,
        isStopAction,
        isStopping,
    });
    const deliveries = agentChatComposerPressDeliveries({ canSteer });
    const submit = async (): Promise<void> => {
        if (canSubmit) await run(deliveries.tap === 'steer' ? 'steer' : undefined);
    };
    /**
     * A message without `delivery` joins the follow-up queue while a turn runs.
     */
    const queue = async (): Promise<void> => {
        if (deliveries.hold === 'queue') await run();
    };
    const rowControls = agentChatComposerRowControls({
        canAttach: deviceRole === 'reply' || deviceRole === 'control',
        hasText: draft.trim().length > 0,
        isRunning,
    });
    // Images never return to an edit (`agentChatMessageEditAvailability`), so it offers none to add.
    const showsAttach = rowControls.showsAttach && !editing;
    const isMenuOpen = menu.matches !== undefined || menu.notice !== undefined;
    const statusReason =
        attachNotice ??
        availability.reason ??
        editWaitReason ??
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
            {/* The command menu takes the model and permission row's place, so the keyboard-up screen keeps its room. */}
            {isMenuOpen || !chat.snapshot?.terminalId ? null : (
                <AgentChatPlanPaceNotice terminalId={chat.snapshot.terminalId} theme={theme} />
            )}
            {isMenuOpen ? null : (
                <View style={sheetStyles.choices}>
                    <AgentChatSettings
                        chat={chat}
                        configureReason={agentChatDisabledReason(
                            { ...access, action: 'configure' },
                            t,
                        )}
                        permissionReason={agentChatDisabledReason(
                            { ...access, action: 'permission' },
                            t,
                        )}
                        provider={providerId}
                        theme={theme}
                    />
                    {chat.snapshot?.terminalId ? (
                        <AgentChatSessionUsageButton
                            terminalId={chat.snapshot.terminalId}
                            theme={theme}
                            usage={chat.snapshot.usage}
                        />
                    ) : null}
                </View>
            )}
            {editing ? (
                <AgentChatEditBanner
                    onCancel={() => {
                        chat.setEditing(undefined);
                        onDraftChange(editing.previousDraft);
                    }}
                    removedTurns={editing.removedTurns}
                    theme={theme}
                />
            ) : null}
            <SessionComposerAttachments images={images} theme={theme} />
            <AgentChatCommandList
                confirmsSendAsText={confirmsSendAsText}
                isEnabled={isEditable}
                matches={menu.matches}
                notice={menu.notice}
                onChoose={chooseCommand}
                theme={theme}
            />
            <View style={styles.composerRow}>
                {showsAttach ? (
                    <AttachButton
                        canAdd={images.canAdd}
                        isEditable={isEditable}
                        onPress={() => setChoosingImage(true)}
                        onUnsupported={showAttachNotice}
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
                    <AgentChatQueueButton onQueue={queue} provider={provider} theme={theme} />
                ) : null}
                <AgentChatComposerButton
                    canQueue={deliveries.hold === 'queue'}
                    canSubmit={canSubmit}
                    isBusy={isStopping || isRunningCommand || isSendingEdit}
                    isRunning={isRunning}
                    isStopAction={isStopAction}
                    isStopping={isStopping}
                    onPress={submit}
                    onQueue={queue}
                    provider={provider}
                    theme={theme}
                />
            </View>
            <AgentChatComposerStatus
                error={error ?? images.attachError}
                isStopping={isStopping}
                provider={provider}
                reason={statusReason}
                theme={theme}
            />
            {isChoosingImage ? (
                <ImageSourceSheet
                    onClose={() => setChoosingImage(false)}
                    onPick={(source) => {
                        void images.add(source);
                    }}
                    theme={theme}
                />
            ) : null}
        </View>
    );
};
