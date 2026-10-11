import type { ReactNode } from 'react';
import { use, useId, useMemo, useState } from 'react';

import { Bot, ChevronRight, CircleStop, CircleX } from 'lucide-react';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import { AgentChatFindQueryContext, isAgentChatTurnFoldMatch } from './agent-chat-find';
import type { AgentChatTurnSubagent } from './agent-chat-tasks';
import { agentChatTurnSubagents } from './agent-chat-tasks';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { agentChatTurnTone } from './agent-chat-timeline';
import { AgentChatTaskLinksContext } from './hooks/use-agent-chat-task-link';

type TurnEntry = Extract<AgentChatTimelineEntry, { kind: 'turn' }>;

function* turnItems(entry: TurnEntry) {
    for (const child of entry.entries) {
        if (child.kind === 'work') yield* child.items;
        else if (child.kind === 'item') yield child.item;
    }
}

/**
 * Reopens one of the turn's subagents beside the Chat, named by the subagent's own title.
 */
function TurnSubagentButton({
    onOpen,
    subagent,
}: {
    onOpen: (taskId: string) => void;
    subagent: AgentChatTurnSubagent;
}) {
    const title = subagent.title ?? 'Subagent';
    return (
        <Tooltip content={`Open ${title}`}>
            <Button
                aria-label={`Open subagent ${title}`}
                className="min-h-6 max-w-48 min-w-0 shrink gap-1 px-1.5 text-muted"
                size="sm"
                variant="ghost"
                onClick={() => onOpen(subagent.taskId)}
            >
                <Bot aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{title}</span>
            </Button>
        </Tooltip>
    );
}

/**
 * The fold's `Worked for 2m 1s` toggle, with a button per subagent the turn started.
 */
function TurnFoldHeader({
    detailId,
    isExpanded,
    label,
    onOpenSubagent,
    onToggle,
    status,
    subagents,
}: {
    detailId: string;
    isExpanded: boolean;
    label: string;
    onOpenSubagent: ((taskId: string) => void) | undefined;
    onToggle: () => void;
    status: TurnEntry['status'];
    subagents: readonly AgentChatTurnSubagent[];
}) {
    const tone = agentChatTurnTone(status);
    const ToneIcon = tone === 'danger' ? CircleX : CircleStop;
    return (
        <div className="flex min-w-0 items-center gap-1 border-b border-solid border-border pb-1">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                className={cn(
                    'flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-0 pt-0.5 pb-0.5 text-left focus-visible:outline focus-visible:outline-accent',
                    tone === 'danger'
                        ? 'text-danger'
                        : tone === 'warning'
                          ? 'text-warning'
                          : 'text-muted hover:text-foreground',
                )}
                type="button"
                onClick={onToggle}
            >
                {tone && <ToneIcon aria-hidden="true" className="size-3.5 shrink-0" />}
                <span>{label}</span>
                <ChevronRight
                    aria-hidden="true"
                    className={cn(
                        'size-3.5 shrink-0',
                        agentChatChevronMotion(isExpanded),
                        isExpanded && 'rotate-90',
                    )}
                />
            </button>
            {onOpenSubagent &&
                subagents.map((subagent) => (
                    <TurnSubagentButton
                        key={subagent.taskId}
                        subagent={subagent}
                        onOpen={onOpenSubagent}
                    />
                ))}
        </div>
    );
}

/**
 * A finished turn's work and commentary behind one `Worked for 2m 1s` row with a hairline, so the prompt and the final
 * reply read as one exchange. A failed or stopped turn carries its tone in the glyph and the words, so a turn that did
 * not finish is not read as one that did. Expanded, it renders the folded entries exactly as they looked while the turn
 * ran. A subagent the turn started stays one click away on the row itself, since it has left the Background work strip
 * by the time the turn folds.
 */
export function AgentChatTurnFold({
    entry,
    renderEntry,
}: {
    entry: TurnEntry;
    renderEntry: (entry: Exclude<AgentChatTimelineEntry, { kind: 'turn' }>) => ReactNode;
}) {
    const [isExpanded, setExpanded] = useState(false);
    /**
     * A find query that matches a message folded here opens the fold, so the match can be highlighted, and folds it
     * back when a refined query stops matching. Closing the bar leaves it open where the reader landed, and toggling it
     * by hand hands it back to the reader. Find opens it without the height animation, so the match is revealed where
     * the settled layout puts it.
     */
    const findQuery = use(AgentChatFindQueryContext);
    const [checkedQuery, setCheckedQuery] = useState('');
    const [isOpenedByFind, setOpenedByFind] = useState(false);
    if (findQuery !== checkedQuery) {
        setCheckedQuery(findQuery);
        const isMatch = isAgentChatTurnFoldMatch(entry, findQuery);
        if (isMatch && !isExpanded) {
            setExpanded(true);
            setOpenedByFind(true);
        } else if (!isMatch && isOpenedByFind) {
            if (findQuery) setExpanded(false);
            setOpenedByFind(false);
        }
    }
    const detailId = useId();
    const links = use(AgentChatTaskLinksContext);
    const subagents = useMemo(
        () => (links ? agentChatTurnSubagents(turnItems(entry), links.tasksByItem) : []),
        [entry, links],
    );
    return (
        <div className="text-[12px] leading-5">
            <TurnFoldHeader
                detailId={detailId}
                isExpanded={isExpanded}
                label={entry.label}
                status={entry.status}
                subagents={subagents}
                onOpenSubagent={links?.openTask}
                onToggle={() => {
                    setExpanded((value) => !value);
                    setOpenedByFind(false);
                }}
            />
            <DisclosureMotion
                animate={!isOpenedByFind}
                expanded={isExpanded}
                id={detailId}
                kind="agent-chat-turn"
            >
                <div className="mt-3 flex flex-col gap-3">
                    {entry.entries.map((child) => renderEntry(child))}
                </div>
            </DisclosureMotion>
        </div>
    );
}
