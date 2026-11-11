import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextInputInstance } from 'react-native';
import { Keyboard, StyleSheet, Text, View } from 'react-native';

import type { AgentAction, AgentProvider } from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { useClearedDraftEchoGuard } from '../../lib/use-cleared-draft-echo-guard';
import { mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { ComposerAddSheet } from '../sessions/components/composer-add-sheet';
import { SessionComposerAttachments } from '../sessions/components/session-composer-extras';
import { sessionDetailStyles as styles } from '../sessions/components/session-detail-styles';
import { useFileAttachments } from '../sessions/hooks/use-file-attachments';
import { useImageAttachments } from '../sessions/hooks/use-image-attachments';
import { useIsAttachmentStripShown } from '../sessions/hooks/use-is-attachment-strip-shown';
import { imageAttachmentBudgetNote } from '../sessions/image-attachment-store';
import type { MobileAgentChatSessionCommand } from './agent-chat-app-commands';
import { agentChatMenuMatches, agentChatSkillNotice } from './agent-chat-commands';
import {
    AddButton,
    AgentChatComposerButton,
    AgentChatQueueButton,
} from './agent-chat-composer-buttons';
import { AgentChatComposerCapsule } from './agent-chat-composer-capsule';
import { AgentChatComposerInput } from './agent-chat-composer-input';
import { AgentChatComposerMenus } from './agent-chat-composer-menus';
import { AgentChatUsageNotices } from './agent-chat-credits-notice';
import { AgentChatEditBanner } from './agent-chat-edit-banner';
import {
    agentChatComposerAvailability,
    agentChatComposerLayout,
    agentChatComposerPressDeliveries,
    agentChatComposerSubmission,
    agentChatDisabledReason,
} from './agent-chat-model';
import { AgentChatPromptSuggestionChip } from './agent-chat-prompt-suggestion-chip';
import { AgentChatSettingsRow, AgentChatSettingsSheets } from './agent-chat-settings';
import { AgentChatContextNotice } from './context/agent-chat-context-notice';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatAddSettings } from './use-agent-chat-add-settings';
import { useAgentChatAppCommands } from './use-agent-chat-app-commands';
import { useAgentChatComposerAction } from './use-agent-chat-composer-action';
import { useAgentChatHandoffSource } from './use-agent-chat-handoff-source';
import { useAgentChatMentions } from './use-agent-chat-mentions';
import { useAgentChatSettings } from './use-agent-chat-settings';
import { useAgentChatSkills } from './use-agent-chat-skills';

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
 * The composer menu's rows and skill status for the draft: the provider's commands plus the skills the Server finds for
 * the Chat's Terminal, as on Desktop. Nothing shows while the composer cannot send.
 */
