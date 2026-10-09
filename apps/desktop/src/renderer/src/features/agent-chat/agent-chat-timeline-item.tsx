import type { ReactNode } from 'react';
import { useId, useMemo, useState } from 'react';

import type { AgentChatItem } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { cn } from '../../lib/utilities';
import { agentChatFileChangesStat } from './agent-chat-diff';
import { AgentChatFileChanges } from './agent-chat-file-changes';
import {
    AgentChatMessage,
    AgentChatNotice,
    AgentChatReply,
    AgentChatUserMessage,
} from './agent-chat-message';
import { agentChatActivityTitle } from './agent-chat-presentation';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';

/**
 * A compact row that discloses its detail on demand. Tool activity and reasoning are secondary to the conversation, so
 * they start collapsed and keep the reply text as the thing the eye lands on.
 */
function CollapsibleRow({
    accessory,
    children,
    glyph,
    title,
    titleClassName,
}: {
    /**
     * Trailing summary after the title, such as a change's line counts.
     */
    accessory?: ReactNode;
    children: ReactNode;
    glyph: ReactNode;
    title: string;
    titleClassName?: string;
}) {
    const [isExpanded, setExpanded] = useState(false);
    const detailId = useId();
    return (
        <div className="text-[12px] leading-5">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-1 py-0.5 text-left text-muted hover:bg-[var(--selection)] focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => setExpanded((value) => !value)}
            >
                <ChevronRight
                    className={cn(
                        'size-3.5 shrink-0 transition-transform duration-100',
                        isExpanded && 'rotate-90',
                    )}
                />
                {glyph}
                <span className={cn('min-w-0 flex-1 truncate', titleClassName)}>{title}</span>
                {accessory}
            </button>
            <DisclosureMotion animate expanded={isExpanded} id={detailId} kind="agent-chat-item">
                <div className="mt-1 ml-5">{children}</div>
            </DisclosureMotion>
        </div>
    );
}

/**
 * An expanded file change shows every file's diff when it touches only a few files; a wider change starts as headers.
 */
const TIMELINE_EXPANDED_FILE_LIMIT = 3;

function OutputBlock({ text }: { text: string }) {
    if (!text) return <p className="m-0 text-muted">No output</p>;
    return (
        <pre className="m-0 max-h-80 overflow-auto rounded bg-surface px-2 py-1.5 font-mono text-[11px] leading-4 wrap-anywhere whitespace-pre-wrap text-foreground">
            {text}
        </pre>
    );
}

/**
 * A file change collapses to `N files changed` and its total line counts; expanded, it lists one diff block per file.
 */
function FileChangeRow({ item }: { item: Extract<AgentChatItem, { type: 'fileChange' }> }) {
    const stat = useMemo(() => agentChatFileChangesStat(item.changes), [item.changes]);
    return (
        <CollapsibleRow
            accessory={
                <>
                    <span className="sr-only">, {diffStatLabel(stat)}</span>
                    <DiffStat additions={stat.additions} deletions={stat.deletions} />
                </>
            }
            glyph={<AgentChatStatusGlyph status={item.status} />}
            title={agentChatActivityTitle(item)}
        >
            <AgentChatFileChanges
                changes={item.changes}
                expandAtMost={TIMELINE_EXPANDED_FILE_LIMIT}
                status={item.status}
            />
        </CollapsibleRow>
    );
}

/**
 * One timeline entry. Messages render inline; commands, file changes, tool calls, and reasoning collapse to one line.
 */
export function AgentChatTimelineItem({
    item,
    onOpenFile,
}: {
    item: AgentChatItem;
    /**
     * Opens a file the reply cites, resolved against the Chat Terminal's reachable Projects.
     */
    onOpenFile?: (target: string) => void;
}) {
    switch (item.type) {
        case 'userMessage': {
            return <AgentChatUserMessage text={item.text} />;
        }
        case 'agentMessage': {
            return <AgentChatReply item={item} onOpenFile={onOpenFile} />;
        }
        case 'reasoning': {
            if (!item.text) return null;
            return (
                <CollapsibleRow glyph={null} title={item.streaming ? 'Thinking…' : 'Thought'}>
                    <AgentChatMessage
                        className="text-muted"
                        isStreaming={item.streaming}
                        text={item.text}
                        onOpenFile={onOpenFile}
                    />
                </CollapsibleRow>
            );
        }
        case 'command': {
            return (
                <CollapsibleRow
                    glyph={<AgentChatStatusGlyph status={item.status} />}
                    title={agentChatActivityTitle(item)}
                    titleClassName="font-mono text-[11px]"
                >
                    <OutputBlock text={item.output} />
                    {item.exitCode !== undefined && item.exitCode !== 0 && (
                        <p className="m-0 mt-1 text-danger">Exit code {item.exitCode}</p>
                    )}
                </CollapsibleRow>
            );
        }
        case 'fileChange': {
            return <FileChangeRow item={item} />;
        }
        case 'toolCall': {
            return (
                <CollapsibleRow
                    glyph={<AgentChatStatusGlyph status={item.status} />}
                    title={agentChatActivityTitle(item)}
                >
                    <OutputBlock text={item.output ?? ''} />
                </CollapsibleRow>
            );
        }
        case 'notice': {
            return <AgentChatNotice item={item} />;
        }
    }
}
