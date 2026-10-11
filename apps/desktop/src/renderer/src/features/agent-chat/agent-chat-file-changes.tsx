import { useId, useMemo, useState } from 'react';

import type { AgentChatItemStatus } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { Tooltip } from '../../components/ui/tooltip';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { projectRelativePath } from '../../lib/file-path';
import { gitDecorationClassName } from '../../lib/git-decorations';
import { cn } from '../../lib/utilities';
import { openFileForSession } from '../editor/document-commands';
import { usePaneViewSession } from '../workbench/pane-view-session';
import type { AgentChatDiffLine, AgentChatFileChange } from './agent-chat-diff';
import {
    agentChatChangeDecoration,
    agentChatChangeKindLabel,
    agentChatDiffLines,
    agentChatDiffLinesStat,
    canOpenAgentChatChange,
} from './agent-chat-diff';
import { agentChatChevronMotion } from './agent-chat-disclosure';

const LINE_CLASS_NAME: Record<AgentChatDiffLine['kind'], string> = {
    added: 'bg-diff-stat-added/15',
    removed: 'bg-diff-stat-removed/15',
    context: '',
    hunk: 'bg-elevated text-muted',
    meta: 'text-muted',
};

const SIGN: Record<AgentChatDiffLine['kind'], string> = {
    added: '+',
    removed: '-',
    context: ' ',
    hunk: '',
    meta: '',
};

const SIGN_CLASS_NAME: Partial<Record<AgentChatDiffLine['kind'], string>> = {
    added: 'text-diff-stat-added',
    removed: 'text-diff-stat-removed',
};

/**
 * A unified diff colored with the same `--diff-stat-*` roles as every `+N -M` count, with old and new line-number
 * gutters. Long lines scroll horizontally instead of wrapping so the gutters stay aligned; a tall diff scrolls inside
 * its own bounded box. A diff Server Core cut says so at the cut instead of ending silently.
 */
export function AgentChatDiff({
    lines,
    truncated,
}: {
    lines: readonly AgentChatDiffLine[];
    truncated: boolean | undefined;
}) {
    if (!truncated && lines.length === 0)
        return <p className="m-0 px-2 py-1 text-[11px] text-muted">No diff</p>;
    const lastLine = lines.reduce(
        (highest, line) => Math.max(highest, line.oldLine ?? 0, line.newLine ?? 0),
        0,
    );
    const gutterWidth = `${Math.max(2, String(lastLine).length) + 1}ch`;
    return (
        <div className="max-h-60 overflow-auto font-mono text-[11px] leading-4">
            <div className="w-max min-w-full">
                {lines.map((line, index) => (
                    <div
                        className={cn('flex', LINE_CLASS_NAME[line.kind])}
                        data-diff-line={line.kind}
                        key={index}
                    >
                        {line.kind === 'hunk' || line.kind === 'meta' ? (
                            <span className="px-2 whitespace-pre">{line.text}</span>
                        ) : (
                            <>
                                <span
                                    aria-hidden="true"
                                    className="shrink-0 pr-1 text-right text-muted select-none"
                                    style={{ width: gutterWidth }}
                                >
                                    {line.oldLine}
                                </span>
                                <span
                                    aria-hidden="true"
                                    className="shrink-0 pr-1 text-right text-muted select-none"
                                    style={{ width: gutterWidth }}
                                >
                                    {line.newLine}
                                </span>
                                <span
                                    className={cn(
                                        'w-4 shrink-0 text-center select-none',
                                        SIGN_CLASS_NAME[line.kind],
                                    )}
                                >
                                    {SIGN[line.kind]}
                                </span>
                                <span className="pr-2 whitespace-pre text-foreground">
                                    {line.text}
                                </span>
                            </>
                        )}
                    </div>
                ))}
                {truncated && (
                    <p className="m-0 border-t border-border px-2 py-1 font-sans text-muted">
                        Diff truncated
                    </p>
                )}
            </div>
        </div>
    );
}

/**
 * One changed file: a header with its Git status letter, Project-relative path, and line counts, over a disclosed diff.
 * The path opens the file in the Editor when the file exists on disk at this point of the change.
 */
