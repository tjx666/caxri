import type { RefObject } from 'react';
import { useState } from 'react';

import type {
    AgentChatActivity,
    AgentChatCommand,
    AgentChatQueuedMessage,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';

import { Textarea } from '../../components/ui/textarea';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useTerminal } from '../../stores/selectors';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { AgentChatActivityBar } from './agent-chat-activity-bar';
import { AgentChatAttachmentList } from './agent-chat-attachment-list';
import { AgentChatComposerActions } from './agent-chat-composer-actions';
import { AgentChatContextAlerts } from './agent-chat-context-alerts';
import { AgentChatDropOverlay } from './agent-chat-drop-overlay';
import { AgentChatEditBar } from './agent-chat-edit-bar';
import { AgentChatGoalBar } from './agent-chat-goal-bar';
import type { AgentChatPendingMessage } from './agent-chat-pending';
import type { agentChatSendBlock } from './agent-chat-presentation';
import {
    agentChatComposerPlaceholder,
    agentChatSendTooltip,
    agentChatSendTooltipShortcut,
} from './agent-chat-presentation';
import { agentChatNextQueuedId } from './agent-chat-queue';
import { AgentChatQueueList } from './agent-chat-queue-list';
import { AgentChatSuggestionMenu } from './agent-chat-suggestion-menu';
import { useAgentChatAttachments } from './hooks/use-agent-chat-attachments';
import { useAgentChatCommandMenu } from './hooks/use-agent-chat-command-menu';
import type { AgentChatComposerEditOptions } from './hooks/use-agent-chat-composer-edit';
import { useAgentChatComposerEnter } from './hooks/use-agent-chat-composer-enter';
import { useAgentChatComposerInput } from './hooks/use-agent-chat-composer-input';
import { useAgentChatComposerSend } from './hooks/use-agent-chat-composer-send';
import { useAgentChatDraft } from './hooks/use-agent-chat-draft';
import type { AgentChatDropHandlers } from './hooks/use-agent-chat-file-input';
import { useAgentChatHandoff } from './hooks/use-agent-chat-handoff';
import { useAgentChatPromptHistory } from './hooks/use-agent-chat-prompt-history';
import { useAgentChatSessionMenu } from './hooks/use-agent-chat-session-menu';
import { useAgentChatStop } from './hooks/use-agent-chat-stop';

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
    inputReference: RefObject<HTMLTextAreaElement | null>;
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
              | 'items'
              | 'model'
              | 'models'
              | 'permissionMode'
              | 'planMode'
              | 'queuePauseReason'
              | 'turns'
              | 'usage'
          >
        | undefined;
    /**
     * Whether the provider's Chat accepts image input (`capabilities.chatImages`).
     */
    supportsImages: boolean;
    terminalId: string;
}

