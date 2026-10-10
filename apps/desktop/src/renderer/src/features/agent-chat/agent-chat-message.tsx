import { useDeferredValue, useMemo } from 'react';

import type { MarkdownBlockOptions } from '@caxri/markdown';
import { parseMarkdownBlocks, repairStreamingMarkdown } from '@caxri/markdown';
import type { AgentChatItem } from '@caxri/protocol';
import { CircleAlert } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import { AgentChatMessageImages } from './agent-chat-message-images';
import { agentChatNoticeMessage } from './agent-chat-presentation';

function openChatLink(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports its own failures through the callback
    void openExternalUrl(url, (message) => pushToast('error', message));
}

const CHAT_PARSE_OPTIONS: MarkdownBlockOptions = { tables: true, fileLinks: true };

/**
 * The user's message, right-aligned. A message sent while a turn ran says how it reached the Agent (`Steered` into that
 * turn, or `Queued` until it ended) in a quiet caption under the bubble.
 */
export function AgentChatUserMessage({
    delivery,
    images,
    text,
}: {
    delivery?: 'queued' | 'steered';
    images?: ReadonlyArray<{ thumbnail?: string }>;
    text: string;
}) {
    return (
        <div className="flex flex-col items-end gap-1.5">
            {images && images.length > 0 && (
                <AgentChatMessageImages className="max-w-[85%]" images={images} />
            )}
            {text && (
                <div className="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground">
                    {text}
                </div>
            )}
            {delivery && (
                <span className="-mt-0.5 text-[11px] leading-4 text-muted">
                    {delivery === 'steered' ? 'Steered' : 'Queued'}
                </span>
            )}
        </div>
    );
}

/**
 * Agent text rendered as Markdown. A streaming reply re-parses as it grows; the projection bounds every message, so the
 * parse stays small. The deferred text lets React drop intermediate deltas under load instead of queueing a render for
 * each, and unfinished syntax at the tail is completed so `**bold` does not flash as raw asterisks.
 */
export function AgentChatMessage({
    className,
    isStreaming,
    text,
    onOpenFile,
}: {
    className?: string;
    isStreaming: boolean;
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const deferredText = useDeferredValue(text);
    const source = isStreaming ? repairStreamingMarkdown(deferredText) : deferredText;
    const blocks = useMemo(() => parseMarkdownBlocks(source, CHAT_PARSE_OPTIONS), [source]);
    return (
        <div className={cn('flex flex-col gap-3 text-[13px] leading-5 wrap-anywhere', className)}>
            <MarkdownBlocks
                blocks={blocks}
                isStreaming={isStreaming}
                variant="transcript"
                onOpenFile={onOpenFile}
                onOpenUrl={openChatLink}
            />
        </div>
    );
}

/**
 * An Agent reply with its Copy action underneath. The action's row is reserved while the reply streams, so the
 * transcript does not jump when it appears, and it is shown on hover or keyboard focus to keep long transcripts calm.
 * Copy takes the Markdown source, which pastes back into an issue, a document, or another Agent intact.
 */
export function AgentChatReply({
    item,
    onOpenFile,
}: {
    item: Extract<AgentChatItem, { type: 'agentMessage' }>;
    onOpenFile?: (target: string) => void;
}) {
    return (
        <div className="group/reply">
            <AgentChatMessage
                className="text-foreground"
                isStreaming={item.streaming}
                text={item.text}
                onOpenFile={onOpenFile}
            />
            <div className="mt-0.5 flex h-6 opacity-0 transition-opacity group-focus-within/reply:opacity-100 group-hover/reply:opacity-100">
                {!item.streaming && (
                    <CopyIconButton
                        className="-ml-1"
                        copy={() => writeToClipboardWithFeedback(navigator.clipboard, item.text)}
                        label="Copy message"
                    />
                )}
            </div>
        </div>
    );
}

export function AgentChatNotice({ item }: { item: Extract<AgentChatItem, { type: 'notice' }> }) {
    const isError = item.kind === 'error';
    return (
        <div
            className={cn(
                'flex items-start gap-2 text-[12px] leading-5',
                isError ? 'text-danger' : 'text-muted',
            )}
            role={isError ? 'alert' : undefined}
        >
            {isError && <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            <span className="wrap-anywhere whitespace-pre-line">
                {agentChatNoticeMessage(item)}
            </span>
        </div>
    );
}
