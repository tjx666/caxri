import { useId, useMemo, useState } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';
import type { AgentChatMemoryArtifact } from '@caxri/protocol';
import {
    agentChatEditedFileLines,
    agentChatMemoryActionLabel,
    agentChatMemoryTitle,
    agentChatMemoryTypeLabel,
} from '@caxri/protocol';
import { Brain, ChevronDown } from 'lucide-react';

import { DiffStat } from '../../../../components/diff-stat';
import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { MarkdownBlocks } from '../../../../components/markdown/markdown-blocks';
import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { openAgentChatLink } from '../../transcript/agent-chat-links';
import { AgentChatDiff } from '../agent-chat-file-changes';

/**
 * What an opened memory card shows: a new memory's Markdown, since its diff carried the whole file, or the diff of an
 * update or a deletion, whose hunks alone do not.
 */
function MemoryDetail({ memory }: { memory: AgentChatMemoryArtifact }) {
    const blocks = useMemo(
        () => (memory.body ? parseMarkdownBlocks(memory.body) : undefined),
        [memory.body],
    );
    const lines = useMemo(
        () => (blocks ? [] : agentChatEditedFileLines(memory.file)),
        [blocks, memory.file],
    );
    return (
        <div className="border-t border-border">
            {memory.description && (
                <div className="truncate px-3 pt-2 font-mono text-[11px] text-muted">
                    {memory.name}
                </div>
            )}
            {blocks ? (
                <div className="flex flex-col gap-1.5 px-3 py-2 text-[13px] leading-5 wrap-anywhere select-text">
                    <MarkdownBlocks
                        blocks={blocks}
                        variant="transcript"
                        onOpenUrl={openAgentChatLink}
                    />
                </div>
            ) : (
                <div
                    className={cn(
                        'bg-background select-text',
                        memory.description && 'mt-2 border-t border-border',
                    )}
                >
                    <AgentChatDiff lines={lines} truncated={memory.file.truncated} />
                </div>
            )}
        </div>
    );
}

/**
 * A memory the Agent saved, updated, or forgot this turn, in place of the raw frontmatter diff the edited-files card
 * would show: a brain tile, the memory's one-line description as the title, and its category beside what was done.
 * Clicking the card opens the memory below it.
 */
export function AgentChatMemoryCard({ memory }: { memory: AgentChatMemoryArtifact }) {
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(false);
    const detailId = useId();
    const action = agentChatMemoryActionLabel(memory, t);
    const type = agentChatMemoryTypeLabel(memory, t);
    const title = agentChatMemoryTitle(memory);
    return (
        <div
            className="overflow-hidden rounded-lg border border-border bg-surface"
            data-agent-chat-memory={memory.action}
        >
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                aria-label={t(isExpanded ? 'agentChat.memory.hide' : 'agentChat.memory.show', {
                    action,
                    title,
                })}
                className="flex w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-3 py-2.5 text-left transition-colors hover:bg-elevated focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none"
                type="button"
                onClick={() => setExpanded(!isExpanded)}
            >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-foreground">
                    <Brain aria-hidden="true" className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="line-clamp-2 text-[13px] leading-5 text-foreground">
                        {title}
                    </span>
                    <span className="truncate text-[12px] leading-5 text-muted">
                        {type ? `${type} · ${action}` : action}
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
                    {!memory.body && (
                        <DiffStat
                            additions={memory.file.additions}
                            deletions={memory.file.deletions}
                        />
                    )}
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            'size-3.5 transition-transform duration-(--motion-expand) ease-(--motion-ease-emphasized) motion-reduce:transition-none',
                            isExpanded && 'rotate-180',
                        )}
                    />
                </span>
            </button>
            <DisclosureMotion animate expanded={isExpanded} id={detailId} kind="agent-chat-memory">
                <MemoryDetail memory={memory} />
            </DisclosureMotion>
        </div>
    );
}
