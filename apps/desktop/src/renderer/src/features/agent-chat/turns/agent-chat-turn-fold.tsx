import type { ReactNode } from 'react';
import { use, useId, useMemo, useRef, useState } from 'react';

import { agentChatTurnLabel } from '@caxri/protocol';
import { Bot, ChevronRight, CircleStop, CircleX } from 'lucide-react';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { AgentChatFindQueryContext, isAgentChatTurnFoldMatch } from '../find/agent-chat-find';
import {
    useAgentChatExpansion,
    useAgentChatRevealWorkItem,
} from '../hooks/use-agent-chat-expansion';
import { AgentChatTaskLinksContext } from '../hooks/use-agent-chat-task-link';
import type { AgentChatTurnSubagent } from '../tasks/agent-chat-tasks';
import { agentChatTurnSubagents } from '../tasks/agent-chat-tasks';
import { agentChatChevronMotion } from '../transcript/agent-chat-disclosure';
import {
    agentChatRevealItemKeys,
    agentChatTurnExpansionKey,
    agentChatTurnWorkItems,
} from '../transcript/agent-chat-expansion';
import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';
import { agentChatTurnTimeTooltip, agentChatTurnTone } from '../transcript/agent-chat-timeline';

type TurnEntry = Extract<AgentChatTimelineEntry, { kind: 'turn' }>;

function* turnItems(entry: TurnEntry) {
    for (const child of entry.entries) {
        if (child.kind === 'work') yield* child.items;
        else if (child.kind === 'item') yield child.item;
    }
}

/**
 * One of the turn's subagents, named by its own title, with the activity sweep while it still runs. Where the host can
 * open a tab beside the Chat it reopens the subagent there; elsewhere (Caxri Bot window) it expands the fold and
 * scrolls to the subagent's row instead, and says so, since nothing opens (issue caxri#1952). With neither it is a
 * plain label rather than a button.
 */
function TurnSubagentButton({
    onOpen,
    onReveal,
    subagent,
}: {
    onOpen: ((taskId: string) => void) | undefined;
    onReveal: ((itemId: string, element: HTMLElement) => void) | undefined;
    subagent: AgentChatTurnSubagent;
}) {
    const { t } = useTranslation();
    const title = subagent.title ?? t('agentChat.fold.subagent');
    const content = (
        <>
            <Bot aria-hidden="true" className="size-3.5 shrink-0" />
            <span className={cn('min-w-0 truncate', subagent.isRunning && 'activity-shimmer')}>
                {title}
            </span>
        </>
    );
    const className = 'min-h-6 max-w-48 min-w-0 shrink gap-1 px-1.5 text-muted';
    if (onOpen) {
        return (
            <Tooltip content={t('agentChat.timeline.openNamed', { name: title })}>
                <Button
                    aria-label={t('agentChat.fold.openSubagent', { name: title })}
                    className={className}
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpen(subagent.taskId)}
                >
                    {content}
                </Button>
            </Tooltip>
        );
    }
    if (!onReveal) return <span className={cn('flex items-center', className)}>{content}</span>;
    const label = t('agentChat.fold.showSubagent', { name: title });
    return (
        <Tooltip content={label}>
            <Button
                aria-label={label}
                className={className}
                size="sm"
                variant="ghost"
                onClick={(event) => onReveal(subagent.itemId, event.currentTarget)}
            >
                {content}
            </Button>
        </Tooltip>
    );
}

/**
 * The fold's `Worked for 2m 1s` toggle, with an entry per subagent the turn started.
 */
function TurnFoldHeader({
    detailId,
    isExpanded,
    label,
    onOpenSubagent,
    onRevealSubagent,
    onToggle,
    subagents,
    timeTooltip,
    tone,
}: {
    detailId: string;
    isExpanded: boolean;
    label: string;
    onOpenSubagent: ((taskId: string) => void) | undefined;
    onRevealSubagent: ((itemId: string, element: HTMLElement) => void) | undefined;
    onToggle: (element: HTMLElement) => void;
    subagents: readonly AgentChatTurnSubagent[];
    /**
     * When the turn finished, shown on hover.
     */
    timeTooltip: string | undefined;
    tone: ReturnType<typeof agentChatTurnTone>;
}) {
    const ToneIcon = tone === 'danger' ? CircleX : CircleStop;
    // The toggle keeps its label's width; the subagent chips beside it are what shrink and truncate when a turn
    // spawned more of them than the row fits.
    const toggleButton = (
        <button
            aria-controls={detailId}
            aria-expanded={isExpanded}
            className={cn(
                'flex flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-0 pt-0.5 pb-0.5 text-left whitespace-nowrap focus-visible:outline focus-visible:outline-accent',
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
            {subagents.map((subagent) => (
                <TurnSubagentButton
                    key={subagent.taskId}
                    subagent={subagent}
                    onOpen={onOpenSubagent}
                    onReveal={onRevealSubagent}
                />
            ))}
        </div>
    );
}

/**
 * The row of a stopped turn that did no work: the fold row's glyph, words, and hairline, but nothing to open, so it is
 * text rather than a toggle.
 */
function TurnOutcomeRow({ entry }: { entry: TurnEntry }) {
    const { t } = useTranslation();
    const tone = agentChatTurnTone(entry);
    const timeTooltip = agentChatTurnTimeTooltip(entry, t);
    const row = (
        <div
            className={cn(
                'flex w-fit min-w-0 items-center gap-2 py-0.5',
                tone === 'warning' ? 'text-warning' : 'text-muted',
            )}
            data-agent-chat-turn-outcome=""
        >
            <CircleStop aria-hidden="true" className="size-3.5 shrink-0" />
            <span>{agentChatTurnLabel(entry, t)}</span>
        </div>
    );
    return (
        <div className="border-b border-solid border-border pb-1 text-[12px] leading-5">
            {timeTooltip ? (
                <Tooltip anchorMode="cursor" content={timeTooltip}>
                    {row}
                </Tooltip>
            ) : (
                row
            )}
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
 * ran. A subagent the turn started stays named on the row itself, one click from its tab or its row, since it may have
 * left the Background work strip by the time the turn folds. A row the user opened while the turn ran keeps the fold
 * open when the turn ends, so finishing never hides what they were reading; hovering the row says when the turn
 * finished.
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
    const reveal = useAgentChatRevealWorkItem();
    const container = useRef<HTMLDivElement>(null);
    const subagents = useMemo(
        () => (links ? agentChatTurnSubagents(turnItems(entry), links.tasksByItem) : []),
        [entry, links],
    );
    if (entry.entries.length === 0) return <TurnOutcomeRow entry={entry} />;
    return (
        <div className="text-[12px] leading-5" ref={container}>
            <TurnFoldHeader
                detailId={detailId}
                isExpanded={isExpanded}
                label={agentChatTurnLabel(entry, t)}
                tone={agentChatTurnTone(entry)}
                subagents={subagents}
                timeTooltip={agentChatTurnTimeTooltip(entry, t)}
                onOpenSubagent={links?.openTask}
                onRevealSubagent={
                    reveal &&
                    ((itemId, element) => {
                        find.release();
                        reveal({
                            container: container.current,
                            element,
                            itemId,
                            keys: agentChatRevealItemKeys(
                                entry,
                                itemId,
                                (item) => links?.tasksByItem.has(item.id) === true,
                            ),
                        });
                    })
                }
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
