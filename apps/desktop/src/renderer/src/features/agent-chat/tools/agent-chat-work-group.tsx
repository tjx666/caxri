import type { CSSProperties, ReactNode } from 'react';
import { memo, useContext, useId, useMemo, useRef } from 'react';

import type { AgentChatTask, AgentChatWorkItem } from '@caxri/protocol';
import {
    agentChatActiveWork,
    agentChatFileChangesStat,
    agentChatTaskActivity,
    agentChatTaskGlyphStatus,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    agentChatWorkSummaryGlyph,
    agentChatWorkSummaryItems,
    agentChatWorkSummaryPhrases,
    agentChatWorkVerb,
    describeAgentChatWorkRow,
    isAgentChatWorkRowRunning,
    isAgentChatWorkRunning,
    mergeAgentChatReasoning,
    splitAgentChatWork,
} from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { DiffStat } from '../../../components/diff-stat';
import { DisclosureMotion } from '../../../components/disclosure-motion';
import { useHasLasted } from '../../../hooks/use-has-lasted';
import { useScrollEdges } from '../../../hooks/use-scroll-edges';
import { useTranslation } from '../../../i18n';
import { diffStatLabel } from '../../../lib/diff-stat-label';
import { cn } from '../../../lib/utilities';
import { useAgentChatExpansion } from '../hooks/use-agent-chat-expansion';
import { AgentChatTaskLinksContext, useAgentChatTaskLink } from '../hooks/use-agent-chat-task-link';
import { AgentChatTaskElapsed } from '../tasks/agent-chat-task-glyph';
import { AgentChatTaskOpenButton } from '../tasks/agent-chat-task-open-button';
import { agentChatChevronMotion } from '../transcript/agent-chat-disclosure';
import {
    agentChatItemExpansionKey,
    agentChatSummaryExpansionKey,
} from '../transcript/agent-chat-expansion';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatWorkFileLink } from './agent-chat-work-file-link';
import { AgentChatWorkGlyph } from './agent-chat-work-glyph';
import { AgentChatWorkDetail } from './work-detail/agent-chat-work-detail';
import { AgentChatWorkSummaryTitle } from './work-summary/agent-chat-work-summary-title';

/**
 * Work still running animates its tool glyph (`AgentChatWorkGlyph`) and sweeps a highlight across its whole title
 * instead of swapping in a spinner, so a column of rows does not flicker as each one starts and ends. The sweep clips
 * to the title's text, so a running title renders plain text only (no file control).
 */
const RUNNING_TITLE_CLASS_NAME = 'activity-shimmer';

/**
 * An expanded work group taller than this scrolls, fading whichever edge hides rows, so a turn that ran dozens of tools
 * does not push the conversation away.
 */
const WORK_LIST_CLASS_NAME = 'max-h-60 overflow-y-auto';

/**
 * How far the scroll edge fade reaches into the list, about one row.
 */
const WORK_LIST_FADE = '24px';

/**
 * A one-line disclosure row: a glyph, the title, and trailing facts, with the detail mounted only while expanded. A
 * `subtitle` adds a second, muted line under the title (a subagent's result), with the glyph and facts on the first.
 * Work is secondary to the conversation, so every row starts collapsed and the reply stays what the eye lands on; the
 * one exception is a thought that stands in for the reply (`isDefaultExpanded`).
 *
 * The toggle is a transparent button stretched over the whole row rather than the row's wrapper, so the title can hold
 * a control of its own (a file the row names) without nesting a button inside another; that control sits above the
 * toggle, and the rest of the row still toggles. The toggle takes its accessible name from the title and trailing facts
 * (`aria-labelledby`), since its visible text is a sibling now.
 *
 * Its expanded state lives with the Chat pane under `expansionKey` (see `useAgentChatExpansion`), so a row keeps it
 * when the timeline rebuilds around it, such as a live row merging into a summary group once it settles.
 */
