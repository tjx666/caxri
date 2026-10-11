import { useDeferredValue, useMemo, useState } from 'react';

import type { MarkdownBlockOptions } from '@caxri/markdown';
import { createStreamingMarkdownParser, repairStreamingMarkdown } from '@caxri/markdown';
import type { AgentChatItem } from '@caxri/protocol';
import { CircleAlert } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { cn } from '../../lib/utilities';
import { openAgentChatLink } from './agent-chat-links';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { agentChatNoticeMessage } from './agent-chat-presentation';
import { AgentChatTurnArtifactList } from './agent-chat-turn-artifact-list';
import type { AgentChatTurnArtifacts } from './agent-chat-turn-artifacts';

const CHAT_PARSE_OPTIONS: MarkdownBlockOptions = { tables: true, fileLinks: true };

/**
 * Agent text rendered as Markdown. A streaming reply is parsed incrementally: each delta re-parses only the constructs
 * that can still change and keeps every settled block as the same object, so the memoized renderer skips it on a
 * reference check (see `createStreamingMarkdownParser`). The deferred text lets React drop intermediate deltas under
 * load instead of queueing a render for each, and unfinished syntax at the tail is completed so `**bold` does not flash
 * as raw asterisks.
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
    const [parser] = useState(() => createStreamingMarkdownParser(CHAT_PARSE_OPTIONS));
    const blocks = useMemo(() => parser.parse(source), [parser, source]);
    return (
        <div className={cn('flex flex-col gap-3 text-[13px] leading-5 wrap-anywhere', className)}>
            <MarkdownBlocks
                blocks={blocks}
                isStreaming={isStreaming}
                variant="transcript"
                onOpenFile={onOpenFile}
                onOpenUrl={openAgentChatLink}
            />
        </div>
    );
}

/**
 * An Agent reply, with a Copy action and the time it was sent underneath when it is the reply that ends a turn.
 * Commentary between tool calls carries no action row, so a long turn does not reserve empty space under every reply.
 * The row appears only while the pointer is over its reply or keyboard focus reaches it, so a scrolled transcript is
 * not lined with copy icons; it keeps its height, so revealing it never shifts the transcript. Copy takes the Markdown
 * source, which pastes back into an issue, a document, or another Agent intact. The reply text is one of the two
 * selectable surfaces in an otherwise `select-none` transcript (see `announceAgentChatSelectionCopy`). A reply that
 * ends a turn which changed files or filed an issue or pull request carries those cards between its text and the action
 * row, as the Codex app does.
 */
export function AgentChatReply({
    artifacts,
    canCopy,
    item,
    onOpenFile,
}: {
    artifacts?: AgentChatTurnArtifacts;
    canCopy: boolean;
    item: Extract<AgentChatItem, { type: 'agentMessage' }>;
    onOpenFile?: (target: string) => void;
}) {
    return (
        <div className="group/reply" data-agent-chat-reply="">
            <AgentChatMessage
                className="text-foreground select-text"
                isStreaming={item.streaming}
                text={item.text}
                onOpenFile={onOpenFile}
            />
            {artifacts && <AgentChatTurnArtifactList artifacts={artifacts} />}
            {canCopy && (
                <div className="mt-0.5 flex h-6 items-center gap-1 opacity-0 group-hover/reply:opacity-100 focus-within:opacity-100">
                    {!item.streaming && (
                        <>
                            <CopyIconButton
                                className="-ml-1"
                                copy={() =>
                                    writeToClipboardWithFeedback(navigator.clipboard, item.text)
                                }
                                label="Copy message"
                            />
                            {item.createdAt !== undefined && (
                                <AgentChatMessageTime timestamp={item.createdAt} />
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * A notice in the transcript. An error is styled as one but is not a live `alert`: the timeline remounts its history on
 * every Chat switch and fold toggle, which would re-announce errors that happened long ago. A failure the user must act
 * on now lives in the dock's failure banner, which does announce.
 */
export function AgentChatNotice({ item }: { item: Extract<AgentChatItem, { type: 'notice' }> }) {
    const isError = item.kind === 'error';
    return (
        <div
            className={cn(
                'flex items-start gap-2 text-[12px] leading-5',
                isError ? 'text-danger' : 'text-muted',
            )}
        >
            {isError && <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            <span className="wrap-anywhere whitespace-pre-line">
                {agentChatNoticeMessage(item)}
            </span>
        </div>
    );
}
