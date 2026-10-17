import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { memo, useContext, useId, useMemo, useRef } from 'react';

import type { AgentChatTask, AgentChatWorkItem, AgentToolKind } from '@caxri/protocol';
import {
    agentChatFileChangesStat,
    agentChatOutputLanguage,
    agentChatReasoningTitle,
    agentChatTaskGlyphStatus,
    agentChatToolCallArguments,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    agentToolActiveLabel,
    isAgentChatWorkRunning,
    splitAgentChatWork,
    stripLineNumberGutter,
    summarizeAgentChatWork,
    unwrapShellCommand,
} from '@caxri/protocol';
import {
    BookOpen,
    Bot,
    Brain,
    ChevronRight,
    CircleStop,
    Command,
    FilePenLine,
    FilePlus,
    FolderOpen,
    Globe,
    Hourglass,
    Image,
    ListTodo,
    MessageCircleQuestionMark,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
} from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { CodeView } from '../../components/markdown/code-view';
import { useScrollEdges } from '../../hooks/use-scroll-edges';
import { useTranslation } from '../../i18n';
import { McpConnectorIcon } from '../../icons/mcp-connector-icon';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { cn } from '../../lib/utilities';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import { agentChatItemExpansionKey, agentChatSummaryExpansionKey } from './agent-chat-expansion';
import { AgentChatFileChanges } from './agent-chat-file-changes';
import { AgentChatMcpGlyph } from './agent-chat-mcp-glyph';
import { AgentChatMessage } from './agent-chat-message';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatTaskElapsed } from './agent-chat-task-glyph';
import { AgentChatTaskOpenButton } from './agent-chat-task-open-button';
import { agentChatTaskActivity } from './agent-chat-tasks';
import { agentChatWorkSummaryGlyph, describeAgentChatWorkRow } from './agent-chat-timeline';
import { AgentChatToolArguments } from './agent-chat-tool-arguments';
import { AgentChatWorkFileLink } from './agent-chat-work-file-link';
import { useAgentChatExpansion } from './hooks/use-agent-chat-expansion';
import { useAgentChatMcpServer } from './hooks/use-agent-chat-mcp-server';
import { AgentChatTaskLinksContext, useAgentChatTaskLink } from './hooks/use-agent-chat-task-link';

/**
 * One glyph per tool kind, following the Codex app's work glyphs: an open book for a read, and four connected nodes for
 * an MCP call whose server has no icon of its own (see `AgentChatMcpGlyph`). A new tool kind is added to the shared
 * table in `@caxri/protocol` and given its glyph here.
 */
const WORK_ICONS: Record<AgentToolKind, ComponentType<{ className?: string }>> = {
    agent: Bot,
    manage: Bot,
    browser: Globe,
    command: SquareTerminal,
    computer: Command,
    edit: FilePenLine,
    image: Image,
    list: FolderOpen,
    mcp: McpConnectorIcon,
    other: Wrench,
    plan: ListTodo,
    question: MessageCircleQuestionMark,
    read: BookOpen,
    search: Search,
    skill: Sparkles,
    stop: CircleStop,
    thought: Brain,
    wait: Hourglass,
    web: Globe,
    write: FilePlus,
};

/**
 * An expanded file change shows every file's diff when it touches only a few files; a wider change starts as headers.
 */
const TIMELINE_EXPANDED_FILE_LIMIT = 3;

/**
 * Output taller than this scrolls inside its block, so one long log never pushes the conversation off screen.
 */
/**
 * Output and command bodies are content in an otherwise `select-none` transcript, so they opt back into selection; the
 * code view's header stays chrome.
 */
const OUTPUT_CLASS_NAME = 'max-h-80 overflow-y-auto select-text';

