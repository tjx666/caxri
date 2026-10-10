import type { RefObject } from 'react';
import { useState } from 'react';

import type { AgentChatCommand } from '@caxri/protocol';
import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';
import { ArrowUp } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { AgentChatAttachButton } from './agent-chat-attach-button';
import { AgentChatAttachmentList } from './agent-chat-attachment-list';
import { AgentChatCommandMenu } from './agent-chat-command-menu';
import { interruptAgentChat } from './agent-chat-commands';
import { readAgentChatDraft, writeAgentChatDraft } from './agent-chat-drafts';
import { isAgentChatInterruptKey, isAgentChatSubmitKey } from './agent-chat-presentation';
import { completeAgentChatCommand } from './agent-chat-slash-commands';
import { AgentChatStopButton } from './agent-chat-stop-button';
import { useAgentChatAttachments } from './hooks/use-agent-chat-attachments';
import { useAgentChatCommandMenu } from './hooks/use-agent-chat-command-menu';
import { useAgentChatImageInput } from './hooks/use-agent-chat-image-input';
import { useAgentChatSubmit } from './hooks/use-agent-chat-submit';

/**
 * Message input. Enter sends, Shift+Enter adds a line. While a turn runs, a message steers it, and Escape or the Stop
 * button that replaces Send while the input is empty interrupts it. Images can be pasted, dropped, or picked when the
 * provider accepts them, and a leading `/` offers the provider's slash commands. It shares the timeline's centered
 * column so the input lines up with the conversation, and keeps attachments, the input, and its actions inside one card
 * so they read as a single control.
 */
export function AgentChatComposer({
    activeTurnId,
    canSend,
    commands,
    contextSummary,
    inputReference,
    providerName,
    supportsImages,
    terminalId,
}: {
    /**
     * The running turn, which a message steers and Stop interrupts.
     */
    activeTurnId: string | undefined;
    canSend: boolean;
    /**
     * The provider's slash commands, from the projection.
     */
    commands: readonly AgentChatCommand[] | undefined;
    /**
     * Model and context-window line shown under the input, when the provider has reported them.
     */
    contextSummary: string | undefined;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    /**
     * The provider catalog's display name, for the placeholder.
     */
    providerName: string;
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
    const menu = useAgentChatCommandMenu(draft, commands);
    const imageInput = useAgentChatImageInput(supportsImages, images.add);
    const isTurnRunning = activeTurnId !== undefined;
    const isStopping = isTurnRunning && stoppingTurnId === activeTurnId;
    const hasContent = draft.trim().length > 0 || images.attachments.length > 0;
    const setDraft = (update: (current: string) => string): void =>
        setDraftState((current) => {
            const next = update(current);
            writeAgentChatDraft(terminalId, next);
            return next;
        });
    const {
        isSending,
        runCommand,
        submit: submitDraft,
    } = useAgentChatSubmit({
        attachments: images.attachments,
        clearSent: images.clearSent,
        commands,
        setDraft,
        terminalId,
    });
    const isSendable = canSend && !isSending && !images.isReading && hasContent;
    const submit = async (): Promise<void> => {
        if (isSendable) await submitDraft(draft);
    };
    const choose = (command: AgentChatCommand): void => {
        const completed = completeAgentChatCommand(command);
        setDraft(() => completed);
        inputReference.current?.focus();
        // A command without arguments has nothing left to type, so choosing it runs it.
        if (!canSend || isSending || command.argumentHint) return;
        // eslint-disable-next-line no-void -- runCommand reports its own failures through tryCommand
        void runCommand(completed, { name: command.name });
    };
    const stop = (): void => {
        if (!activeTurnId || isStopping) return;
        setStoppingTurnId(activeTurnId);
        interruptAgentChat(terminalId);
    };
    return (
        <div className="mx-auto w-full max-w-3xl px-4 pt-1 pb-3">
            <form
                className={cn(
                    'relative flex flex-col rounded-lg border border-border bg-surface transition-[border-color] duration-150 ease-out focus-within:border-muted',
                    imageInput.isDragOver && 'border-accent focus-within:border-accent',
                )}
                {...imageInput.dropHandlers}
                onSubmit={(event) => {
                    event.preventDefault();
                    // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                    void submit();
                }}
            >
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
                        onRemove={images.remove}
                    />
                )}
                <Textarea
                    {...menu.inputAria}
                    aria-label="Message"
                    className="field-sizing-content max-h-48 min-h-10 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 leading-5 focus-visible:shadow-none"
                    maxLength={MAX_AGENT_CHAT_MESSAGE_LENGTH}
                    placeholder={
                        isTurnRunning ? 'Steer the current turn' : `Message ${providerName}`
                    }
                    ref={inputReference}
                    rows={1}
                    value={draft}
                    onChange={(event) => {
                        const { value } = event.target;
                        setDraft(() => value);
                    }}
                    onKeyDown={(event) => {
                        if (menu.didHandleKey(event, choose)) return;
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
                        if (!isAgentChatSubmitKey(key)) return;
                        event.preventDefault();
                        // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                        void submit();
                    }}
                    onPaste={imageInput.onPaste}
                />
                <div className="flex items-center gap-1 px-2 pb-2">
                    {supportsImages && (
                        <AgentChatAttachButton
                            isReading={images.isReading}
                            onPick={imageInput.attach}
                        />
                    )}
                    <p className="m-0 min-w-0 flex-1 truncate px-1 text-right text-[11px] leading-4 text-muted">
                        {contextSummary}
                    </p>
                    {/* One primary action slot: Stop while a turn runs and nothing is typed, Send otherwise. */}
                    {isTurnRunning && !hasContent ? (
                        <AgentChatStopButton isStopping={isStopping} onStop={stop} />
                    ) : (
                        <Tooltip content="Send">
                            <Button
                                aria-label="Send"
                                disabled={!isSendable}
                                size="icon"
                                type="submit"
                            >
                                <ArrowUp className="size-4" />
                            </Button>
                        </Tooltip>
                    )}
                </div>
            </form>
        </div>
    );
}
