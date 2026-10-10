import type { CSSProperties, ReactNode } from 'react';
import { memo, useContext, useId, useMemo, useRef, useState } from 'react';

import type { AgentChatTask, AgentToolKind } from '@caxri/protocol';
import { agentToolActiveLabel, unwrapShellCommand } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    Bot,
    Brain,
    ChevronRight,
    CircleStop,
    FilePenLine,
    FilePlus,
    FileText,
    FolderOpen,
    Globe,
    Image,
    Layers,
    ListTodo,
    MessageCircleQuestionMark,
    PanelRight,
    Plug,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
} from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { CodeView } from '../../components/markdown/code-view';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useScrollEdges } from '../../hooks/use-scroll-edges';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { cn } from '../../lib/utilities';
import { agentChatFileChangesStat } from './agent-chat-diff';
import { AgentChatFileChanges } from './agent-chat-file-changes';
import { AgentChatMessage } from './agent-chat-message';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import { AgentChatTaskElapsed } from './agent-chat-task-glyph';
import { agentChatTaskActivity, agentChatTaskGlyphStatus } from './agent-chat-tasks';
import type { AgentChatWorkItem } from './agent-chat-timeline';
import {
    agentChatOutputLanguage,
    agentChatReasoningTitle,
    agentChatWorkDuration,
    agentChatWorkKind,
    describeAgentChatWork,
    isAgentChatWorkRunning,
    splitAgentChatWork,
    stripLineNumberGutter,
    summarizeAgentChatWork,
} from './agent-chat-timeline';
import { AgentChatTaskLinksContext, useAgentChatTaskLink } from './hooks/use-agent-chat-task-link';

/**
 * One glyph per tool kind, matching the mobile timeline so a tool reads the same on both clients. A new tool kind is
 * added to the shared table in `@caxri/protocol` and given its glyph here.
 */
const WORK_ICONS: Record<AgentToolKind, LucideIcon> = {
    agent: Bot,
    command: SquareTerminal,
    edit: FilePenLine,
    image: Image,
    list: FolderOpen,
    mcp: Plug,
    other: Wrench,
    plan: ListTodo,
    question: MessageCircleQuestionMark,
    read: FileText,
    search: Search,
    skill: Sparkles,
    stop: CircleStop,
    thought: Brain,
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
const OUTPUT_CLASS_NAME = 'max-h-80 overflow-y-auto';

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
 */
function DisclosureRow({
    action,
    children,
    disclosureKind,
    glyph,
    isRunning = false,
    title,
    trailing,
}: {
    /**
     * A control beside the row, outside its toggle button (a button cannot nest inside another).
     */
    action?: ReactNode;
    children: ReactNode;
    disclosureKind: string;
    glyph: ReactNode;
    /**
     * Sweeps the activity highlight across the whole title while the work runs, the way the Codex app marks its live
     * row.
     */
    isRunning?: boolean;
    title: ReactNode;
    trailing?: ReactNode;
}) {
    const [isExpanded, setExpanded] = useState(false);
    const detailId = useId();
    const titleId = useId();
    const trailingId = useId();
    const row = (
        <div className="group/row relative flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-muted hover:bg-[var(--selection)] hover:text-foreground has-[>button:focus-visible]:outline has-[>button:focus-visible]:outline-accent">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                aria-labelledby={`${titleId} ${trailingId}`}
                className="absolute inset-0 cursor-pointer rounded border-0 bg-transparent outline-none"
                type="button"
                onClick={() => setExpanded((value) => !value)}
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
                    'size-3.5 shrink-0 opacity-0 transition-[transform,opacity] duration-100 group-hover/row:opacity-100 group-has-[>button:focus-visible]/row:opacity-100',
                    isExpanded && 'rotate-90 opacity-100',
                )}
            />
        </div>
    );
    return (
        <div className="text-[12px] leading-5">
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

function WorkGlyph({ kind }: { kind: AgentToolKind | undefined }) {
    const Icon = kind ? WORK_ICONS[kind] : Layers;
    return <Icon aria-hidden="true" className="size-3.5" />;
}

/**
 * A command the row title can show in full is not repeated as its own block; a long or multi-line one is.
 */
const COMMAND_TITLE_LENGTH = 80;

function OutputView({ language, text }: { language: string | undefined; text: string }) {
    const output = text.replace(/\n+$/u, '');
    if (!output) return <p className="m-0 text-muted">No output</p>;
    return (
        <CodeView className={OUTPUT_CLASS_NAME} code={output} label="Output" language={language} />
    );
}

function WorkDetail({
    item,
    onOpenFile,
}: {
    item: AgentChatWorkItem;
    onOpenFile?: (target: string) => void;
}) {
    switch (item.type) {
        case 'reasoning': {
            return (
                <AgentChatMessage
                    className="text-muted"
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
                        describeAgentChatWork(item).kind !== 'command' ||
                        command.length > COMMAND_TITLE_LENGTH ||
                        command.includes('\n')) && (
                        <CodeView
                            className={OUTPUT_CLASS_NAME}
                            code={command}
                            label="Command"
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
                            Exit code {item.exitCode}
                        </p>
                    )}
                    {item.background && (
                        <p className="m-0 text-muted">
                            Moved to the background; the Agent is told when it finishes.
                        </p>
                    )}
                </>
            );
        }
        case 'toolCall': {
            const language = agentChatOutputLanguage(item);
            const output = item.output ?? '';
            return (
                <>
                    {item.summary && (
                        <p className="m-0 font-mono text-[11px] wrap-anywhere whitespace-pre-wrap text-muted">
                            {item.summary}
                        </p>
                    )}
                    <OutputView
                        language={language}
                        text={
                            describeAgentChatWork(item).kind === 'read'
                                ? stripLineNumberGutter(output)
                                : output
                        }
                    />
                </>
            );
        }
        case 'fileChange': {
            return (
                <AgentChatFileChanges
                    changes={item.changes}
                    expandAtMost={TIMELINE_EXPANDED_FILE_LIMIT}
                    status={item.status}
                />
            );
        }
    }
}