/**
 * Work still running keeps its tool glyph and sweeps a highlight across its whole title instead of swapping in a
 * spinner, so a column of rows does not flicker as each one starts and ends. The sweep clips to the title's text, so a
 * running title renders plain text only (no file control).
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
 * A one-line disclosure row: a glyph, the title, and trailing facts, with the detail mounted only while expanded. Work
 * is secondary to the conversation, so every row starts collapsed and the reply stays what the eye lands on.
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
    isRunning = false,
    itemId,
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
     * Sweeps the activity highlight across the whole title while the work runs, the way the Codex app marks its live
     * row.
     */
    isRunning?: boolean;
    /**
     * The work item a single row shows, exposed as `data-agent-chat-work-item` so a finished turn's row can scroll it
     * into view (see `AgentChatTurnFold`).
     */
    itemId?: string;
    title: ReactNode;
    trailing?: ReactNode;
}) {
    const { isExpanded, toggle } = useAgentChatExpansion(expansionKey, { containedItems });
    const detailId = useId();
    const titleId = useId();
    const trailingId = useId();
    const row = (
        <div className="group/row relative flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-muted hover:bg-list-hover-background hover:text-list-hover-foreground has-[>button:focus-visible]:outline has-[>button:focus-visible]:outline-accent">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                aria-labelledby={`${titleId} ${trailingId}`}
                className="absolute inset-0 cursor-pointer rounded border-0 bg-transparent outline-none"
                type="button"
                onClick={(event) => toggle(event.currentTarget)}
            />
            <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
            <span
                className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5',
                    isRunning && RUNNING_TITLE_CLASS_NAME,
                )}
                id={titleId}
            >
                {title}
            </span>
            <span className="flex shrink-0 items-center gap-2" id={trailingId}>
                {trailing}
            </span>
            <ChevronRight
                aria-hidden="true"
                className={cn(
                    'size-3.5 shrink-0 opacity-0 group-hover/row:opacity-100 group-has-[>button:focus-visible]/row:opacity-100',
                    agentChatChevronMotion(isExpanded),
                    isExpanded && 'rotate-90 opacity-100',
                )}
            />
        </div>
    );
    return (
        <div className="text-[12px] leading-5" data-agent-chat-work-item={itemId}>
            {action ? (
                <div className="flex min-w-0 items-center gap-1">
                    {row}
                    {action}
                </div>
            ) : (
                row
            )}
            <DisclosureMotion animate expanded={isExpanded} id={detailId} kind={disclosureKind}>
                <div className="mt-1 mb-2 ml-7 space-y-2">{children}</div>
            </DisclosureMotion>
        </div>
    );
}

/**
 * A work row's glyph. An MCP call shows its server's icon once the provider described the server (`mcpToolName` names
 * the call); every other kind shows its fixed glyph.
 */
function WorkGlyph({ kind, mcpToolName }: { kind: AgentToolKind; mcpToolName?: string }) {
    if (kind === 'mcp') return <McpWorkGlyph toolName={mcpToolName} />;
    const Icon = WORK_ICONS[kind];
    return <Icon aria-hidden="true" className="size-3.5" />;
}

function McpWorkGlyph({ toolName }: { toolName: string | undefined }) {
    return <AgentChatMcpGlyph server={useAgentChatMcpServer(toolName)} />;
}

/**
 * A command the row title can show in full is not repeated as its own block; a long or multi-line one is.
 */
const COMMAND_TITLE_LENGTH = 80;

/**
 * A tool's output. `isWrapped` starts it soft-wrapped: an MCP server answers in prose more often than in code, and a
 * paragraph on one scrolling line is unreadable.
 */
function OutputView({
    isWrapped,
    language,
    text,
}: {
    isWrapped?: boolean;
    language: string | undefined;
    text: string;
}) {
    const { t } = useTranslation();
    const output = text.replace(/\n+$/u, '');
    if (!output) return <p className="m-0 text-muted">{t('agentChat.workGroup.noOutput')}</p>;
    return (
        <CodeView
            className={OUTPUT_CLASS_NAME}
            code={output}
            defaultWrapped={isWrapped}
            label={t('agentChat.workGroup.output')}
            language={language}
        />
    );
}

