import type { ReactElement } from 'react';

import { relativeTime } from '@caxri/utils';
import type { GitCommit, GitRepositorySummary } from '@shared/types';
import { useQuery } from '@tanstack/react-query';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import { useControlledView, useSourceControlClient } from '../controlled-view-context';
import { controlledViewQueryKey } from '../view-operation-client';
import { CommitAvatar } from './commit-avatar';

/**
 * Rendered only while the card is open, so the commit-details read stays lazy per hovered commit. A commit is immutable
 * under its sha, so the result never goes stale.
 */
function CommitFileSummary({ repository, sha }: { repository: GitRepositorySummary; sha: string }) {
    const { viewId } = useControlledView();
    const client = useSourceControlClient();
    const arguments_ = { repositoryId: repository.id, sha };
    const details = useQuery({
        queryKey: controlledViewQueryKey(viewId, 'git.commitDetails', arguments_),
        queryFn: ({ signal }) => client.commitDetails(arguments_, signal),
        staleTime: Infinity,
    });
    if (!details.data) return null;
    const count = details.data.files.length;
    return (
        <>
            <span className="text-muted">
                {count} file{count === 1 ? '' : 's'} changed
                {details.data.filesTruncated ? '+' : ''}
            </span>
            <span className="text-success">+{details.data.additions}</span>
            <span className="text-danger">-{details.data.deletions}</span>
        </>
    );
}

/**
 * GitLens-style commit preview: avatar, author, timing, sha, refs, and the full commit message on hover.
 */
export function CommitHoverCard({
    commit,
    now,
    repository,
    trigger,
}: {
    commit: GitCommit;
    /**
     * Shared clock owned by the commit list so per-row cards never stack one interval each.
     */
    now: number;
    repository: GitRepositorySummary;
    trigger: ReactElement<Record<string, unknown>>;
}) {
    const absoluteTime = new Date(commit.authoredAt).toLocaleString();
    return (
        <HoverCard>
            <HoverCardTrigger closeDelay={80} delay={500} render={trigger} />
            <HoverCardContent
                align="start"
                className="commit-hover-card w-80 max-w-[calc(100vw-16px)] p-3"
                collisionAvoidance={{ align: 'shift', fallbackAxisSide: 'end', side: 'flip' }}
                collisionBoundary={document.documentElement}
                collisionPadding={8}
                positionMethod="fixed"
                role="tooltip"
                side="left"
            >
                <div className="flex items-center gap-2.5">
                    <CommitAvatar
                        author={commit.author}
                        email={commit.authorEmail}
                        repository={repository}
                        size={30}
                    />
                    <div className="min-w-0">
                        <div className="truncate text-[12px] font-semibold text-foreground">
                            {commit.author}
                        </div>
                        <div className="truncate text-[11px] text-muted" title={absoluteTime}>
                            {relativeTime(commit.authoredAt, now)} · {absoluteTime}
                        </div>
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <code className="rounded bg-elevated px-1 py-0.5 text-muted">
                        {commit.shortSha}
                    </code>
                    <CommitFileSummary repository={repository} sha={commit.sha} />
                </div>
                {commit.decorations.length > 0 && (
                    <div className="mt-1.5 flex max-w-full flex-wrap gap-1">
                        {commit.decorations.map((decoration) => (
                            <span
                                className="max-w-full truncate rounded bg-elevated px-1 text-[10px] text-muted"
                                key={decoration}
                            >
                                {decoration}
                            </span>
                        ))}
                    </div>
                )}
                <div className="mt-2 border-t border-border pt-2 text-[12px] leading-relaxed text-foreground">
                    <div className="break-words">{commit.subject || '(no subject)'}</div>
                    {commit.body && (
                        <div className="mt-1.5 max-h-48 overflow-y-auto text-[11px] leading-relaxed break-words whitespace-pre-line text-muted">
                            {commit.body}
                        </div>
                    )}
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}
