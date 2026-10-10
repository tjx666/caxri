import type { ReactNode } from 'react';
import { memo, useId, useMemo, useState } from 'react';

import type { AgentToolKind } from '@caxri/protocol';
import { formatShortDuration, unwrapShellCommand } from '@caxri/protocol';
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
    Plug,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
} from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { CodeView } from '../../components/markdown/code-view';
import { Spinner } from '../../components/ui/spinner';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { cn } from '../../lib/utilities';
import { agentChatFileChangesStat } from './agent-chat-diff';
import { AgentChatFileChanges } from './agent-chat-file-changes';
import { AgentChatMessage } from './agent-chat-message';
import { AgentChatStatusGlyph } from './agent-chat-status-glyph';
import type { AgentChatWorkItem } from './agent-chat-timeline';
import {
    agentChatOutputLanguage,
    agentChatWorkKind,
    describeAgentChatWork,
    stripLineNumberGutter,
    summarizeAgentChatWork,
} from './agent-chat-timeline';

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
 * A one-line disclosure row: a glyph, the title, and trailing facts, with the detail mounted only while expanded. Work
 * is secondary to the conversation, so every row starts collapsed and the reply stays what the eye lands on.
 */
function DisclosureRow({
    children,
    disclosureKind,
    glyph,
    title,
    trailing,
}: {
    children: ReactNode;
    disclosureKind: string;
    glyph: ReactNode;
    title: ReactNode;
    trailing?: ReactNode;
}) {
    const [isExpanded, setExpanded] = useState(false);
    const detailId = useId();
    return (
        <div className="text-[12px] leading-5">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                className="group/row flex w-full min-w-0 cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-1 py-0.5 text-left text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => setExpanded((value) => !value)}
            >
                <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">{title}</span>
                {trailing}
                <ChevronRight
                    aria-hidden="true"
                    className={cn(
                        'size-3.5 shrink-0 opacity-0 transition-[transform,opacity] duration-100 group-hover/row:opacity-100 group-focus-visible/row:opacity-100',
                        isExpanded && 'rotate-90 opacity-100',
                    )}
                />
            </button>
            <DisclosureMotion animate expanded={isExpanded} id={detailId} kind={disclosureKind}>
                <div className="mt-1 mb-2 ml-7 space-y-2">{children}</div>
            </DisclosureMotion>
        </div>
    );
}

function WorkGlyph({ kind, isRunning }: { kind: AgentToolKind | undefined; isRunning: boolean }) {
    if (isRunning) return <Spinner className="size-3.5" />;
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
                    text={item.text}
                    onOpenFile={onOpenFile}
                />
            );
        }
        case 'command': {
            const command = unwrapShellCommand(item.command);
            return (
                <>
                    {(command.length > COMMAND_TITLE_LENGTH || command.includes('\n')) && (
                        <CodeView
                            className={OUTPUT_CLASS_NAME}
                            code={command}
                            label="Command"
                            language="shell"
                        />
                    )}
                    <OutputView language={agentChatOutputLanguage(item)} text={item.output} />
                    {item.exitCode !== undefined && item.exitCode !== 0 && (
                        <p className="m-0 text-danger">Exit code {item.exitCode}</p>
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
 * One piece of work: the tool's glyph, its past-tense verb, and what it acted on (`Ran git status`, `Read app.ts`).
 * Expanded, it shows the full command and its output painted in the output's language, the reasoning text, or the
 * diff.
 */
const AgentChatWorkRow = memo(
    ({ item, onOpenFile }: { item: AgentChatWorkItem; onOpenFile?: (target: string) => void }) => {
        const presentation = describeAgentChatWork(item);
        const status = item.type === 'reasoning' ? undefined : item.status;
        const isRunning = item.type === 'reasoning' ? item.streaming : item.status === 'running';
        const duration =
            (item.type === 'command' || item.type === 'toolCall') && (item.durationMs ?? 0) >= 1000
                ? formatShortDuration(item.durationMs)
                : null;
        return (
            <DisclosureRow
                disclosureKind="agent-chat-item"
                glyph={<WorkGlyph isRunning={isRunning} kind={presentation.kind} />}
                title={
                    <>
                        <span className="shrink-0">{presentation.label}</span>
                        {presentation.subject && (
                            <span
                                className={cn(
                                    'min-w-0 truncate text-foreground',
                                    presentation.isCodeSubject &&
                                        'rounded bg-surface px-1 font-mono text-[11px]',
                                )}
                            >
                                {presentation.subject}
                            </span>
                        )}
                    </>
                }
                trailing={
                    <>
                        {item.type === 'fileChange' && <FileChangeStat item={item} />}
                        {status && status !== 'running' && status !== 'completed' && (
                            <AgentChatStatusGlyph status={status} />
                        )}
                        {duration && <span className="shrink-0 tabular-nums">{duration}</span>}
                    </>
                }
            >
                <WorkDetail item={item} onOpenFile={onOpenFile} />
            </DisclosureRow>
        );
    },
);

/**
 * Consecutive work collapses into one summary row (`Ran 3 commands, read 2 files`) that lists each piece when expanded.
 * A lone piece of work renders as its own row.
 */
export function AgentChatWorkGroup({
    items,
    onOpenFile,
}: {
    items: readonly AgentChatWorkItem[];
    onOpenFile?: (target: string) => void;
}) {
    const only = items.at(0);
    if (only && items.length === 1) return <AgentChatWorkRow item={only} onOpenFile={onOpenFile} />;
    const isRunning = items.some((item) =>
        item.type === 'reasoning' ? item.streaming : item.status === 'running',
    );
    const hasFailure = items.some((item) => item.type !== 'reasoning' && item.status === 'failed');
    return (
        <DisclosureRow
            disclosureKind="agent-chat-work-group"
            glyph={<WorkGlyph isRunning={isRunning} kind={agentChatWorkKind(items)} />}
            title={<span className="min-w-0 truncate">{summarizeAgentChatWork(items)}</span>}
            trailing={hasFailure && <AgentChatStatusGlyph status="failed" />}
        >
            <div className="-ml-7 flex flex-col">
                {items.map((item) => (
                    <AgentChatWorkRow item={item} key={item.id} onOpenFile={onOpenFile} />
                ))}
            </div>
        </DisclosureRow>
    );
}
