import type { RefObject } from 'react';
import { useState } from 'react';

import type {
    AgentChatActivity,
    AgentChatCommand,
    AgentChatQueuedMessage,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { CAXRI_SKILL_NAME } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useTerminal } from '../../../stores/selectors';
import { usePaneViewSession } from '../../workbench/pane-view-session';
import { agentChatLiveGoalActivity } from '../activity/agent-chat-goal-row';
import { useAgentChatAppCommands } from '../app-commands/use-agent-chat-app-commands';
import { AgentChatAttachmentList } from '../attachments/agent-chat-attachment-list';
import { isAgentChatSkillAttachment } from '../composer-input/agent-chat-drafts';
import { AgentChatSuggestionMenu } from '../composer-input/agent-chat-suggestion-menu';
import { useAgentChatAttachments } from '../hooks/use-agent-chat-attachments';
import { useAgentChatCommandMenu } from '../hooks/use-agent-chat-command-menu';
import { useAgentChatComposerCommand } from '../hooks/use-agent-chat-composer-command';
import type { AgentChatComposerEditOptions } from '../hooks/use-agent-chat-composer-edit';
import { useAgentChatComposerEnter } from '../hooks/use-agent-chat-composer-enter';
import { useAgentChatComposerInput } from '../hooks/use-agent-chat-composer-input';
import { useAgentChatComposerSend } from '../hooks/use-agent-chat-composer-send';
import { useAgentChatDraft } from '../hooks/use-agent-chat-draft';
import { useAgentChatDraftStash } from '../hooks/use-agent-chat-draft-stash';
import type { AgentChatDropHandlers } from '../hooks/use-agent-chat-file-input';
import { useAgentChatHandoff } from '../hooks/use-agent-chat-handoff';
import { useAgentChatImagePlaceholders } from '../hooks/use-agent-chat-image-placeholders';
import { useAgentChatPromptHistory } from '../hooks/use-agent-chat-prompt-history';
import { useAgentChatSessionMenu } from '../hooks/use-agent-chat-session-menu';
import { useAgentChatStop } from '../hooks/use-agent-chat-stop';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';
import { agentChatComposerPlaceholder } from '../transcript/agent-chat-presentation';
import { AgentChatComposerActions } from './agent-chat-composer-actions';
import { AgentChatComposerEditor } from './agent-chat-composer-editor';
import { AgentChatComposerNotices } from './agent-chat-composer-notices';
import { AgentChatComposerStrip } from './agent-chat-composer-strip';
import type { AgentChatComposerInput } from './agent-chat-composer-view';
import { AgentChatDropOverlay } from './agent-chat-drop-overlay';
import { agentChatNextQueuedId } from './agent-chat-queue';
import type { agentChatSendBlock } from './send/agent-chat-send-tooltip';
import { agentChatSendLabels } from './send/agent-chat-send-tooltip';

/**
 * How many recent Sessions the composer's Add menu offers to cite, as the Codex app lists a handful of recent chats.
 */
const RECENT_SESSION_LIMIT = 5;

interface AgentChatComposerProperties {
    /**
     * The running turn, which a message steers and Stop interrupts.
     */
    activeTurnId: string | undefined;
    /**
     * What the Chat is doing, shown as a status tab on top of the input.
     */
    activity: AgentChatActivity | undefined;
    /**
     * Whether the context meter offers Details (`AgentChatHostCapabilities`).
     */
    canOpenContext: boolean;
    /**
     * Whether the permission menu offers "Use as Project default" (`AgentChatHostCapabilities`).
     */
    canSaveProjectDefault: boolean;
    /**
     * The provider's slash commands, from the projection.
     */
    commands: readonly AgentChatCommand[] | undefined;
    /**
     * Receives the composer's drop handlers so the whole Chat, not only this card, takes a dropped file: dragging all
     * the way down to the input is a long trip.
     */
    dropHandlersReference: RefObject<AgentChatDropHandlers | null>;
    edit: AgentChatComposerEditOptions;
    inputReference: RefObject<AgentChatComposerInput | null>;
    /**
     * Whether a message sent now waits in the queue (`isAgentChatBusy`).
     */
    isBusy: boolean;
    isQueuePaused: boolean;
    /**
     * Whether the Chat is on screen in the active pane (see `AgentChatPane`).
     */
    isShown: boolean;
    /**
     * Opens a background task's tab beside the Chat; absent where the host cannot (see `canOpenBesideChat`).
     */
    onOpenTask: ((taskId: string) => void) | undefined;
    /**
     * Runs once a message left this composer (it shows as pending at once), or after Server Core accepted a slash
     * command it ran. The pane uses it to scroll the timeline to the latest entry.
     */
    onSent?: () => void;
    /**
     * Messages sent to wait in the queue that the projection does not list yet (`agent-chat-pending.ts`).
     */
    pendingQueue: readonly AgentChatPendingMessage[];
    /**
     * The provider catalog's display name, for the placeholder and the toast that says it takes no images.
     */
    providerName: string;
    queue: readonly AgentChatQueuedMessage[] | undefined;
    /**
     * Why the Chat refuses a message right now (`agentChatSendBlock`), or `undefined` when it accepts one.
     */
    sendBlock: ReturnType<typeof agentChatSendBlock>;
    /**
     * The permission, model, effort, and context usage the action row shows, and the sent prompts ArrowUp recalls.
     */
    snapshot:
        | Pick<
              AgentChatSnapshot,
              | 'activeTurnId'
              | 'effort'
              | 'goal'
              | 'goalUsage'
              | 'items'
              | 'model'
              | 'models'
              | 'permissionMode'
              | 'plan'
              | 'planMode'
              | 'queuePauseReason'
              | 'tasks'
              | 'turns'
              | 'usage'
              | 'usageGuard'
          >
        | undefined;
    /**
     * Whether the provider's Chat accepts image input (`capabilities.chatImages`).
     */
    supportsImages: boolean;
    terminalId: string;
}

