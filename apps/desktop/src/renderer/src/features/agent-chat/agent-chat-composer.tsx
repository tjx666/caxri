import type { ClipboardEvent, DragEvent, RefObject } from 'react';
import { useState } from 'react';

import type {
    AgentAction,
    AgentChatCommand,
    AgentChatQueuedMessage,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';
import { ArrowUp } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { useTerminal } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { terminalDropInput } from '../terminal/terminal-drop';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { AgentChatActivityBar } from './agent-chat-activity-bar';
import { AgentChatAttachButton } from './agent-chat-attach-button';
import { AgentChatAttachmentList } from './agent-chat-attachment-list';
import { AgentChatCommandMenu } from './agent-chat-command-menu';
import { interruptAgentChat } from './agent-chat-commands';
import { AgentChatContextMeter } from './agent-chat-context-meter';
import {
    agentChatPasteTruncationWarning,
    draftWithInsertion,
    readAgentChatDraft,
    writeAgentChatDraft,
} from './agent-chat-drafts';
import { AgentChatModelMenu } from './agent-chat-model-menu';
import type { AgentChatActivity } from './agent-chat-presentation';
import {
    agentChatContextUsage,
    agentChatSendAction,
    agentChatSubmitDelivery,
    isAgentChatInterruptKey,
} from './agent-chat-presentation';
import { draftAfterQueueEdit } from './agent-chat-queue';
import { AgentChatQueueList } from './agent-chat-queue-list';
import { completeAgentChatAction } from './agent-chat-slash-commands';
import {
    AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME,
    AgentChatStopButton,
} from './agent-chat-stop-button';
import { useAgentChatAttachments } from './hooks/use-agent-chat-attachments';
import { useAgentChatCommandMenu } from './hooks/use-agent-chat-command-menu';
import { useAgentChatFileInput } from './hooks/use-agent-chat-file-input';
import { useAgentChatSubmit } from './hooks/use-agent-chat-submit';

/**
 * Message input. Enter sends, Shift+Enter adds a line. While a turn runs (or the context compacts), Enter queues the
 * message for after the turn and Cmd+Enter steers it into the running turn; queued messages wait as cards above the
 * input. Escape or the Stop button that replaces Send while the input is empty interrupts the turn. Images can be
 * pasted, dropped, or picked when the provider accepts them; any other dropped file, Files entry, or Editor tab is
 * inserted as its path. A leading `/` or `$` offers the provider's commands and the discovered skills. It shares the
 * timeline's centered column so the input lines up with the conversation, and keeps the activity row, attachments, the
 * input, and its actions inside one card so they read as a single control. The action row picks the model and effort
 * for the next turn and shows how full the context window is. Clicking Send, Stop, or a chip or queue action hands
 * focus back to the input, since each of those controls disables or unmounts itself and would otherwise drop focus to
 * the document body.
 */
export function AgentChatComposer({
    activeTurnId,
    activity,
    canSend,
    commands,
    inputReference,
    isBusy,
    isQueuePaused,
    onSent,
    providerName,
    queue,
    snapshot,
    supportsImages,
    terminalId,
}: {
    /**
     * The running turn, which a message steers and Stop interrupts.
     */
    activeTurnId: string | undefined;
    /**
     * What the Chat is doing, shown as a status tab on top of the input.
     */
    activity: AgentChatActivity | undefined;
    canSend: boolean;
    /**
     * The provider's slash commands, from the projection.
     */
    commands: readonly AgentChatCommand[] | undefined;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    /**
     * Whether a message sent now waits in the queue (`isAgentChatBusy`).
     */
    isBusy: boolean;
    isQueuePaused: boolean;
    /**
     * Runs after Server Core accepted a message from this composer (sent, queued, or steered) or a slash command it
     * ran; never after a failed or refused send. The pane uses it to scroll the timeline to the latest entry.
     */
    onSent?: () => void;
    /**
     * The provider catalog's display name, for the placeholder and the toast that says it takes no images.
     */
    providerName: string;
    queue: readonly AgentChatQueuedMessage[] | undefined;
    /**
     * The model, effort, and context usage the action row shows.
     */
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models' | 'usage'> | undefined;
    /**
     * Whether the provider's Chat accepts image input (`capabilities.chatImages`).
     */
    supportsImages: boolean;
    terminalId: string;
}) {
    const [draft, setDraftState] = useState(() => readAgentChatDraft(terminalId));
    /**
     * The turn a Stop was requested for. Keyed by turn so the pending state ends by itself when that turn does, and a
     * later turn starts with a live Stop button.
     */
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const images = useAgentChatAttachments(terminalId);
    const menu = useAgentChatCommandMenu({
        commands,
        draft,
        terminalId,
    });
    const focusInput = (): void => inputReference.current?.focus();
    const isTurnRunning = activeTurnId !== undefined;
    const isStopping = isTurnRunning && stoppingTurnId === activeTurnId;
    const hasContent = draft.trim().length > 0 || images.attachments.length > 0;
    const setDraft = (update: (current: string) => string): void =>
        setDraftState((current) => {
            const next = update(current);
            writeAgentChatDraft(terminalId, next);
            return next;
        });
    const terminal = useTerminal(terminalId);
    const workbenchRoot = usePaneViewSession()?.rootPath;
    /**
     * A dropped file is cited by path the way a drop into a Terminal pastes one, relative to where the Agent runs, and
     * lands at the caret.
     */
    const insertPaths = (event: DragEvent, files: readonly File[]): void => {
        const input = terminal && terminalDropInput(event, terminal, workbenchRoot, files);
        if (!input) {
            if (files.length > 0)
                pushToast(
                    'warning',
                    'This file has no path on disk to insert. Save it, then drop the saved file.',
                );
            return;
        }
        const textarea = inputReference.current;
        const start = textarea?.selectionStart ?? draft.length;
        const end = textarea?.selectionEnd ?? start;
        const inserted = draftWithInsertion(draft, start, end, input);
        setDraft(() => inserted.draft);
        requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(inserted.caret, inserted.caret);
        });
    };
    const fileInput = useAgentChatFileInput({
        add: images.add,
        insertPaths,
        isImageInputEnabled: supportsImages,
        providerName,
    });
    const {
        isSending,
        runCommand,
        submit: submitDraft,
    } = useAgentChatSubmit({
        attachments: images.attachments,
        clearSent: images.clearSent,
        commands,
        onSent,
        setDraft,
        terminalId,
    });
    const contextUsage = agentChatContextUsage(snapshot);
    const isSendable = canSend && !isSending && !images.isReading && hasContent;
    const sendAction = agentChatSendAction({ isTurnRunning, isBusy }, providerName);
    const submit = async (delivery?: 'steer'): Promise<void> => {
        if (isSendable) await submitDraft(draft, delivery);
    };
    const restoreQueued = (text: string): void => {
        setDraft((current) => draftAfterQueueEdit(current, text));
        focusInput();
    };
    /**
     * Tab: put the row's text into the input and stop there, so the user can add arguments or press Enter to run it.
     */
    const complete = (action: AgentAction): void => {
        setDraft(() => completeAgentChatAction(action));
        focusInput();
    };
    const choose = (action: AgentAction): void => {
        const completed = completeAgentChatAction(action);
        setDraft(() => completed);
        focusInput();
        // A command without arguments has nothing left to type, so choosing it runs it; a skill waits for the request.
        if (!canSend || isSending || completed !== action.invocation) return;
        // eslint-disable-next-line no-void -- runCommand reports its own failures through tryCommand
        void runCommand(completed, { name: action.invocation.slice(1) });
    };
    const stop = (): void => {
        if (!activeTurnId || isStopping) return;
        setStoppingTurnId(activeTurnId);
        interruptAgentChat(terminalId);
    };
    const paste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const { selectionEnd, selectionStart, value } = event.currentTarget;
        const warning = agentChatPasteTruncationWarning(
            {
                currentLength: value.length,
                pastedLength: event.clipboardData.getData('text/plain').length,
                selectedLength: selectionEnd - selectionStart,
            },
            MAX_AGENT_CHAT_MESSAGE_LENGTH,
        );
        if (warning) pushToast('warning', warning);
        fileInput.onPaste(event);
    };
    return (
        <div className="mx-auto w-full max-w-3xl px-4 pt-1 pb-3">
            <AgentChatQueueList
                isPaused={isQueuePaused}
                isTurnRunning={isTurnRunning}
                queue={queue}
                terminalId={terminalId}
                onAction={focusInput}
                onEdit={restoreQueued}
            />
            <form
                className={cn(
                    'relative flex flex-col rounded-lg border border-border bg-surface transition-[border-color] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) focus-within:border-muted',
                    fileInput.isDragOver && 'border-accent focus-within:border-accent',
                )}
                {...fileInput.dropHandlers}
                onSubmit={(event) => {
                    event.preventDefault();
                    // The Send button disables itself while the message is in flight, which would drop its focus.
                    focusInput();
                    // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                    void submit();
                }}
            >
                <AgentChatActivityBar activity={activity} />
                {menu.isOpen && (
                    <AgentChatCommandMenu
                        activeIndex={menu.activeIndex}
                        commands={menu.matches}
                        listId={menu.listId}
                        onChoose={choose}
                        onHover={menu.highlight}
                    />
                )}
                {images.attachments.length > 0 && (
                    <AgentChatAttachmentList
                        attachments={images.attachments}
                        onRemove={(id) => {
                            images.remove(id);
                            focusInput();
                        }}
                    />
                )}
                <Textarea
                    {...menu.inputAria}
                    aria-label="Message"
                    className="field-sizing-content max-h-48 min-h-10 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 leading-5 focus-visible:shadow-none"
                    maxLength={MAX_AGENT_CHAT_MESSAGE_LENGTH}
                    placeholder={sendAction.placeholder}
                    ref={inputReference}
                    rows={1}
                    value={draft}
                    onChange={(event) => {
                        const { value } = event.target;
                        setDraft(() => value);
                    }}
                    onKeyDown={(event) => {
                        if (menu.didHandleKey(event, { choose, complete })) return;
                        const key = {
                            key: event.key,
                            shiftKey: event.shiftKey,
                            isComposing: event.nativeEvent.isComposing,
                            repeat: event.repeat,
                        };
                        if (isTurnRunning && isAgentChatInterruptKey(key)) {
                            event.preventDefault();
                            stop();
                            return;
                        }
                        const delivery = agentChatSubmitDelivery(
                            {
                                ...key,
                                metaKey: event.metaKey,
                                ctrlKey: event.ctrlKey,
                            },
                            { isTurnRunning, isBusy },
                        );
                        if (!delivery) return;
                        event.preventDefault();
                        // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                        void submit(delivery === 'steer' ? 'steer' : undefined);
                    }}
                    onPaste={paste}
                />
                <div className="flex items-center gap-1 px-2 pb-2">
                    {/*
                     * Pasting or dropping is how most images arrive, so the picker sits with the other secondary
                     * controls beside Send rather than claiming the row's leading corner, as T3 Code does.
                     */}
                    <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
                        {supportsImages && (
                            <AgentChatAttachButton
                                isReading={images.isReading}
                                onPick={fileInput.attach}
                            />
                        )}
                        {contextUsage && <AgentChatContextMeter usage={contextUsage} />}
                        <AgentChatModelMenu snapshot={snapshot} terminalId={terminalId} />
                    </div>
                    {/* One primary action slot: Stop while a turn runs and nothing is typed, Send otherwise. */}
                    {isTurnRunning && !hasContent ? (
                        <AgentChatStopButton
                            isStopping={isStopping}
                            onStop={() => {
                                stop();
                                focusInput();
                            }}
                        />
                    ) : (
                        <Tooltip content={sendAction.tooltip}>
                            <Button
                                aria-label={sendAction.label}
                                className={AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME}
                                disabled={!isSendable}
                                size="icon"
                                type="submit"
                                variant="ghost"
                            >
                                <ArrowUp className="size-4" strokeWidth={2.25} />
                            </Button>
                        </Tooltip>
                    )}
                </div>
            </form>
        </div>
    );
}
