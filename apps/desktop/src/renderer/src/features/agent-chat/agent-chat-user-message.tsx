import type { ReactNode } from 'react';

import { proseFileReferences } from '@caxri/markdown';

import { AgentChatInvocationChip } from './agent-chat-invocation-chip';
import { AgentChatMessageImages } from './agent-chat-message-images';
import { agentChatDeliveryCaption } from './agent-chat-presentation';
import { agentChatLeadingInvocation } from './agent-chat-slash-commands';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

/**
 * The user's message, right-aligned. A message steered into a running turn says so in a quiet caption under the bubble
 * (see `agentChatDeliveryCaption`).
 */
export function AgentChatUserMessage({
    delivery,
    id,
    images,
    text,
    onOpenFile,
}: {
    delivery?: 'queued' | 'steered';
    /**
     * The message's item id, which names it when an image without a thumbnail is read back from the provider's record.
     */
    id: string;
    images?: ReadonlyArray<{ thumbnail?: string }>;
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const terminalId = useAgentChatTerminal();
    const invocation = agentChatLeadingInvocation(text);
    const caption = agentChatDeliveryCaption(delivery);
    return (
        <div className="flex flex-col items-end gap-1.5">
            {images && images.length > 0 && (
                <AgentChatMessageImages
                    className="max-w-[85%]"
                    images={images}
                    message={terminalId === undefined ? undefined : { terminalId, itemId: id }}
                />
            )}
            {text && (
                <div className="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground">
                    {invocation ? (
                        <>
                            <AgentChatInvocationChip invocation={invocation.invocation} />
                            <UserMessageText text={invocation.rest} onOpenFile={onOpenFile} />
                        </>
                    ) : (
                        <UserMessageText text={text} onOpenFile={onOpenFile} />
                    )}
                </div>
            )}
            {caption && <span className="-mt-0.5 text-[11px] leading-4 text-muted">{caption}</span>}
        </div>
    );
}

/**
 * The user's own words, verbatim, with any path they typed or dropped in (`src/app.ts:12`, an absolute path) opening in
 * the editor. The link stays in the bubble's text color with a dotted underline, so a message full of paths still reads
 * as the user's message rather than a list of links.
 */
function UserMessageText({
    text,
    onOpenFile,
}: {
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const references = onOpenFile ? proseFileReferences(text) : [];
    if (!onOpenFile || references.length === 0) return text;
    const parts: ReactNode[] = [];
    let offset = 0;
    for (const reference of references) {
        parts.push(
            text.slice(offset, reference.index),
            <button
                className="cursor-pointer border-0 bg-transparent p-0 text-left underline decoration-muted decoration-dotted underline-offset-3 transition-colors hover:text-accent hover:decoration-solid focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                key={reference.index}
                title={`Open ${reference.file}`}
                type="button"
                onClick={() => onOpenFile(reference.file)}
            >
                {reference.text}
            </button>,
        );
        offset = reference.index + reference.text.length;
    }
    parts.push(text.slice(offset));
    return parts;
}