/**
 * The actions menu's Caxri skill switch, which attaches or removes the skill's card.
 */
function caxriSkillToggle(
    images: ReturnType<typeof useAgentChatAttachments>,
    focusInput: () => void,
): { isAttached: boolean; onChange: (isAttached: boolean) => void } {
    const card = images.attachments.find(
        (attachment) =>
            isAgentChatSkillAttachment(attachment) && attachment.skill === CAXRI_SKILL_NAME,
    );
    return {
        isAttached: card !== undefined,
        onChange: (isAttached) => {
            if (isAttached) images.addSkill(CAXRI_SKILL_NAME);
            else if (card) images.remove(card.id);
            focusInput();
        },
    };
}

/**
 * Message input. Enter sends, Shift+Enter adds a line. While a turn runs (or the context compacts), Enter steers the
 * message into the running turn and Cmd+Enter queues it for after the turn (`agentChatSubmitDelivery`); queued messages
 * wait as cards above the input, and Enter in an empty input sends the first of them now. Escape or the Stop button
 * that replaces Send while the input is empty interrupts the turn. Images can be pasted, dropped, or picked from the
 * `+` menu's Files when the provider accepts them; any other dropped or picked file, Files entry, or Editor tab, and an
 * image in a format or size the provider cannot take, is inserted as its path. Text pasted past
 * `agentChat.longPasteThreshold` is saved to a file and the message cites it instead, with a notice whose Paste as Text
 * undoes that; Cmd+Shift+V pastes as text without the conversion. A drag anywhere over the Chat tints the whole pane
 * with a one-line caption. While a turn runs and something is typed, Send wears the steer glyph and its tooltip lists
 * what Enter and Cmd+Enter do. A disabled Send says why in its tooltip, and an Enter it refuses says the same in the
 * strip for two seconds and through the live region. A leading `/` or `$` offers the provider's commands and the
 * discovered skills, and a word that starts with `@` offers other Sessions whose conversation the message can cite;
 * both lists show only while the input has focus. It shares the timeline's centered column so the input lines up with
 * the conversation, and keeps the activity row, attachments, the input, and its actions inside one card so they read as
 * a single control. The action row picks the model and effort for the next turn and shows how full the context window
 * is. Clicking Send, Stop, or a chip or queue action hands focus back to the input, since each of those controls
 * disables or unmounts itself and would otherwise drop focus to the document body. The unsent text survives switching
 * Sessions and restarting Caxri, ArrowUp on an empty input lists the prompts this Chat already sent, and Ctrl+S stashes
 * the draft for later. "Edit from here" on an earlier message (`useAgentChatComposerEdit`) puts its text in the input
 * and the edit bar above it; sending then rewinds the Chat to before that message and sends the draft in its place, and
 * Escape or Cancel puts the previous draft back.
 */