function DisclosureRow({
    action,
    children,
    containedItems,
    disclosureKind,
    expansionKey,
    glyph,
    isDefaultExpanded = false,
    isList = false,
    isRunning = false,
    itemId,
    subtitle,
    title,
    trailing,
}: {
    /**
     * A control beside the row, outside its toggle button (a button cannot nest inside another).
     */
    action?: ReactNode;
    children: ReactNode;
    /**
     * Items listed inside this row; it opens by default when the user expanded one of them on its own.
     */
    containedItems?: readonly AgentChatWorkItem[];
    disclosureKind: string;
    expansionKey: string;
    glyph: ReactNode;
    /**
     * Opens the row until the user collapses it, for the one row the user must read (a steer's reply thought).
     */
    isDefaultExpanded?: boolean;
    /**
     * A summary whose detail is its list of rows. As in the Codex app, its chevron follows the title and stays shown
     * while expanded, and the rows continue at the header's own pitch instead of after a gap.
     */
    isList?: boolean;
    /**
     * Sweeps the activity highlight across the whole title while the work runs, the way the Codex app marks its live
     * row.
     */
    isRunning?: boolean;
    /**
     * The work item a single row shows, exposed as `data-agent-chat-work-item` so a finished turn's row can scroll it
     * into view (see `AgentChatTurnFold`).
     */
    itemId?: string;
    /**
     * A second line under the title, in muted text that truncates rather than wraps.
     */
    subtitle?: ReactNode;
    title: ReactNode;
    trailing?: ReactNode;
}) {
    const { isExpanded, toggle } = useAgentChatExpansion(expansionKey, {
        containedItems,
        isDefaultExpanded,
    });
    const detailId = useId();
    const titleId = useId();
    const hasSubtitle = subtitle !== undefined;
    // A two-line row keeps its glyph, facts, and actions on the first line instead of centering them on both.
    const alignClassName = hasSubtitle ? 'items-start' : 'items-center';
    const trailingId = useId();
    const chevron = (
        <ChevronRight
            aria-hidden="true"
            className={cn(
                'size-3.5 shrink-0 text-muted opacity-0 group-hover/row:opacity-100 group-has-[>button:focus-visible]/row:opacity-100',
                hasSubtitle && !isList && 'mt-0.75',
                agentChatChevronMotion(isExpanded),
                isExpanded && 'rotate-90',
                isList && isExpanded && 'opacity-100',
            )}
        />
    );
    const row = (
        <div
            className={cn(
                'group/row relative flex w-full min-w-0 gap-2 rounded px-1 py-0.5 text-muted hover:bg-list-hover-background hover:text-list-hover-foreground has-[>button:focus-visible]:outline has-[>button:focus-visible]:outline-accent',
                alignClassName,
            )}
        >
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                aria-labelledby={`${titleId} ${trailingId}`}
                className="absolute inset-0 cursor-pointer rounded border-0 bg-transparent outline-none"
                type="button"
                onClick={(event) => toggle(event.currentTarget)}
            />
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">{glyph}</span>
            <span className="flex min-w-0 flex-1 flex-col" id={titleId}>
                <span
                    className={cn(
                        'flex min-w-0 items-center gap-1.5',
                        isRunning && RUNNING_TITLE_CLASS_NAME,
                    )}
                >
                    {title}
                    {isList && chevron}
                </span>
                {hasSubtitle && <span className="min-w-0 truncate text-muted">{subtitle}</span>}
            </span>
            <span className="flex h-5 shrink-0 items-center gap-2" id={trailingId}>
                {trailing}
            </span>
            {/*
             * The chevron shows only while the row is hovered or holds keyboard focus, so a turn's many rows do not
             * stack a column of arrows down the transcript's edge. It keeps its box while hidden, so
             * revealing it never shifts the trailing stats.
             */}
            {!isList && chevron}
        </div>
    );
    return (
        <div className="text-[12px] leading-5" data-agent-chat-work-item={itemId}>
            {action ? (
                <div className={cn('flex min-w-0 gap-1', alignClassName)}>
                    {row}
                    {action}
                </div>
            ) : (
                row
            )}
            <DisclosureMotion animate expanded={isExpanded} id={detailId} kind={disclosureKind}>
                <div className={isList ? 'mb-1 ml-7' : 'mt-1 mb-2 ml-7 space-y-2'}>{children}</div>
            </DisclosureMotion>
        </div>
    );
}