/**
 * Message input. Enter sends, Shift+Enter adds a line. While a turn runs (or the context compacts), Enter queues the
 * message for after the turn and Cmd+Enter steers it into the running turn; queued messages wait as cards above the
 * input, and Enter in an empty input sends the first of them now. Escape or the Stop button that replaces Send while
 * the input is empty interrupts the turn. Images can be pasted, dropped, or picked from the `+` menu's Files when the
 * provider accepts them; any other dropped or picked file, Files entry, or Editor tab, and an image in a format or size
 * the provider cannot take, is inserted as its path. Text pasted past `agentChat.longPasteThreshold` is saved to a file
 * and the message cites it instead, with a notice whose Paste as Text undoes that; Cmd+Shift+V pastes as text without
 * the conversion. A drag anywhere over the Chat tints the whole pane with a one-line caption. While a turn runs and
 * something is typed, the activity row says what Enter and Cmd+Enter do, and Send wears the queue glyph. A disabled
 * Send says why in its tooltip, and an Enter it refuses says the same in the strip for two seconds and through the live
 * region. A leading `/` or `$` offers the provider's commands and the discovered skills, and a word that starts with
 * `@` offers other Sessions whose conversation the message can cite; both lists show only while the input has focus. It
 * shares the timeline's centered column so the input lines up with the conversation, and keeps the activity row,
 * attachments, the input, and its actions inside one card so they read as a single control. The action row picks the
 * model and effort for the next turn and shows how full the context window is. Clicking Send, Stop, or a chip or queue
 * action hands focus back to the input, since each of those controls disables or unmounts itself and would otherwise
 * drop focus to the document body. The unsent text survives switching Sessions and restarting Caxri, and ArrowUp on an
 * empty input recalls the prompts this Chat already sent. "Edit from here" on an earlier message
 * (`useAgentChatComposerEdit`) puts its text in the input and the edit bar above it; sending then rewinds the Chat to
 * before that message and sends the draft in its place, and Escape or Cancel puts the previous draft back.
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
    const { clearDraft, draft, restoreQueued, setDraft } = useAgentChatDraft({
        inputReference,
        terminalId,
    });
    const terminal = useTerminal(terminalId);
    const workbenchRoot = usePaneViewSession()?.rootPath;
    const images = useAgentChatAttachments(terminalId);
    /**
     * The suggestion lists float over the card's top edge, so they show only while the input has focus: otherwise one
     * left open stays over whatever the user moved to, such as the edit bar's controls.
     */
    const [isInputFocused, setInputFocused] = useState(false);
    const menu = useAgentChatCommandMenu({
        commands,
        draft,
        isInputFocused,
        terminalId,
    });
    const sessionMenu = useAgentChatSessionMenu({
        currentSessionId: terminal?.sessionId,
        draft,
        inputReference,
        isInputFocused,
        isShown,
        isSuppressed: menu.isOpen,
        setDraft,
    });
    const { continueInNewChat, isContinuing } = useAgentChatHandoff({
        clearDraft,
        draft,
        providerName,
        terminal,
    });
    const isTurnRunning = activeTurnId !== undefined;
    const { isStopping, stop } = useAgentChatStop({ activeTurnId, terminalId });
    const { fileInput, isAttaching, pastePlainText } = useAgentChatComposerInput({
        draft,
        dropHandlersReference,
        images,
        inputReference,
        providerName,
        setDraft,
        supportsImages,
        terminal,
        terminalId,
        workbenchRoot,
    });
    const { choose, compact, complete, edit, goalMode, hasContent, isSendable, isSending, submit } =
        useAgentChatComposerSend({
            canSend: sendBlock === undefined,
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
            images,
            // A Session chosen from the `@` list is not in the draft until its reference is written.
            isAttaching: isAttaching || sessionMenu.isPreparing,
            onSent,
            setDraft,
            terminalId,
        });
    const history = useAgentChatPromptHistory({
        draft,
        hasAttachments: images.attachments.length > 0,
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
        isSending,
    };
    const sendTooltip = agentChatSendTooltip(sendAction, sendState, t);
    const sendShortcut = agentChatSendTooltipShortcut(sendAction, sendState);
    const composerKeys = useAgentChatComposerEnter({
        cancelEdit: edit.cancel,
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
            <AgentChatQueueList
                isTurnRunning={isTurnRunning}
                pending={pendingQueue}
                queue={queue}
                snapshot={{
                    queuePaused: isQueuePaused,
                    queuePauseReason: snapshot?.queuePauseReason,
                }}
                terminalId={terminalId}
                onAction={focusInput}
                onEdit={restoreQueued}
            />
            {/*
             * The suggestion menus anchor to this wrapper rather than the form, so they open above the strip too.
             */}
            <div className="relative">
                {/*
                 * The strip sits on the card's top edge, inset from its corners like a tab, so the Chat's state reads as
                 * separate from the draft. Its last row's hairline overlaps the card's top border; with no row it collapses
                 * to `contents`, keeping the Activity bar's live region announced without drawing an empty tab.
                 */}
                <div
                    className="mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-solid border-border bg-surface not-has-[[data-agent-chat-composer-strip-row]]:contents"
                    data-agent-chat-composer-strip=""
                >
                    <AgentChatGoalBar
                        activeTurnId={activeTurnId}
                        goal={snapshot?.goal}
                        terminalId={terminalId}
                        turns={snapshot?.turns}
                    />
                    <AgentChatActivityBar
                        activity={activity}
                        notice={
                            composerKeys.notice ??
                            (menu.confirmsSendAsText
                                ? t('agentChat.slash.confirmSendAsText')
                                : undefined)
                        }
                        showsDeliveryHint={isTurnRunning && draft.trim().length > 0}
                        onStop={stopAndFocus}
                    />
                    <AgentChatEditBar edit={edit.bar} />
                    <AgentChatContextAlerts
                        isContinuing={isContinuing}
                        isShown={!activity && !edit.isEditing}
                        usage={snapshot?.usage}
                        onCompact={compact}
                        onContinueInNewChat={continueInNewChat}
                        terminalId={terminalId}
                    />
                </div>
                <form
                    className={cn(
                        'flex flex-col rounded-lg border border-border bg-surface transition-[border-color] focus-within:border-muted',
                        fileInput.isDragOver && 'border-accent focus-within:border-accent',
                    )}
                    onSubmit={(event) => {
                        event.preventDefault();
                        // The Send button disables itself while the message is in flight, which would drop its focus.
                        focusInput();
                        // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                        void submit();
                    }}
                >
                    <AgentChatSuggestionMenu
                        commandMenu={menu}
                        sessionMenu={sessionMenu}
                        onChooseCommand={(index) => choose(menu.matches[index])}
                    />
                    {images.hasAttachmentRow && (
                        <AgentChatAttachmentList
                            attachments={images.attachments}
                            pendingCount={images.readingCount}
                            onRemove={(id) => {
                                images.remove(id);
                                focusInput();
                            }}
                        />
                    )}
                    {/* Starts three lines tall, as chat composers do, so an empty box still reads as the place to write
                        a message rather than a one-line search field; it grows with the draft up to `max-h-48`. */}
                    <Textarea
                        {...(sessionMenu.inputAria ?? menu.inputAria)}
                        aria-label={t('agentChat.composer.message')}
                        className="field-sizing-content max-h-48 min-h-18 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 leading-5 focus-visible:shadow-none"
                        maxLength={MAX_AGENT_CHAT_MESSAGE_LENGTH}
                        placeholder={agentChatComposerPlaceholder(
                            sendAction,
                            {
                                hasNextQueued: nextQueuedId !== undefined,
                                isEditing: edit.isEditing,
                                isGoalMode: goalMode.isOn,
                                isTurnRunning,
                            },
                            t,
                        )}
                        ref={inputReference}
                        rows={1}
                        value={draft}
                        onChange={(event) => {
                            const { value } = event.target;
                            setDraft(() => value);
                            sessionMenu.trackCaret(event.target);
                        }}
                        onBlur={() => setInputFocused(false)}
                        onFocus={() => setInputFocused(true)}
                        onClick={(event) => sessionMenu.trackCaret(event.currentTarget)}
                        onKeyUp={sessionMenu.trackCaretKey}
                        onSelect={(event) => sessionMenu.followSelection(event.currentTarget)}
                        onKeyDown={(event) => {
                            sessionMenu.notePressedKey(event);
                            if (history.didHandleKey(event, menu.isOpen || sessionMenu.isOpen))
                                return;
                            if (menu.didHandleKey(event, { choose, complete })) return;
                            if (sessionMenu.didHandleKey(event)) return;
                            if (goalMode.didHandleKey(event)) return;
                            composerKeys.onKeyDown(event);
                        }}
                        onPaste={fileInput.onPaste}
                    />
                    <AgentChatComposerActions
                        canAttachImages={supportsImages}
                        canOpenContext={canOpenContext}
                        canSaveProjectDefault={canSaveProjectDefault}
                        isAttaching={isAttaching || sessionMenu.isPreparing}
                        isQueueing={!edit.isEditing && (isTurnRunning || isBusy)}
                        isSendable={isSendable}
                        isStopping={isStopping}
                        onCompact={compact}
                        onGoal={goalMode.enter}
                        onTurnOffGoalMode={goalMode.isOn ? goalMode.exit : undefined}
                        onReferenceSession={sessionMenu.reference}
                        onPick={(files) => {
                            fileInput.pick(files);
                            focusInput();
                        }}
                        onPickPaths={
                            fileInput.pickPaths &&
                            (() => {
                                // eslint-disable-next-line no-void -- pickAgentChatPaths reports its own failures through tryCommand
                                void fileInput.pickPaths?.().then(focusInput);
                            })
                        }
                        onStop={stopAndFocus}
                        sendAction={sendAction}
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
