import { useDeferredValue, useMemo, useRef, useState } from 'react';

import type { MarkdownBlockOptions } from '@caxri/markdown';
import { createStreamingMarkdownParser, createStreamingMarkdownRepair } from '@caxri/markdown';
import type { AgentChatItem, AgentChatTurnArtifacts } from '@caxri/protocol';
import { agentChatNoticeMessage, agentChatRetryHeadline } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, Hourglass, RotateCw, ServerCrash, WifiOff } from 'lucide-react';

import { writeToClipboardWithFeedback } from '../../../components/copy-feedback';
import { CopyIconButton } from '../../../components/markdown/copy-icon-button';
import { MarkdownBlocks } from '../../../components/markdown/markdown-blocks';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useAgentChatDiagrams } from '../hooks/use-agent-chat-diagrams';
import { useAgentChatPacedText } from '../hooks/use-agent-chat-paced-text';
import { useAgentChatReplyMenu } from '../hooks/use-agent-chat-reply-menu';
import { useAgentChatSkills } from '../hooks/use-agent-chat-skills';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { AgentChatCompactedNotice } from '../transcript/agent-chat-compacted-notice';
import { openAgentChatLink } from '../transcript/agent-chat-links';
import { AgentChatTurnArtifactList } from '../turns/agent-chat-turn-artifact-list';
import { AgentChatFeedback } from './agent-chat-feedback';
import { AgentChatMessageTime } from './agent-chat-message-time';
import { AgentChatReplyFrame } from './agent-chat-reply-frame';

const CHAT_PARSE_OPTIONS: MarkdownBlockOptions = { tables: true, fileLinks: true };

/**
 * Agent text rendered as Markdown. A streaming reply is parsed incrementally: each delta re-parses only the constructs
 * that can still change and keeps every settled block as the same object, so the memoized renderer skips it on a
 * reference check (see `createStreamingMarkdownParser`). The text is paced onto the screen a frame at a time so bursty
 * deltas read as steady typing, the deferred text lets React drop intermediate frames under load instead of queueing a
 * render for each, and unfinished syntax at the tail is completed so `**bold` does not flash as raw asterisks; the
 * repair also remembers the reply, so it rescans only the lines a delta touched.
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
    const deferredText = useDeferredValue(useAgentChatPacedText(text, isStreaming));
    const terminalId = useAgentChatTerminal();
    const [repair] = useState(createStreamingMarkdownRepair);
    const [parser] = useState(() => createStreamingMarkdownParser(CHAT_PARSE_OPTIONS));
    const source = useMemo(
        () => (isStreaming ? repair.repair(deferredText) : deferredText),
        [deferredText, isStreaming, repair],
    );
    const blocks = useMemo(() => parser.parse(source), [parser, source]);
    const diagrams = useAgentChatDiagrams();
    const skills = useAgentChatSkills();
    return (
        <div className={cn('flex flex-col gap-3 text-[13px] leading-5 wrap-anywhere', className)}>
            <MarkdownBlocks
                blocks={blocks}
                diagrams={diagrams}
                isStreaming={isStreaming}
                variant="transcript"
                onOpenFile={onOpenFile}
                onOpenUrl={openAgentChatLink}
                referenceTerminalId={terminalId}
                skills={skills}
            />
        </div>
    );
}

/**
 * An Agent reply, with a Copy action and the time it was sent underneath when it is the reply that ends a turn.
 * Commentary between tool calls carries no action row, so a long turn does not reserve empty space under every reply.
 * Every reply, the latest included, mounts its row only while the pointer is over it or keyboard focus is inside it
 * (`AgentChatReplyFrame`), so neither a finished turn nor a scrolled transcript is lined with copy icons and times. The
 * row keeps its height either way, so revealing it never shifts the transcript. Copy takes the Markdown source, which
 * pastes back into an issue, a document, or another Agent intact. The reply text is selectable in an otherwise
 * `select-none` transcript, as are the user's messages, notice text, reasoning, and code and diff bodies; a native
 * Cmd+C copies silently, as macOS apps do, and releasing a selection floats Copy and Add to message over it
 * (`AgentChatSelectionToolbar`). A right-click offers the same native menu a user message leads with (Copy for a
 * selection inside the reply, Copy Message for its Markdown source, and Add to Message), on every reply including
 * commentary that carries no action row. A reply that ends a turn which changed files or filed an issue or pull request
 * carries those cards between its text and the action row, as the Codex app does.
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
    const { t } = useTranslation();
    const container = useRef<HTMLDivElement>(null);
    const onContextMenu = useAgentChatReplyMenu({ container, text: item.text });
    const actions = canCopy
        ? !item.streaming && (
              <>
                  <CopyIconButton
                      className="-ml-1"
                      copy={() => writeToClipboardWithFeedback(navigator.clipboard, item.text)}
                      label={t('agentChat.message.copy')}
                  />
                  {item.createdAt !== undefined && (
                      <AgentChatMessageTime timestamp={item.createdAt} />
                  )}
              </>
          )
        : null;
    return (
        <AgentChatReplyFrame
            actions={actions}
            data-agent-chat-reply=""
            ref={container}
            onContextMenu={onContextMenu}
        >
            <AgentChatMessage
                className="text-foreground select-text"
                isStreaming={item.streaming}
                text={item.text}
                onOpenFile={onOpenFile}
            />
            {artifacts && <AgentChatTurnArtifactList artifacts={artifacts} />}
        </AgentChatReplyFrame>
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
    if (item.title || item.kind === 'warning') return <AgentChatFeedback item={item} />;
    if (item.kind === 'compacted') return <AgentChatCompactedNotice item={item} />;
    if (item.kind === 'retrying') return <AgentChatRetryNotice item={item} />;
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

type RetryNotice = Extract<AgentChatItem, { type: 'notice' }>;

const RETRY_ICONS: Record<NonNullable<RetryNotice['retry']>['cause'], LucideIcon> = {
    connection: WifiOff,
    rateLimit: Hourglass,
    overloaded: ServerCrash,
    server: ServerCrash,
    other: RotateCw,
};

/**
 * A provider retrying a failed request: a `--warning` headline led by its cause's icon (a dropped connection shows
 * Wi-Fi off), with the attempt against the provider's limit, and the provider's own detail muted beneath it. A muted
 * line read as routine progress while the Agent was in fact stalled on a failing request.
 */
function AgentChatRetryNotice({ item }: { item: RetryNotice }) {
    const { t } = useTranslation();
    const Icon = item.retry ? RETRY_ICONS[item.retry.cause] : RotateCw;
    const headline = item.retry
        ? agentChatRetryHeadline(item.retry, t)
        : agentChatNoticeMessage(item, t);
    const detail = item.retry ? item.message : undefined;
    return (
        <div className="flex items-start gap-2 text-[12px] leading-5" role="status">
            <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <div className="min-w-0 select-text">
                <div className="text-warning">{headline}</div>
                {detail && (
                    <div className="wrap-anywhere whitespace-pre-line text-muted">{detail}</div>
                )}
            </div>
        </div>
    );
}