/**
 * What a settled command's row says beyond its status glyph: a non-zero exit code, and a background hand-off, whose
 * exit code and duration belong to a later notification.
 */
function CommandFacts({ item }: { item: Extract<AgentChatWorkItem, { type: 'command' }> }) {
    const { t } = useTranslation();
    return (
        <>
            {item.background && (
                <span className="shrink-0 rounded bg-surface px-1 text-[11px]">
                    {t('agentChat.workGroup.background')}
                </span>
            )}
            {item.exitCode !== undefined && item.exitCode !== 0 && (
                <span className="shrink-0 font-mono text-[11px] text-danger tabular-nums">
                    <span className="sr-only">, </span>
                    {t('agentChat.workGroup.exitShort', { code: item.exitCode })}
                </span>
            )}
        </>
    );
}

function FileChangeStat({ item }: { item: Extract<AgentChatWorkItem, { type: 'fileChange' }> }) {
    const { t } = useTranslation();
    const stat = useMemo(() => agentChatFileChangesStat(item.changes), [item.changes]);
    return (
        <>
            <span className="sr-only">, {diffStatLabel(stat, t)}</span>
            <DiffStat additions={stat.additions} deletions={stat.deletions} />
        </>
    );
}

/**
 * A work row's trailing state: the diff stat, a task's elapsed time and status, or the item's own outcome and duration.
 */
function AgentChatWorkTrailing({ item, task }: { item: AgentChatWorkItem; task?: AgentChatTask }) {
    const { t } = useTranslation();
    const status = item.type === 'reasoning' ? undefined : item.status;
    const duration = task ? undefined : agentChatWorkDuration(item, t);
    return (
        <>
            {item.type === 'fileChange' && <FileChangeStat item={item} />}
            {!task && item.type === 'command' && <CommandFacts item={item} />}
            {task ? (
                <>
                    <AgentChatTaskElapsed task={task} />
                    {/* A running task already sweeps its title and ticks its timer; a spinner would say it a third time. */}
                    {task.status !== 'completed' && task.status !== 'running' && (
                        <AgentChatStatusGlyph status={agentChatTaskGlyphStatus(task.status)} />
                    )}
                </>
            ) : (
                status &&
                status !== 'running' &&
                status !== 'completed' && <AgentChatStatusGlyph status={status} />
            )}
            {duration && <span className="shrink-0 tabular-nums">{duration}</span>}
        </>
    );
}

/**
 * One piece of work: the tool's glyph, its past-tense verb, and what it acted on (`Ran git status`, `Read app.ts`). A
 * subagent's row names its task after a dot (`Ran agent · Survey the project`) and puts what it is doing, or its
 * result, on a second line, so a long summary never pushes the task's name out of the row. Expanded, it shows the full
 * command and its output painted in the output's language, the reasoning text, or the diff.
 */
