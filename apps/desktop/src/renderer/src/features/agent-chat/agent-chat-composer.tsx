import type { RefObject } from 'react';
import { useState } from 'react';

import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';
import { ArrowUp, Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Tooltip } from '../../components/ui/tooltip';
import { didSendAgentChatMessage, interruptAgentChat } from './agent-chat-commands';
import { isAgentChatSubmitKey } from './agent-chat-presentation';

/**
 * Message input. Enter sends, Shift+Enter adds a line. While a turn runs, a message steers it and Stop interrupts it.
 */
export function AgentChatComposer({
    canSend,
    inputReference,
    isTurnRunning,
    terminalId,
}: {
    canSend: boolean;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    isTurnRunning: boolean;
    terminalId: string;
}) {
    const [draft, setDraft] = useState('');
    const [isSending, setSending] = useState(false);
    const isSendable = canSend && !isSending && draft.trim().length > 0;
    const submit = async (): Promise<void> => {
        if (!isSendable) return;
        setSending(true);
        try {
            if (await didSendAgentChatMessage(terminalId, draft)) setDraft('');
        } finally {
            setSending(false);
        }
    };
    return (
        <form
            className="flex items-end gap-2 border-0 border-t border-solid border-border bg-background px-3 py-2"
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
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (
                        !isAgentChatSubmitKey({
                            key: event.key,
                            shiftKey: event.shiftKey,
                            isComposing: event.nativeEvent.isComposing,
                        })
                    )
                        return;
                    event.preventDefault();
                    // eslint-disable-next-line no-void -- submit reports its own failures through tryCommand
                    void submit();
                }}
            />
            {isTurnRunning && (
                <Tooltip content="Stop">
                    <Button
                        aria-label="Stop"
                        size="icon"
                        variant="secondary"
                        onClick={() => interruptAgentChat(terminalId)}
                    >
                        <Square className="size-3.5" />
                    </Button>
                </Tooltip>
            )}
            <Tooltip content="Send">
                <Button aria-label="Send" disabled={!isSendable} size="icon" type="submit">
                    <ArrowUp className="size-4" />
                </Button>
            </Tooltip>
        </form>
    );
}
