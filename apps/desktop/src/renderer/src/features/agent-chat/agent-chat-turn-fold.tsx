import type { ReactNode } from 'react';
import { use, useId, useMemo, useState } from 'react';

import { Bot, ChevronRight, CircleStop, CircleX } from 'lucide-react';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import { agentChatTurnExpansionKey, agentChatTurnWorkItems } from './agent-chat-expansion';
import { AgentChatFindQueryContext, isAgentChatTurnFoldMatch } from './agent-chat-find';
import type { AgentChatTurnSubagent } from './agent-chat-tasks';
import { agentChatTurnSubagents } from './agent-chat-tasks';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import {
    agentChatTurnLabel,
    agentChatTurnTimeTooltip,
    agentChatTurnTone,
} from './agent-chat-timeline';
import { useAgentChatExpansion } from './hooks/use-agent-chat-expansion';
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
    const { t } = useTranslation();
    const title = subagent.title ?? t('agentChat.fold.subagent');
    return (
        <Tooltip content={t('agentChat.timeline.openNamed', { name: title })}>
            <Button
                aria-label={t('agentChat.fold.openSubagent', { name: title })}
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
    timeTooltip,
}: {
    detailId: string;
    isExpanded: boolean;
    label: string;
    onOpenSubagent: ((taskId: string) => void) | undefined;
    onToggle: (element: HTMLElement) => void;
    status: TurnEntry['status'];
    subagents: readonly AgentChatTurnSubagent[];
    /**
     * When the turn finished, shown on hover.
     */
    timeTooltip: string | undefined;
}) {
    const tone = agentChatTurnTone(status);
    const ToneIcon = tone === 'danger' ? CircleX : CircleStop;
    const toggleButton = (
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
            onClick={(event) => onToggle(event.currentTarget)}
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
    );
    return (
        <div className="flex min-w-0 items-center gap-1 border-b border-solid border-border pb-1">
            {timeTooltip ? (
                <Tooltip anchorMode="cursor" content={timeTooltip}>
                    {toggleButton}
                </Tooltip>
            ) : (
                toggleButton
            )}
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
 * Opens the fold while a find query matches a message folded in it, so the match can be highlighted, and folds it back
 * when a refined query stops matching. Closing the bar (an empty query) leaves it open where the reader landed, and a
 * toggle by hand hands it back to the reader (`release`). The hold sits beside the persisted expansion rather than in
 * it, so a find never rewrites what the user opened. Find opens it without the height animation (`isOpenedByFind`), so
 * the match is revealed where the settled layout puts it.
 */
function useTurnFoldFindExpansion(entry: TurnEntry, isExpandedByUser: boolean) {
    const findQuery = use(AgentChatFindQueryContext);
    const [checkedQuery, setCheckedQuery] = useState('');
    const [hold, setHold] = useState<'find' | 'kept' | undefined>();
    if (findQuery !== checkedQuery) {
        setCheckedQuery(findQuery);
        const isMatch = isAgentChatTurnFoldMatch(entry, findQuery);
        if (isMatch && !isExpandedByUser && hold === undefined) setHold('find');
        else if (!isMatch && hold === 'find') setHold(findQuery ? undefined : 'kept');
    }
    return {
        isOpen: hold !== undefined,
        isOpenedByFind: hold === 'find',
        release: () => setHold(undefined),
    };
}

/**
 * A finished turn's work and commentary behind one `Worked for 2m 1s` row with a hairline, so the prompt and the final
 * reply read as one exchange. A failed or stopped turn carries its tone in the glyph and the words, so a turn that did
 * not finish is not read as one that did. Expanded, it renders the folded entries exactly as they looked while the turn
 * ran. A subagent the turn started stays one click away on the row itself, since it has left the Background work strip
 * by the time the turn folds. A row the user opened while the turn ran keeps the fold open when the turn ends, so
 * finishing never hides what they were reading; hovering the row says when the turn finished.
 */
export function AgentChatTurnFold({
    entry,
    renderEntry,
}: {
    entry: TurnEntry;
    renderEntry: (entry: Exclude<AgentChatTimelineEntry, { kind: 'turn' }>) => ReactNode;
}) {
    const containedItems = useMemo(() => agentChatTurnWorkItems(entry), [entry]);
    const expansion = useAgentChatExpansion(agentChatTurnExpansionKey(entry.id), {
        containedItems,
    });
    const find = useTurnFoldFindExpansion(entry, expansion.isExpanded);
    const isExpanded = expansion.isExpanded || find.isOpen;
    const detailId = useId();
    const links = use(AgentChatTaskLinksContext);
    const { t } = useTranslation();
    const subagents = useMemo(
        () => (links ? agentChatTurnSubagents(turnItems(entry), links.tasksByItem) : []),
        [entry, links],
    );
    return (
        <div className="text-[12px] leading-5">
            <TurnFoldHeader
                detailId={detailId}
                isExpanded={isExpanded}
                label={agentChatTurnLabel(entry, t)}
                status={entry.status}
                subagents={subagents}
                timeTooltip={agentChatTurnTimeTooltip(entry, t)}
                onOpenSubagent={links?.openTask}
                onToggle={(element) => {
                    expansion.toggle(element, !isExpanded);
                    find.release();
                }}
            />
            <DisclosureMotion
                animate={!find.isOpenedByFind}
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