const useComposerMenu = ({
    builtIn,
    chat,
    draft,
    isEnabled,
    sessionId,
}: {
    builtIn: readonly AgentAction[];
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
        matches: agentChatMenuMatches(draft, chat.snapshot?.commands, skills.skills, builtIn),
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
    useEffect(() => {
        // Android keeps a field focused after Back or a timeline drag closes the keyboard, which would leave an empty
        // capsule expanded under no keyboard; blurring lets it fold back to one row.
        const subscription = Keyboard.addListener('keyboardDidHide', () => {
            if (inputReference.current?.isFocused()) inputReference.current.blur();
        });
        return () => subscription.remove();
    }, []);
    return inputReference;
};

/**
 * The lines right above the capsule, the composer's one place for explanations: why the composer or a control is
 * disabled (muted), a pending Stop, and a failed send, Stop, or image attach (danger). They sit above it with every
 * other notice, so the capsule, and Send or Stop in it, never moves when a line appears. Nothing here opens a system
 * dialog.
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
 * The notices above the capsule: plan usage, the context window, and an edit in progress. The command menu takes the
 * usage and context notices' place, so the keyboard-up screen keeps its room.
 */
const AgentChatComposerNotices = ({
    canSend,
    chat,
    isMenuOpen,
    onDraftChange,
    provider,
    theme,
}: {
    canSend: boolean;
    chat: AgentChatController;
    isMenuOpen: boolean;
    onDraftChange: (draft: string) => void;
    provider: string;
    theme: MobileTheme;
}) => {
    const terminalId = chat.snapshot?.terminalId;
    const isRunning = chat.snapshot?.activeTurnId !== undefined;
    const { editing } = chat;
    return (
        <>
            {isMenuOpen || !terminalId ? null : (
                <AgentChatUsageNotices provider={provider} terminalId={terminalId} theme={theme} />
            )}
            {isMenuOpen || isRunning || !terminalId ? null : (
                <AgentChatContextNotice canSend={canSend} chat={chat} theme={theme} />
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
        </>
    );
};

/**
 * The first reason the composer cannot send yet, in priority order: access, a waiting edit, then attachments.
 */
const composerStatusReason = ({
    availabilityReason,
    editWaitReason,
    files,
    images,
}: {
    availabilityReason: string | undefined;
    editWaitReason: string | undefined;
    files: { waitReason: string | null };
    images: Pick<ReturnType<typeof useImageAttachments>, 'attachments' | 'waitReason'>;
}): string | undefined =>
    availabilityReason ??
    editWaitReason ??
    images.waitReason ??
    files.waitReason ??
    imageAttachmentBudgetNote(
        images.attachments,
        MAX_AGENT_CHAT_IMAGES_TOTAL_BASE64_LENGTH,
        MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
    ) ??
    undefined;

/**
 * Sends a message to a Chat. While a turn runs, a control device gets Stop in place of Send when the draft is empty,
 * matching the Desktop composer. A message sent during a turn steers it, as Desktop's Enter does; the Queue button
 * beside it (or holding Steer) queues it for the turn's end instead, the phone's stand-in for Desktop's ⌘Enter.
 */
/**
 * Why an edit cannot send yet: it waits for the running turn (or a compaction) to end, as on Desktop; Core would refuse
 * it.
 */
const agentChatEditWaitReason = (
    chat: AgentChatController,
    isRunning: boolean,
    t: Translate,
): string | undefined =>
    isRunning || chat.snapshot?.operation === 'compacting' ? t('chat.edit.stopToSend') : undefined;

export const AgentChatComposer = ({
    chat,
    deviceRole,
    draft,
    focusComposer,
    isConnected,
    isHandedOff,
    isPinned,
    isVisible,
    onComposerFocused,
    onDraftChange,
    onSessionCommand,
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
    /**
     * Whether the Session is pinned, so `/pin` reads as Unpin.
     */
    isPinned: boolean;
    isVisible: boolean;
    onComposerFocused?: () => void;
    onDraftChange: (draft: string) => void;
    /**
     * Runs `/rename`, `/archive`, or `/pin`; absent while the device may not manage Sessions.
     */
    onSessionCommand: ((command: MobileAgentChatSessionCommand) => void) | undefined;
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
    const files = useFileAttachments(sessionId, { surface: 'chat' });
    // A provider without image input still takes photos, as files it reads by path.
    const images = useImageAttachments(sessionId, {
        ...imageLimits,
        files: { add: files.add, imagesAsFiles: !supportsImages, remaining: files.remaining },
    });
    const [isChoosingImage, setChoosingImage] = useState(false);
    const [isFocused, setFocused] = useState(false);
    const handoffSource = useAgentChatHandoffSource(sessionId, providerId);
    const draftInput = useClearedDraftEchoGuard(draft, onDraftChange);
    const access = { deviceRole, isConnected, isHandedOff, snapshot: chat.snapshot };
    const availability = agentChatComposerAvailability(access, t);
    const activeTurnId = chat.snapshot?.activeTurnId;
    const isRunning = activeTurnId !== undefined;
    const hasDraft =
        draft.trim().length > 0 || images.attachments.length > 0 || files.attachments.length > 0;
    const canStop = isRunning && deviceRole === 'control';
    const isStopAction = canStop && !hasDraft;
    const { editing } = chat;
    const configureReason = agentChatDisabledReason({ ...access, action: 'configure' }, t);
    const permissionReason = agentChatDisabledReason({ ...access, action: 'permission' }, t);
    const appCommands = useAgentChatAppCommands({
        chat,
        configureReason,
        isPinned,
        onDraftChange: draftInput.setDraft,
        onSessionCommand,
        permissionReason,
        providerId,
    });
    const settings = useAgentChatSettings({
        chat,
        configureReason,
        permissionReason,
        provider: providerId,
    });
    const addSettings = useAgentChatAddSettings({ chat, onOpen: appCommands.setSheet, settings });
    const menu = useComposerMenu({
        builtIn: appCommands.builtIn,
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
        imagePlaceholders,
        isRunningCommand,
        isSendingEdit,
        isStopping,
        run,
    } = useAgentChatComposerAction({
        activeTurnId,
        appCommands,
        chat,
        draft,
        files,
        images,
        handoffSource,
        isStopAction,
        menuMatches: menu.matches,
        onDraftChange: draftInput.setDraft,
        provider,
    });
    const isEditable = availability.isEnabled && !isRunningCommand && !isSendingEdit;
    const mentions = useAgentChatMentions({
        draft,
        // An edit's text can cite files and Sessions too; only a composer that cannot send hides the list.
        isEnabled: availability.isEnabled,
        onDraftChange: draftInput.setDraft,
        sessionId,
    });
    const editWaitReason = editing ? agentChatEditWaitReason(chat, isRunning, t) : undefined;
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
            files.waitReason === null &&
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
    const canAttach =
        (deviceRole === 'reply' || deviceRole === 'control') &&
        isEditable &&
        (images.canAdd || files.canAdd);
    const isMenuOpen =
        menu.matches !== undefined || menu.notice !== undefined || mentions.rows !== undefined;
    const isExpanded =
        agentChatComposerLayout({
            hasAttachments: useIsAttachmentStripShown(
                images.attachments.length + files.attachments.length > 0,
            ),
            hasText: draft.length > 0,
            isEditing: editing !== undefined,
            isFocused,
            isMenuOpen,
        }) === 'expanded';
    const sendControls = (
        <>
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
        </>
    );
    const statusReason = composerStatusReason({
        availabilityReason: availability.reason,
        editWaitReason,
        files,
        images,
    });
    return (
        <View style={styles.composerBlock} testID="agent-chat-composer">
            <AgentChatComposerNotices
                canSend={availability.isEnabled}
                chat={chat}
                isMenuOpen={isMenuOpen}
                onDraftChange={draftInput.setDraft}
                provider={provider}
                theme={theme}
            />
            <SessionComposerAttachments files={files} images={images} theme={theme} />
            <AgentChatComposerMenus
                confirmsSendAsText={confirmsSendAsText}
                isEnabled={isEditable}
                menu={menu}
                mentions={mentions}
                onChooseCommand={chooseCommand}
                theme={theme}
            />
            <AgentChatComposerStatus
                error={error ?? mentions.error ?? images.attachError ?? files.attachError}
                isStopping={isStopping}
                provider={provider}
                reason={statusReason}
                theme={theme}
            />
            <AgentChatPromptSuggestionChip
                draft={draft}
                isEditable={isEditable}
                isEditing={editing !== undefined}
                isMenuOpen={isMenuOpen}
                inputReference={inputReference}
                onDraftChange={draftInput.setDraft}
                snapshot={chat.snapshot}
                theme={theme}
            />
            <AgentChatComposerCapsule
                add={
                    // Images never return to an edit (`agentChatMessageEditAvailability`), so it offers none to add.
                    editing ? null : (
                        <AddButton
                            isAtLimit={!images.canAdd && !files.canAdd}
                            isEnabled={canAttach || addSettings.length > 0}
                            onPress={() => setChoosingImage(true)}
                            theme={theme}
                        />
                    )
                }
                input={
                    <AgentChatComposerInput
                        draft={draft}
                        focusComposer={focusComposer}
                        inputReference={inputReference}
                        isEditable={isEditable}
                        isExpanded={isExpanded}
                        isRunning={isRunning}
                        onComposerFocused={onComposerFocused}
                        imagePlaceholders={imagePlaceholders}
                        onDraftChange={draftInput.onChangeText}
                        onFocusChange={setFocused}
                        provider={provider}
                        theme={theme}
                    />
                }
                isExpanded={isExpanded}
                send={sendControls}
                settings={
                    <AgentChatSettingsRow
                        chat={chat}
                        onOpen={appCommands.setSheet}
                        settings={settings}
                        theme={theme}
                    />
                }
                theme={theme}
            />
            {isChoosingImage ? (
                <ComposerAddSheet
                    canAttach={canAttach}
                    // A pasted image has no file to fall back to.
                    hidden={supportsImages ? [] : ['clipboard']}
                    onClose={() => setChoosingImage(false)}
                    onPick={(source) => {
                        void (source === 'files' ? files.pick() : images.add(source));
                    }}
                    onPickRecent={(media) => {
                        void images.addRecent(media);
                    }}
                    settings={addSettings}
                    theme={theme}
                    title={t('chat.composer.add')}
                />
            ) : null}
            <AgentChatSettingsSheets
                chat={chat}
                onClose={() => appCommands.setSheet(null)}
                settings={settings}
                sheet={appCommands.sheet}
                theme={theme}
            />
        </View>
    );
};
