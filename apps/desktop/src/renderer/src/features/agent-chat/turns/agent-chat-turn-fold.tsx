import type { ReactNode } from 'react';
import { use, useId, useMemo, useRef, useState } from 'react';

import type { AgentChatTurnMetrics } from '@caxri/protocol';
import { agentChatTurnLabel } from '@caxri/protocol';
import { ChevronRight, CircleStop, CircleX } from 'lucide-react';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { AgentChatTurnMetricList } from '../activity/agent-chat-turn-metric-list';
import { agentChatTurnRate } from '../activity/agent-chat-turn-metrics';
import { AgentChatFindQueryContext, isAgentChatTurnFoldMatch } from '../find/agent-chat-find';
import {
    useAgentChatExpansion,
    useAgentChatRevealWorkItem,
} from '../hooks/use-agent-chat-expansion';
import { AgentChatTaskLinksContext } from '../hooks/use-agent-chat-task-link';
import type { AgentChatTurnSubagent } from '../tasks/agent-chat-tasks';
import { agentChatTurnSubagents } from '../tasks/agent-chat-tasks';
import { AgentChatTurnSubagents } from '../tasks/agent-chat-turn-subagents';
import { agentChatChevronMotion } from '../transcript/agent-chat-disclosure';
import {
    agentChatRevealItemKeys,
    agentChatTurnExpansionKey,
    agentChatTurnWorkItems,
} from '../transcript/agent-chat-expansion';
import type { AgentChatTimelineEntry } from '../transcript/agent-chat-timeline';
import { agentChatTurnTimeTooltip, agentChatTurnTone } from '../transcript/agent-chat-timeline';

/**
 * Keeps the fold row's figures out of sight until the reader points at the row or moves focus into it, so a settled
 * transcript reads as `Worked for 58s` rows and replies. They keep their width while hidden, so revealing them never
 * shifts the row, and they stay shown while the subagent list they anchor is open.
 */
const REVEAL_CLASS_NAME =
    'pointer-events-none opacity-0 transition-opacity group-focus-within/turn-fold:pointer-events-auto group-focus-within/turn-fold:opacity-100 group-hover/turn-fold:pointer-events-auto group-hover/turn-fold:opacity-100 group-has-[[data-popup-open]]/turn-fold:pointer-events-auto group-has-[[data-popup-open]]/turn-fold:opacity-100';

type TurnEntry = Extract<AgentChatTimelineEntry, { kind: 'turn' }>;

function* turnItems(entry: TurnEntry) {
    for (const child of entry.entries) {
        if (child.kind === 'work') yield* child.items;
        else if (child.kind === 'item') yield child.item;
    }
}

/**
 * The fold's `Worked for 2m 1s` toggle. Pointing at the row reveals, at its end, how many subagents the turn started
 * and what it spent: steps, tokens, estimated cost, and output rate. A subagent still running keeps its count in view.
 */
function TurnFoldHeader({
    detailId,
    isExpanded,
    label,
    metrics,
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
    /**
     * What the finished turn spent, shown at the row's end; absent when none was recorded.
     */
    metrics: AgentChatTurnMetrics | undefined;
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
    const { t } = useTranslation();
    const ToneIcon = tone === 'danger' ? CircleX : CircleStop;
    const rate = agentChatTurnRate(metrics, t);
    const isSubagentRunning = subagents.some((subagent) => subagent.isRunning);
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
        <div
            className={cn(
                'group/turn-fold flex min-w-0 items-center gap-2.5 border-b border-solid border-border pb-1',
                // Expanded, the row pins to the top of the transcript so a run several screens long can be folded
                // from wherever the reader stopped (LibreChat's activity groups do the same). Its containing block is
                // the fold, so it lets go where the fold's last row ends and never covers the final reply.
                isExpanded && 'sticky top-0 z-10 bg-background',
            )}
        >
            {timeTooltip ? (
                <Tooltip anchorMode="cursor" content={timeTooltip}>
                    {toggleButton}
                </Tooltip>
            ) : (
                toggleButton
            )}
            {subagents.length > 0 && (
                <span className={cn('flex', !isSubagentRunning && REVEAL_CLASS_NAME)}>
                    <AgentChatTurnSubagents
                        subagents={subagents}
                        onOpen={onOpenSubagent}
                        onReveal={onRevealSubagent}
                    />
                </span>
            )}
            {metrics && (
                <span className={cn('flex text-muted', REVEAL_CLASS_NAME)}>
                    <AgentChatTurnMetricList
                        hasLeadingDivider={subagents.length > 0}
                        rate={rate}
                        usage={{
                            requests: metrics.requests ?? 0,
                            totalTokens: metrics.totalTokens ?? 0,
                            costUsd: metrics.costUsd,
                        }}
                    />
                </span>
            )}
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
 * ran. A subagent the turn started stays counted on the row itself, one click from its tab or its row, since it may
 * have left the Background work strip by the time the turn folds. A row the user opened while the turn ran keeps the
 * fold open when the turn ends, so finishing never hides what they were reading; hovering the row says when the turn
 * finished. A finished turn's steps, tokens, estimated cost, and output rate sit at the row's end in the status row's
 * figures, shown on hover.
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
                metrics={entry.metrics}
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