const AgentChatWorkRow = memo(
    ({
        isDefaultExpanded,
        item,
        onOpenFile,
    }: {
        isDefaultExpanded?: boolean;
        item: AgentChatWorkItem;
        onOpenFile?: (target: string) => void;
    }) => {
        const { t } = useTranslation();
        const presentation = describeAgentChatWorkRow(item, t);
        const link = useAgentChatTaskLink(item);
        const task = link?.task;
        const taskActivity = task && agentChatTaskActivity(task, t);
        // A subagent call settles as soon as the subagent launches; the row keeps running until the subagent ends.
        const isRunning = isAgentChatWorkRowRunning(item, task);
        const verb = agentChatWorkVerb(item, presentation, t, task);
        const { path, subject } = presentation;
        return (
            <DisclosureRow
                action={link?.open && <AgentChatTaskOpenButton task={task} onOpen={link.open} />}
                disclosureKind="agent-chat-item"
                expansionKey={agentChatItemExpansionKey(item.id)}
                glyph={
                    <AgentChatWorkGlyph
                        isFailed={item.type !== 'reasoning' && item.status === 'failed'}
                        isRunning={isRunning}
                        kind={presentation.kind}
                        mcpToolName={item.type === 'toolCall' ? item.name : undefined}
                    />
                }
                isDefaultExpanded={isDefaultExpanded}
                isRunning={isRunning}
                itemId={item.id}
                subtitle={taskActivity}
                title={
                    <>
                        <span className="shrink-0">{verb}</span>
                        {task && subject && <span aria-hidden="true">·</span>}
                        {subject &&
                            (path && onOpenFile && !isRunning ? (
                                <AgentChatWorkFileLink
                                    path={path}
                                    subject={subject}
                                    onOpenFile={onOpenFile}
                                />
                            ) : (
                                <span className="min-w-0 truncate">{subject}</span>
                            ))}
                    </>
                }
                trailing={<AgentChatWorkTrailing item={item} task={task} />}
            >
                <AgentChatWorkDetail item={item} onOpenFile={onOpenFile} />
            </DisclosureRow>
        );
    },
);

/**
 * The rows of an expanded work group, scrolling past `WORK_LIST_CLASS_NAME`'s height with a fade on whichever edge
 * hides rows, the way the Codex app lists a long run of tool calls. The fade is a mask, so it dissolves the rows into
 * whatever the transcript sits on instead of painting a color over them.
 */
function WorkList({ children }: { children: ReactNode }) {
    const scrollReference = useRef<HTMLDivElement>(null);
    const startSentinel = useRef<HTMLSpanElement>(null);
    const endSentinel = useRef<HTMLSpanElement>(null);
    const { canScrollEnd, canScrollStart } = useScrollEdges(
        scrollReference,
        startSentinel,
        endSentinel,
    );
    const mask = `linear-gradient(to bottom, ${canScrollStart ? 'transparent' : 'black'}, black ${WORK_LIST_FADE}, black calc(100% - ${WORK_LIST_FADE}), ${canScrollEnd ? 'transparent' : 'black'})`;
    const style: CSSProperties | undefined =
        canScrollStart || canScrollEnd ? { maskImage: mask } : undefined;
    return (
        <div
            className={cn('-ml-7 flex flex-col', WORK_LIST_CLASS_NAME)}
            data-scroll-fade-start={canScrollStart || undefined}
            data-scroll-fade-end={canScrollEnd || undefined}
            ref={scrollReference}
            style={style}
        >
            <span aria-hidden="true" className="h-px flex-none" ref={startSentinel} />
            {children}
            <span aria-hidden="true" className="h-px flex-none" ref={endSentinel} />
        </div>
    );
}

/**
 * How long a tool call runs before the summary row names it (`Running pnpm lint`). A call that settles sooner leaves
 * the row on its settled summary, which only updates its counts, instead of flashing the running title and glyph
 * animation.
 */
const SUMMARY_RUNNING_DELAY_MS = 1000;

/**
 * Ordinary work as one stable summary row (`Ran 3 commands, read 2 files`) that lists each piece when expanded.
 */