/**
 * What a settled command's row says beyond its status glyph: a non-zero exit code, and a background hand-off, whose
 * exit code and duration belong to a later notification.
 */
function CommandFacts({ item }: { item: Extract<AgentChatWorkItem, { type: 'command' }> }) {
    return (
        <>
            {item.background && (
                <span className="shrink-0 rounded bg-surface px-1 text-[11px]">Background</span>
            )}
            {item.exitCode !== undefined && item.exitCode !== 0 && (
                <span className="shrink-0 font-mono text-[11px] text-danger tabular-nums">
                    <span className="sr-only">, </span>Exit {item.exitCode}
                </span>
            )}
        </>
    );
}

function FileChangeStat({ item }: { item: Extract<AgentChatWorkItem, { type: 'fileChange' }> }) {
    const stat = useMemo(() => agentChatFileChangesStat(item.changes), [item.changes]);
    return (
        <>
            <span className="sr-only">, {diffStatLabel(stat)}</span>
            <DiffStat additions={stat.additions} deletions={stat.deletions} />
        </>
    );
}

/**
 * Opens a work row's subagent or background shell in the side split.
 */
function AgentChatTaskOpenButton({
    link,
}: {
    link: NonNullable<ReturnType<typeof useAgentChatTaskLink>>;
}) {
    const { task } = link;
    return (
        <Tooltip content={task ? `Open ${task.title || 'task'}` : 'Open subagent'}>
            <Button
                aria-label={task?.kind === 'shell' ? 'Open shell' : 'Open subagent'}
                className="min-h-6 shrink-0 gap-1 px-1.5 text-muted"
                size="sm"
                variant="ghost"
                onClick={link.open}
            >
                <PanelRight aria-hidden="true" className="size-3.5" />
                Open
            </Button>
        </Tooltip>
    );
}

/**
 * A work row's trailing state: the diff stat, a task's elapsed time and status, or the item's own outcome and duration.
 */
function AgentChatWorkTrailing({ item, task }: { item: AgentChatWorkItem; task?: AgentChatTask }) {
    const status = item.type === 'reasoning' ? undefined : item.status;
    const duration = task ? undefined : agentChatWorkDuration(item);
    return (
        <>
            {item.type === 'fileChange' && <FileChangeStat item={item} />}
            {!task && item.type === 'command' && <CommandFacts item={item} />}
            {task ? (
                <>
                    <AgentChatTaskElapsed task={task} />
                    {task.status !== 'completed' && (
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
        const presentation = describeAgentChatWork(item);
        const isRunning = isAgentChatWorkRunning(item);
        const link = useAgentChatTaskLink(item);
        const task = link?.task;
        const taskActivity = task && agentChatTaskActivity(task);
        const verb = isRunning ? agentToolActiveLabel(presentation) : presentation.label;
        const { path, subject } = presentation;
        return (
            <DisclosureRow
                action={link && <AgentChatTaskOpenButton link={link} />}
                disclosureKind="agent-chat-item"
                glyph={<WorkGlyph kind={presentation.kind} />}
                isRunning={isRunning}
                title={
                    <>
                        <span className="shrink-0">{verb}</span>
                        {subject &&
                            (path && onOpenFile && !isRunning ? (
                                <WorkFileLink
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
 * The file a work row names, underlined like a link and opening in the editor. It sits above the row's stretched
 * toggle, so clicking the name opens the file while the rest of the row still expands it.
 */
function WorkFileLink({
    path,
    subject,
    onOpenFile,
}: {
    path: string;
    subject: string;
    onOpenFile: (target: string) => void;
}) {
    return (
        <button
            className="relative min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-inherit underline decoration-current/40 underline-offset-2 opacity-80 hover:opacity-100 focus-visible:outline focus-visible:outline-accent"
            title={path}
            type="button"
            onClick={() => onOpenFile(path)}
        >
            {subject}
        </button>
    );
}

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
 * Settled work as one summary row (`Ran 3 commands, read 2 files`) that lists each piece when expanded.
 */
function AgentChatWorkSummary({
    items,
    onOpenFile,
}: {
    items: readonly AgentChatWorkItem[];
    onOpenFile?: (target: string) => void;
}) {
    const hasFailure = items.some((item) => item.type !== 'reasoning' && item.status === 'failed');
    const summary = summarizeAgentChatWork(items);
    return (
        <DisclosureRow
            disclosureKind="agent-chat-work-group"
            glyph={<WorkGlyph kind={agentChatWorkKind(items)} />}
            title={<span className="min-w-0 truncate">{summary}</span>}
            trailing={hasFailure && <AgentChatStatusGlyph status="failed" />}
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
 * A run of consecutive work. Settled tool calls collapse into a summary row; a lone call, a thought, and anything still
 * running render as their own rows (see `splitAgentChatWork`). A row whose subagent or background shell still runs
 * counts as running even after its tool call returned, so its live status and Open button stay in view.
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
        (item) => links?.tasksByItem.get(item.id)?.status === 'running',
    );
    return (
        <div className="flex flex-col">
            {summarized.length > 0 && (
                <AgentChatWorkSummary items={summarized} onOpenFile={onOpenFile} />
            )}
            {rows.map((item) => (
                <AgentChatWorkRow item={item} key={item.id} onOpenFile={onOpenFile} />
            ))}
        </div>
    );
}
