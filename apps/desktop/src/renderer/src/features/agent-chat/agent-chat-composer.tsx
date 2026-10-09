import type { RefObject } from 'react';
import { useState } from 'react';

import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';
import { ArrowUp, Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { didSendAgentChatMessage, interruptAgentChat } from './agent-chat-commands';
import { draftAfterSend, readAgentChatDraft, writeAgentChatDraft } from './agent-chat-drafts';
import { isAgentChatInterruptKey, isAgentChatSubmitKey } from './agent-chat-presentation';

/**
 * Message input. Enter sends, Shift+Enter adds a line. While a turn runs, a message steers it and Stop or Escape
 * interrupts it. It shares the timeline's centered column so the input lines up with the conversation.
 */
export function AgentChatComposer({
    activeTurnId,
    canSend,
    contextSummary,
    inputReference,
    terminalId,
}: {
    /**
     * The running turn, which a message steers and Stop interrupts.
     */
    activeTurnId: string | undefined;
    canSend: boolean;
    /**
     * Model and context-window line shown under the input, when the provider has reported them.
     */
    contextSummary: string | undefined;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    terminalId: string;
}) {
    const [draft, setDraftState] = useState(() => readAgentChatDraft(terminalId));
    const [isSending, setSending] = useState(false);
    /**
     * The turn a Stop was requested for. Keyed by turn so the pending state ends by itself when that turn does, and a
     * later turn starts with a live Stop button.
     */
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const isTurnRunning = activeTurnId !== undefined;
    const isStopping = isTurnRunning && stoppingTurnId === activeTurnId;
    const isSendable = canSend && !isSending && draft.trim().length > 0;
    const setDraft = (update: (current: string) => string): void =>
        setDraftState((current) => {
            const next = update(current);
            writeAgentChatDraft(terminalId, next);
            return next;
        });
    const submit = async (): Promise<void> => {
        if (!isSendable) return;
        const sent = draft;
        setSending(true);
        try {
            if (await didSendAgentChatMessage(terminalId, sent))
                setDraft((current) => draftAfterSend(current, sent));
        } finally {
            setSending(false);
        }
    };
    const stop = (): void => {
        if (!activeTurnId || isStopping) return;
        setStoppingTurnId(activeTurnId);
        interruptAgentChat(terminalId);
    };
    return (
        <div className="mx-auto w-full max-w-3xl px-4 pt-1 pb-2">
            <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                    void submit();
                }}
            >
                <Textarea
                    aria-label="Message"
                    className="field-sizing-content max-h-48 min-h-9 flex-1 resize-none"
                    maxLength={MAX_AGENT_CHAT_MESSAGE_LENGTH}
                    placeholder={isTurnRunning ? 'Steer the current turn' : 'Message Codex'}
                    ref={inputReference}
                    rows={1}
                    value={draft}
                    onChange={(event) => {
                        const { value } = event.target;
                        setDraft(() => value);
                    }}
                    onKeyDown={(event) => {
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
                />
                {isTurnRunning && (
                    <Tooltip content={isStopping ? 'Stopping…' : 'Stop (Esc)'}>
                        <Button
                            aria-label={isStopping ? 'Stopping' : 'Stop'}
                            disabled={isStopping}
                            size="icon"
                            variant="secondary"
                            onClick={stop}
                        >
                            {isStopping ? (
                                <Spinner className="size-3.5" />
                            ) : (
                                <Square className="size-3.5" />
                            )}
                        </Button>
                    </Tooltip>
                )}
                <Tooltip content="Send">
                    <Button aria-label="Send" disabled={!isSendable} size="icon" type="submit">
                        <ArrowUp className="size-4" />
                    </Button>
                </Tooltip>
            </form>
            {contextSummary && (
                <p className="m-0 mt-1 truncate px-0.5 text-[11px] leading-4 text-muted">
                    {contextSummary}
                </p>
            )}
        </div>
    );
}