function FileChangeBlock({
    change,
    defaultExpanded,
    status,
}: {
    change: AgentChatFileChange;
    defaultExpanded: boolean;
    status: AgentChatItemStatus | undefined;
}) {
    const [isExpanded, setExpanded] = useState(defaultExpanded);
    const detailId = useId();
    const session = usePaneViewSession();
    const lines = useMemo(() => agentChatDiffLines(change), [change]);
    const stat = useMemo(() => agentChatDiffLinesStat(lines), [lines]);
    const decoration = agentChatChangeDecoration(change.kind);
    const displayPath =
        (session?.rootPath && projectRelativePath(change.path, session.rootPath)) ?? change.path;
    const sessionId = session?.id;
    const canOpen = sessionId !== undefined && canOpenAgentChatChange(change.kind, status);
    const pathClassName = cn(
        'min-w-0 truncate font-mono text-[11px]',
        gitDecorationClassName(decoration.kind),
    );
    return (
        <div className="overflow-hidden rounded border border-border bg-surface">
            <div className="flex h-6 min-w-0 items-center gap-1.5 pr-2">
                <button
                    aria-controls={detailId}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Hide' : 'Show'} diff: ${displayPath}`}
                    className="flex h-full shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent pr-0.5 pl-1 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                >
                    <ChevronRight
                        className={cn(
                            'size-3.5',
                            agentChatChevronMotion(isExpanded),
                            isExpanded && 'rotate-90',
                        )}
                    />
                    <GitFileStatusLetter className="text-[11px]" decoration={decoration} />
                </button>
                <span className="sr-only">{agentChatChangeKindLabel(change.kind)}</span>
                {canOpen ? (
                    <Tooltip content="Open in Editor">
                        <button
                            aria-label={`Open ${displayPath} in Editor`}
                            className={cn(
                                pathClassName,
                                'cursor-pointer border-0 bg-transparent p-0 text-left hover:underline focus-visible:outline focus-visible:outline-accent',
                            )}
                            type="button"
                            onClick={() => {
                                // eslint-disable-next-line no-void -- openFileForSession reports failures through tryCommand
                                void openFileForSession(sessionId, change.path);
                            }}
                        >
                            {displayPath}
                        </button>
                    </Tooltip>
                ) : (
                    <span className={pathClassName}>{displayPath}</span>
                )}
                <span className="sr-only">{diffStatLabel(stat)}</span>
                {/* Also said at the cut, but a long diff's end is a scroll away: the header says it up front. */}
                {change.truncated && (
                    <span className="ml-auto shrink-0 text-[11px] text-muted">Truncated</span>
                )}
                <DiffStat
                    additions={stat.additions}
                    className={cn('text-[11px]', !change.truncated && 'ml-auto')}
                    deletions={stat.deletions}
                />
            </div>
            <DisclosureMotion
                animate
                expanded={isExpanded}
                id={detailId}
                kind="agent-chat-file-change"
            >
                <div className="border-t border-border bg-background">
                    <AgentChatDiff lines={lines} truncated={change.truncated} />
                </div>
            </DisclosureMotion>
        </div>
    );
}

/**
 * The files of one Codex file change, grouped one block per file. Shared by the timeline entry and the approval card,
 * so what the user approves reads exactly like what the timeline later records.
 */
export function AgentChatFileChanges({
    changes,
    expandAtMost,
    status,
}: {
    changes: readonly AgentChatFileChange[];
    /**
     * File blocks start expanded when the change touches at most this many files; a larger change starts as a list of
     * headers so one long patch does not bury the rest.
     */
    expandAtMost: number;
    status: AgentChatItemStatus | undefined;
}) {
    const isDefaultExpanded = changes.length <= expandAtMost;
    return (
        <div className="space-y-1.5">
            {changes.map((change) => (
                <FileChangeBlock
                    change={change}
                    defaultExpanded={isDefaultExpanded}
                    key={change.path}
                    status={status}
                />
            ))}
        </div>
    );
}