function WorkDetail({
    item,
    onOpenFile,
}: {
    item: AgentChatWorkItem;
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
    switch (item.type) {
        case 'reasoning': {
            return (
                <AgentChatMessage
                    className="text-muted select-text"
                    isStreaming={item.streaming}
                    text={agentChatReasoningTitle(item.text).body}
                    onOpenFile={onOpenFile}
                />
            );
        }
        case 'command': {
            const command = unwrapShellCommand(item.command);
            return (
                <>
                    {(item.description !== undefined ||
                        describeAgentChatWorkRow(item).kind !== 'command' ||
                        command.length > COMMAND_TITLE_LENGTH ||
                        command.includes('\n')) && (
                        <CodeView
                            className={OUTPUT_CLASS_NAME}
                            code={command}
                            label={t('agentChat.workGroup.command')}
                            language="shell"
                        />
                    )}
                    <OutputView language={agentChatOutputLanguage(item)} text={item.output} />
                    {item.exitCode !== undefined && (
                        <p
                            className={cn(
                                'm-0',
                                item.exitCode === 0 ? 'text-muted' : 'text-danger',
                            )}
                        >
                            {t('agentChat.workGroup.exitCode', { code: item.exitCode })}
                        </p>
                    )}
                    {item.background && (
                        <p className="m-0 text-muted">
                            {t('agentChat.workGroup.movedToBackground')}
                        </p>
                    )}
                </>
            );
        }
        case 'toolCall': {
            const language = agentChatOutputLanguage(item);
            const output = item.output ?? '';
            const argumentsText = agentChatToolCallArguments(item);
            const { kind } = describeAgentChatWorkRow(item);
            return (
                <>
                    {argumentsText && <AgentChatToolArguments text={argumentsText} />}
                    <OutputView
                        isWrapped={kind === 'mcp'}
                        language={language}
                        text={kind === 'read' ? stripLineNumberGutter(output) : output}
                    />
                </>
            );
        }
        case 'fileChange': {
            // Diff text is selectable; the diff's own line-number and marker gutters stay `select-none`.
            return (
                <div className="select-text">
                    <AgentChatFileChanges
                        changes={item.changes}
                        expandAtMost={TIMELINE_EXPANDED_FILE_LIMIT}
                        status={item.status}
                    />
                </div>
            );
        }
    }
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
 * One piece of work: the tool's glyph, its past-tense verb, and what it acted on (`Ran git status`, `Read app.ts`).
 * Expanded, it shows the full command and its output painted in the output's language, the reasoning text, or the
 * diff.
 */
const AgentChatWorkRow = memo(
    ({ item, onOpenFile }: { item: AgentChatWorkItem; onOpenFile?: (target: string) => void }) => {
        const { t } = useTranslation();
        const presentation = describeAgentChatWorkRow(item, t);
        const isRunning = isAgentChatWorkRunning(item);
        const link = useAgentChatTaskLink(item);
        const task = link?.task;
        const taskActivity = task && agentChatTaskActivity(task, t);
        const verb = isRunning ? agentToolActiveLabel(presentation, t) : presentation.label;
        const { path, subject } = presentation;
        return (
            <DisclosureRow
                action={link?.open && <AgentChatTaskOpenButton task={task} onOpen={link.open} />}
                disclosureKind="agent-chat-item"
                expansionKey={agentChatItemExpansionKey(item.id)}
                glyph={
                    <WorkGlyph
                        kind={presentation.kind}
                        mcpToolName={item.type === 'toolCall' ? item.name : undefined}
                    />
                }
                isRunning={isRunning}
                itemId={item.id}
                title={
                    <>
                        <span className="shrink-0">{verb}</span>
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
                        {taskActivity && <span className="min-w-0 truncate">{taskActivity}</span>}
                    </>
                }
                trailing={<AgentChatWorkTrailing item={item} task={task} />}
            >
                <WorkDetail item={item} onOpenFile={onOpenFile} />
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
 * Ordinary work as one stable summary row (`Ran 3 commands, read 2 files`) that lists each piece when expanded.
 */
function AgentChatWorkSummary({
    items,
    anchorItems,
    onOpenFile,
}: {
    items: readonly AgentChatWorkItem[];
    anchorItems: readonly AgentChatWorkItem[];
    onOpenFile?: (target: string) => void;
}) {
    const { t } = useTranslation();
    const failureStatus = agentChatWorkGroupFailure(items);
    const summary = summarizeAgentChatWork(items, t);
    const glyph = agentChatWorkSummaryGlyph(items);
    return (
        <DisclosureRow
            containedItems={items}
            disclosureKind="agent-chat-work-group"
            expansionKey={agentChatSummaryExpansionKey(anchorItems)}
            glyph={<WorkGlyph kind={glyph.kind} mcpToolName={glyph.mcpToolName} />}
            title={<span className="min-w-0 truncate">{summary}</span>}
            trailing={
                <>
                    {items.some(isAgentChatWorkRunning) && (
                        <AgentChatStatusGlyph status="running" />
                    )}
                    {items.length === 1 && items[0] ? (
                        <AgentChatWorkTrailing item={items[0]} />
                    ) : (
                        failureStatus && <AgentChatStatusGlyph status={failureStatus} />
                    )}
                </>
            }
        >
            <WorkList>
                {items.map((item) => (
                    <AgentChatWorkRow item={item} key={item.id} onOpenFile={onOpenFile} />
                ))}
            </WorkList>
        </DisclosureRow>
    );
}

/**
 * A stable summary from the first ordinary tool call. Independent tasks retain their own live rows and Open buttons.
 */
export function AgentChatWorkGroup({
    items,
    onOpenFile,
}: {
    items: readonly AgentChatWorkItem[];
    onOpenFile?: (target: string) => void;
}) {
    const links = useContext(AgentChatTaskLinksContext);
    const { summarized, rows } = splitAgentChatWork(
        items,
        (item) => links?.tasksByItem.has(item.id) === true,
    );
    return (
        <div className="flex flex-col">
            {summarized.length > 0 && (
                <AgentChatWorkSummary
                    anchorItems={items}
                    items={summarized}
                    onOpenFile={onOpenFile}
                />
            )}
            {rows.map((item) => (
                <AgentChatWorkRow item={item} key={item.id} onOpenFile={onOpenFile} />
            ))}
        </div>
    );
}