export function AgentChatComposer({
    activeTurnId,
    activity,
    canOpenContext,
    canSaveProjectDefault,
    commands,
    dropHandlersReference,
    edit: editOptions,
    inputReference,
    isBusy,
    isQueuePaused,
    isShown,
    onOpenTask,
    onSent,
    pendingQueue,
    providerName,
    queue,
    sendBlock,
    snapshot,
    supportsImages,
    terminalId,
}: AgentChatComposerProperties) {
    const { t } = useTranslation();
    const focusInput = (): void => inputReference.current?.focus();
    const images = useAgentChatAttachments(terminalId);
    const caxriSkill = caxriSkillToggle(images, focusInput);
    const { clearDraft, draft, restoreQueued, setDraft } = useAgentChatDraft({
        addCards: images.addCards,
        inputReference,
        terminalId,
    });
    const terminal = useTerminal(terminalId);
    const workbenchRoot = usePaneViewSession()?.rootPath;
    /**
     * The suggestion lists float over the card's top edge, so they show only while the input has focus: otherwise one
     * left open stays over whatever the user moved to, such as the edit bar's controls.
     */
    const [isInputFocused, setInputFocused] = useState(false);
    const appCommands = useAgentChatAppCommands(terminalId);
    const menu = useAgentChatCommandMenu({
        appActions: appCommands.actions,
        commands,
        draft,
        isInputFocused,
        terminalId,
        unavailable: appCommands.unavailable,
    });
    const sessionMenu = useAgentChatSessionMenu({
        currentSessionId: terminal?.sessionId,
        draft,
        inputReference,
        isInputFocused,
        isShown,
        isSuppressed: menu.isOpen,
        root: workbenchRoot,
        setDraft,
    });
    const { continueInNewChat, isContinuing } = useAgentChatHandoff({
        clearDraft,
        draft,
        providerName,
        terminal,
    });
    const isTurnRunning = activeTurnId !== undefined;
    const stash = useAgentChatDraftStash({
        attachments: images.attachments,
        clearAttachments: images.clearSent,
        draft,
        inputReference,
        restoreAttachments: images.restoreUnsent,
        setDraft,
        terminalId,
    });
    const { isStopping, stop } = useAgentChatStop({ activeTurnId, terminalId });
    const goalActivity = agentChatLiveGoalActivity(snapshot?.goal, activity, isStopping);
    const placeholders = useAgentChatImagePlaceholders({ draft, images, inputReference, setDraft });
    const { fileInput, isAttaching, pastePlainText, pathPills } = useAgentChatComposerInput({
        draft,
        dropHandlersReference,
        images,
        inputReference,
        providerName,
        reserveImageTokens: placeholders.reserve,
        setDraft,
        supportsImages,
        terminalId,
    });
    const {
        choose,
        compact,
        complete,
        edit,
        goalMode,
        hasContent,
        isResume,
        isSendable,
        isSending,
        sideChatNotice,
        submit,
        submitForm,
    } = useAgentChatComposerSend({
        appCommandFor: appCommands.commandFor,
        canSend: sendBlock === undefined,
        clearDraft,
        commands,
        draft,
        edit: {
            inputReference,
            isBusy,
            isTurnRunning,
            options: editOptions,
            providerName,
            snapshot,
        },
        focusInput,
        hasQueue: (queue?.length ?? 0) + pendingQueue.length > 0,
        images,
        // A Session chosen from the `@` list is not in the draft until its reference is written.
        isAttaching: isAttaching || sessionMenu.isPreparing,
        onSent: () => {
            onSent?.();
            stash.restoreAfterSend();
        },
        setDraft,
        terminalId,
    });
    // The turn review's "Back to Chat and Send" sends the message from outside the composer.
    useAgentChatComposerCommand(terminalId, 'send', isSendable, () => {
        void submit();
    });
    const history = useAgentChatPromptHistory({
        draft,
        hasAttachments: images.attachments.length > 0,
        inputReference,
        isEditing: edit.isEditing,
        items: snapshot?.items,
        setDraft,
    });
    const { sendAction } = edit;
    const nextQueuedId = agentChatNextQueuedId(queue, isTurnRunning);
    const sendState = {
        block: sendBlock,
        hasContent,
        isAttaching,
        isPreparingReference: sessionMenu.isPreparing,
        isResume,
        isSending,
    };
    const { sendKeys, sendShortcut, sendTooltip } = agentChatSendLabels(sendAction, sendState, t);
    const composerKeys = useAgentChatComposerEnter({
        cancelEdit: edit.cancel,
        clearAttachments: () => images.clearSent(images.attachments),
        hasPendingQueue: pendingQueue.length > 0,
        isBusy,
        isEditing: edit.isEditing,
        isSendable,
        isTurnRunning,
        nextQueuedId,
        pastePlainText,
        sendAction,
        sendState,
        stop,
        submit,
        terminalId,
    });
    const stopAndFocus = (): void => {
        stop();
        focusInput();
    };
    return (
        <div className="mx-auto w-full max-w-3xl px-4 pt-1 pb-3">
            <AgentChatDropOverlay
                isDragOver={fileInput.isDragOver}
                supportsImages={supportsImages}
            />
            {/*
             * The suggestion menus anchor to this wrapper rather than the form, so they open above the strip too.
             */}
            <div className="relative">
                <AgentChatComposerStrip
                    activeTurnId={activeTurnId}
                    activity={activity}
                    goalActivity={goalActivity}
                    isQueuePaused={isQueuePaused}
                    isTurnRunning={isTurnRunning}
                    pendingQueue={pendingQueue}
                    queue={queue}
                    snapshot={snapshot}
                    terminalId={terminalId}
                    onOpenTask={onOpenTask}
                    onQueueAction={focusInput}
                    onQueueEdit={restoreQueued}
                >
                    <AgentChatComposerNotices
                        activeTurnId={activeTurnId}
                        activity={activity}
                        edit={edit.bar}
                        isActivityInGoalRow={goalActivity !== undefined}
                        isContinuing={isContinuing}
                        isEditing={edit.isEditing}
                        notice={
                            composerKeys.notice ??
                            sideChatNotice ??
                            stash.notice ??
                            (menu.confirmsSendAsText
                                ? t('agentChat.slash.confirmSendAsText')
                                : undefined)
                        }
                        snapshot={snapshot}
                        terminalId={terminalId}
                        onCompact={compact}
                        onContinueInNewChat={continueInNewChat}
                    />
                </AgentChatComposerStrip>
                <form
                    className={cn(
                        'flex flex-col rounded-lg border border-border bg-surface transition-[border-color] focus-within:border-muted',
                        fileInput.isDragOver && 'border-accent focus-within:border-accent',
                    )}
                    onSubmit={submitForm}
                >
                    <AgentChatSuggestionMenu
                        commandMenu={menu}
                        historyMenu={history}
                        sessionMenu={sessionMenu}
                        onChooseCommand={(index) => {
                            const action = menu.matches[index];
                            if (!menu.isUnavailable(action)) choose(action);
                        }}
                    />
                    <AgentChatAttachmentList
                        attachments={images.attachments}
                        isGoalMode={goalMode.isOn}
                        pendingCount={images.readingCount}
                        preview={placeholders.preview}
                        onRemove={placeholders.removeAttachment}
                    />
                    <AgentChatComposerEditor
                        composerKeys={composerKeys}
                        draft={draft}
                        goalMode={goalMode}
                        history={history}
                        imagePlaceholders={placeholders}
                        inputReference={inputReference}
                        isEditing={edit.isEditing}
                        knownInvocations={menu.knownInvocations}
                        menu={menu}
                        menuActions={{ choose, complete }}
                        pathPills={pathPills}
                        placeholder={agentChatComposerPlaceholder(
                            sendAction,
                            {
                                hasNextQueued: nextQueuedId !== undefined,
                                hasStash: stash.hasStash,
                                isEditing: edit.isEditing,
                                isGoalMode: goalMode.isOn,
                                isTurnRunning,
                            },
                            t,
                        )}
                        sessionMenu={sessionMenu}
                        setDraft={setDraft}
                        setInputFocused={setInputFocused}
                        terminalId={terminalId}
                        stash={stash}
                        onPaste={fileInput.onPaste}
                    />
                    <AgentChatComposerActions
                        canAttachImages={supportsImages}
                        canOpenContext={canOpenContext}
                        canSaveProjectDefault={canSaveProjectDefault}
                        caxriSkill={caxriSkill}
                        isAttaching={isAttaching || sessionMenu.isPreparing}
                        isQueueing={!edit.isEditing && !isTurnRunning && isBusy}
                        isResume={isResume}
                        isSendable={isSendable || isResume}
                        isStopping={isStopping}
                        onCompact={compact}
                        onGoal={goalMode.enter}
                        onTurnOffGoalMode={goalMode.isOn ? goalMode.exit : undefined}
                        onReferenceSession={sessionMenu.reference}
                        onPick={fileInput.pick}
                        onPickPaths={fileInput.pickPaths}
                        onPicked={focusInput}
                        onStop={stopAndFocus}
                        sendAction={sendAction}
                        sendKeys={sendKeys}
                        sendShortcut={sendShortcut}
                        sendTooltip={sendTooltip}
                        recentSessions={sessionMenu.recentCandidates(RECENT_SESSION_LIMIT)}
                        showsStop={isTurnRunning && !hasContent}
                        snapshot={snapshot}
                        terminalId={terminalId}
                    />
                </form>
            </div>
        </div>
    );
}