function AgentChatWorkSummary({
    isOpen,
    items,
    anchorItems,
    onOpenFile,
}: {
    /**
     * Whether the next tool call can still join this run. Its title names the current step and keeps sweeping between
     * calls, so fast commands still show the turn working; the aggregate replaces it once the run ends.
     */
    isOpen: boolean;
    items: readonly AgentChatWorkItem[];
    anchorItems: readonly AgentChatWorkItem[];
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
    const shouldShowRunning = useHasLasted(
        agentChatActiveWork(items)?.item.id,
        SUMMARY_RUNNING_DELAY_MS,
    );
    // An open group names each step as it starts, so the delay that keeps a settled count from flickering is moot.
    const described = isOpen ? items : agentChatWorkSummaryItems(items, shouldShowRunning);
    const failureStatus = agentChatWorkGroupFailure(described);
    const phrases = agentChatWorkSummaryPhrases(described, t, { isOpen });
    const glyph = agentChatWorkSummaryGlyph(described, { isOpen });
    const isRunning = described.some(isAgentChatWorkRunning);
    return (
        <DisclosureRow
            containedItems={items}
            disclosureKind="agent-chat-work-group"
            expansionKey={agentChatSummaryExpansionKey(anchorItems)}
            isList
            glyph={
                <AgentChatWorkGlyph
                    isFailed={failureStatus !== undefined}
                    isRunning={isRunning}
                    kind={glyph.kind}
                    mcpToolName={glyph.mcpToolName}
                />
            }
            // Like a single running row, the live summary sweeps its title instead of trailing a spinner.
            isRunning={isRunning || isOpen}
            title={<AgentChatWorkSummaryTitle phrases={phrases} />}
            trailing={
                <>
                    {items.length === 1 && items[0] ? (
                        <AgentChatWorkTrailing item={items[0]} />
                    ) : (
                        failureStatus && <AgentChatStatusGlyph status={failureStatus} />
                    )}
                </>
            }
        >
            {/* A run of one call would list a row repeating this title, so it shows that call's detail instead. */}
            {items.length === 1 && items[0] ? (
                <div className="mt-1 mb-2 space-y-2">
                    <AgentChatWorkDetail item={items[0]} onOpenFile={onOpenFile} />
                </div>
            ) : (
                <WorkList>
                    {items.map((item) => (
                        <AgentChatWorkRow item={item} key={item.id} onOpenFile={onOpenFile} />
                    ))}
                </WorkList>
            )}
        </DisclosureRow>
    );
}

/**
 * A stable summary from the first ordinary tool call. Independent tasks retain their own live rows and Open buttons.
 * Once the run settles, a summary of one call adds nothing over the call itself, so that call renders as its own row.
 */
export function AgentChatWorkGroup({
    isOpen = false,
    isSteerReply = false,
    items,
    onOpenFile,
}: {
    /**
     * Whether the next tool call can still join this run (the running turn's trailing work).
     */
    isOpen?: boolean;
    /**
     * The thought the Agent answered a steered message with instead of a reply, shown expanded so the answer is seen.
     */
    isSteerReply?: boolean;
    items: readonly AgentChatWorkItem[];
    onOpenFile?: (target: string) => void;
}) {
    const links = useContext(AgentChatTaskLinksContext);
    const merged = useMemo(() => mergeAgentChatReasoning(items), [items]);
    const { summarized, rows } = splitAgentChatWork(
        merged,
        (item) => links?.tasksByItem.has(item.id) === true,
    );
    const single = !isOpen && summarized.length === 1 ? summarized[0] : undefined;
    return (
        <div className="flex flex-col">
            {single && <AgentChatWorkRow item={single} onOpenFile={onOpenFile} />}
            {!single && summarized.length > 0 && (
                <AgentChatWorkSummary
                    anchorItems={items}
                    isOpen={isOpen}
                    items={summarized}
                    onOpenFile={onOpenFile}
                />
            )}
            {rows.map((item) => (
                <AgentChatWorkRow
                    isDefaultExpanded={isSteerReply && item.type === 'reasoning'}
                    item={item}
                    key={item.id}
                    onOpenFile={onOpenFile}
                />
            ))}
        </div>
    );
}
