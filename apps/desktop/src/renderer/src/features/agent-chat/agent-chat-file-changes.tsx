import type { ReactNode } from 'react';
import { Fragment, useId, useMemo, useState } from 'react';

import type { AgentChatDiffLine, AgentChatFileChange, AgentChatItemStatus } from '@caxri/protocol';
import {
    agentChatChangeDecoration,
    agentChatDiffLines,
    agentChatDiffLinesStat,
    canOpenAgentChatChange,
    projectDisplayPath,
} from '@caxri/protocol';
import { ChevronRight, FileDiff, Plus } from 'lucide-react';

import { DiffStat } from '../../components/diff-stat';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { diffStatLabel } from '../../lib/diff-stat-label';
import { gitDecorationClassName } from '../../lib/git-decorations';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { didOpenEditorTabForSession, openFileForSession } from '../editor/document-commands';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { agentChatLocalizedChangeKindLabel } from './agent-chat-diff-labels';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import {
    agentChatChangeDiffTabPath,
    agentChatChangeFirstLine,
} from './agent-chat-file-change-targets';
import type { AgentChatReviewRange } from './agent-chat-turn-review';
import { isAgentChatReviewableLine } from './agent-chat-turn-review';

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
 * Commenting on a diff's lines, for the turn review: each line of code gets a `+` button that starts a comment on it
 * (Shift extends the open comment's range to it), the commented range is highlighted, and `renderAfter` places the
 * comment cards under the line their range ends on.
 */
export interface AgentChatDiffReview {
    selected: AgentChatReviewRange | undefined;
    onComment: (index: number, isExtending: boolean) => void;
    renderAfter: (index: number) => ReactNode;
}

/**
 * A unified diff colored with the same `--diff-stat-*` roles as every `+N -M` count, with old and new line-number
 * gutters. Long lines scroll horizontally instead of wrapping so the gutters stay aligned; a tall diff scrolls inside
 * its own bounded box unless `isBounded` is off, as in the turn review, which scrolls as a whole. A diff Server Core
 * cut says so at the cut instead of ending silently, and offers the full diff editor when Git still has the change.
 */
export function AgentChatDiff({
    isBounded = true,
    lines,
    onOpenDiff,
    review,
    truncated,
}: {
    isBounded?: boolean;
    lines: readonly AgentChatDiffLine[];
    onOpenDiff?: () => void;
    review?: AgentChatDiffReview;
    truncated: boolean | undefined;
}) {
    const { t } = useTranslation();
    if (!truncated && lines.length === 0)
        return (
            <p className="m-0 px-2 py-1 text-[11px] text-muted">{t('agentChat.changes.noDiff')}</p>
        );
    const lastLine = lines.reduce(
        (highest, line) => Math.max(highest, line.oldLine ?? 0, line.newLine ?? 0),
        0,
    );
    const gutterWidth = `${Math.max(2, String(lastLine).length) + 1}ch`;
    const isSelected = (index: number): boolean =>
        review?.selected !== undefined &&
        index >= review.selected.start &&
        index <= review.selected.end;
    return (
        <div
            className={cn('font-mono text-[11px] leading-4', isBounded && 'max-h-60 overflow-auto')}
        >
            <div className="w-max min-w-full">
                {lines.map((line, index) => (
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a diff's lines never reorder, so position is their identity.
                    <Fragment key={index}>
                        <div
                            className={cn(
                                'group/line flex',
                                LINE_CLASS_NAME[line.kind],
                                isSelected(index) && 'bg-accent/20',
                            )}
                            data-diff-line={line.kind}
                        >
                            {review && (
                                <span className="flex w-5 shrink-0 items-center justify-center">
                                    {isAgentChatReviewableLine(line) && (
                                        <button
                                            aria-label={
                                                line.kind === 'removed'
                                                    ? t('agentChat.changes.commentOnOldLine', {
                                                          line: String(line.oldLine),
                                                      })
                                                    : t('agentChat.changes.commentOnLine', {
                                                          line: String(line.newLine),
                                                      })
                                            }
                                            className="flex size-4 cursor-pointer items-center justify-center rounded-sm border-0 bg-accent p-0 text-accent-foreground opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-accent"
                                            type="button"
                                            onClick={(event) =>
                                                review.onComment(index, event.shiftKey)
                                            }
                                        >
                                            <Plus aria-hidden="true" className="size-3" />
                                        </button>
                                    )}
                                </span>
                            )}
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
                        {review?.renderAfter(index)}
                    </Fragment>
                ))}
                {truncated && (
                    <p className="m-0 flex items-center gap-2 border-t border-border px-2 py-1 font-sans text-muted">
                        {t('agentChat.changes.diffTruncated')}
                        {onOpenDiff && (
                            <button
                                className="cursor-pointer border-0 bg-transparent p-0 text-foreground hover:underline focus-visible:outline focus-visible:outline-accent"
                                type="button"
                                onClick={onOpenDiff}
                            >
                                {t('agentChat.changes.openDiff')}
                            </button>
                        )}
                    </p>
                )}
            </div>
        </div>
    );
}

/**
 * One changed file: a header with its Git status letter, Project-relative path, and line counts, over a disclosed diff.
 * The path opens the file in the Editor at the change's first line when the file exists on disk at this point of the
 * change; Open diff shows the file's working-tree diff in the Git diff editor while Git still reports it changed.
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
    const { t } = useTranslation();
    const [isExpanded, setExpanded] = useState(defaultExpanded);
    const detailId = useId();
    const session = usePaneViewSession();
    const lines = useMemo(() => agentChatDiffLines(change), [change]);
    const stat = useMemo(() => agentChatDiffLinesStat(lines), [lines]);
    const decoration = agentChatChangeDecoration(change.kind);
    const displayPath = projectDisplayPath(change.path, session?.rootPath);
    const sessionId = session?.id;
    const canOpen = sessionId !== undefined && canOpenAgentChatChange(change.kind, status);
    const summary = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: sessionId !== undefined, retry: false, staleTime: 60_000 },
    ).data;
    const diffTabPath = agentChatChangeDiffTabPath(
        summary?.isRepository ? summary : undefined,
        change.path,
    );
    const openDiff =
        sessionId !== undefined && diffTabPath !== undefined
            ? () => didOpenEditorTabForSession(sessionId, diffTabPath)
            : undefined;
    const firstLine = agentChatChangeFirstLine(lines);
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
                    aria-label={t(
                        isExpanded
                            ? 'agentChat.changes.hideDiffFor'
                            : 'agentChat.changes.showDiffFor',
                        { path: displayPath },
                    )}
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
                <span className="sr-only">{agentChatLocalizedChangeKindLabel(change.kind, t)}</span>
                {canOpen ? (
                    <Tooltip content={t('agentChat.changes.openInEditor')}>
                        <button
                            aria-label={t('agentChat.changes.openPathInEditor', {
                                path: displayPath,
                            })}
                            className={cn(
                                pathClassName,
                                'cursor-pointer border-0 bg-transparent p-0 text-left hover:underline focus-visible:outline focus-visible:outline-accent',
                            )}
                            type="button"
                            onClick={() => {
                                // eslint-disable-next-line no-void -- openFileForSession reports failures through tryCommand
                                void openFileForSession(sessionId, change.path, {
                                    location:
                                        firstLine === undefined
                                            ? undefined
                                            : { mode: 'caret', line: firstLine, column: 1 },
                                });
                            }}
                        >
                            {displayPath}
                        </button>
                    </Tooltip>
                ) : (
                    <span className={pathClassName}>{displayPath}</span>
                )}
                <span className="sr-only">{diffStatLabel(stat, t)}</span>
                {/* Also said at the cut, but a long diff's end is a scroll away: the header says it up front. */}
                {change.truncated && (
                    <span className="ml-auto shrink-0 text-[11px] text-muted">
                        {t('agentChat.changes.truncated')}
                    </span>
                )}
                <DiffStat
                    additions={stat.additions}
                    className={cn('text-[11px]', !change.truncated && 'ml-auto')}
                    deletions={stat.deletions}
                />
                {openDiff && (
                    <Tooltip content={t('agentChat.changes.openDiff')}>
                        <button
                            aria-label={t('agentChat.changes.openDiffFor', { path: displayPath })}
                            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                            type="button"
                            onClick={openDiff}
                        >
                            <FileDiff aria-hidden="true" className="size-3.5" />
                        </button>
                    </Tooltip>
                )}
            </div>
            <DisclosureMotion
                animate
                expanded={isExpanded}
                id={detailId}
                kind="agent-chat-file-change"
            >
                <div className="border-t border-border bg-background">
                    <AgentChatDiff
                        lines={lines}
                        truncated={change.truncated}
                        onOpenDiff={openDiff}
                    />
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
