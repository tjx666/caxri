import { useDeferredValue, useMemo, useState } from 'react';

import type { MarkdownBlockOptions } from '@caxri/markdown';
import { createStreamingMarkdownParser, createStreamingMarkdownRepair } from '@caxri/markdown';
import type { AgentChatItem } from '@caxri/protocol';
import { CircleAlert } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../components/copy-feedback';
import { CopyIconButton } from '../../components/markdown/copy-icon-button';
import { MarkdownBlocks } from '../../components/markdown/markdown-blocks';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { openAgentChatLink } from './agent-chat-links';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { agentChatNoticeMessage } from './agent-chat-presentation';
import { AgentChatTurnArtifactList } from './agent-chat-turn-artifact-list';
import type { AgentChatTurnArtifacts } from './agent-chat-turn-artifacts';
import { useAgentChatTerminal } from './hooks/use-agent-chat-terminal';

const CHAT_PARSE_OPTIONS: MarkdownBlockOptions = { tables: true, fileLinks: true };

/**
 * Agent text rendered as Markdown. A streaming reply is parsed incrementally: each delta re-parses only the constructs
 * that can still change and keeps every settled block as the same object, so the memoized renderer skips it on a
 * reference check (see `createStreamingMarkdownParser`). The deferred text lets React drop intermediate deltas under
 * load instead of queueing a render for each, and unfinished syntax at the tail is completed so `**bold` does not flash
 * as raw asterisks; the repair also remembers the reply, so it rescans only the lines a delta touched.
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
    const terminalId = useAgentChatTerminal();
    const [repair] = useState(createStreamingMarkdownRepair);
    const [parser] = useState(() => createStreamingMarkdownParser(CHAT_PARSE_OPTIONS));
    const source = useMemo(
        () => (isStreaming ? repair.repair(deferredText) : deferredText),
        [deferredText, isStreaming, repair],
    );
    const blocks = useMemo(() => parser.parse(source), [parser, source]);
    return (
        <div className={cn('flex flex-col gap-3 text-[13px] leading-5 wrap-anywhere', className)}>
            <MarkdownBlocks
                blocks={blocks}
                isStreaming={isStreaming}
                variant="transcript"
                onOpenFile={onOpenFile}
                onOpenUrl={openAgentChatLink}
                referenceTerminalId={terminalId}
            />
        </div>
    );
}

/**
 * An Agent reply, with a Copy action and the time it was sent underneath when it is the reply that ends a turn.
 * Commentary between tool calls carries no action row, so a long turn does not reserve empty space under every reply.
 * The latest turn's reply keeps the row in view (Copy in `--muted`, rising to `--foreground` on hover), since it is the
 * one most likely to be taken away; an earlier reply's row appears only while the pointer is over it or keyboard focus
 * reaches it, so a scrolled transcript is not lined with copy icons. The row keeps its height either way, so revealing
 * it never shifts the transcript. Copy takes the Markdown source, which pastes back into an issue, a document, or
 * another Agent intact. The reply text is selectable in an otherwise `select-none` transcript, as are the user's
 * messages, notice text, reasoning, and code and diff bodies (see `announceAgentChatSelectionCopy`). A reply that ends
 * a turn which changed files or filed an issue or pull request carries those cards between its text and the action row,
 * as the Codex app does.
 */
export function AgentChatReply({
    artifacts,
    canCopy,
    isLatest = false,
    item,
    onOpenFile,
}: {
    artifacts?: AgentChatTurnArtifacts;
    canCopy: boolean;
    /**
     * The final reply of the most recent turn (`isLatestReply`).
     */
    isLatest?: boolean;
    item: Extract<AgentChatItem, { type: 'agentMessage' }>;
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
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
                <div
                    className={cn(
                        'mt-0.5 flex h-6 items-center gap-1',
                        !isLatest &&
                            'opacity-0 group-hover/reply:opacity-100 focus-within:opacity-100',
                    )}
                    data-agent-chat-find-ignore=""
                >
                    {!item.streaming && (
                        <>
                            <CopyIconButton
                                className="-ml-1"
                                copy={() =>
                                    writeToClipboardWithFeedback(navigator.clipboard, item.text)
                                }
                                label={t('agentChat.message.copy')}
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
 * on now lives in the dock's failure banner, which does announce. Its text is selectable so an error can be copied into
 * a search or an issue.
 */
export function AgentChatNotice({ item }: { item: Extract<AgentChatItem, { type: 'notice' }> }) {
    const { t } = useTranslation();
    const isError = item.kind === 'error';
    return (
        <div
            className={cn(
                'flex items-start gap-2 text-[12px] leading-5',
                isError ? 'text-danger' : 'text-muted',
            )}
        >
            {isError && <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            <span className="wrap-anywhere whitespace-pre-line select-text">
                {agentChatNoticeMessage(item, t)}
            </span>
        </div>
    );
}
