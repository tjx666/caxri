import { useCallback, useEffect, useRef, useState } from 'react';

import { relativeTime } from '@caxri/utils';
import type { GitCommit, GitRepositorySummary } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, X } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useNow } from '@/hooks/use-now';

import { DisclosureMotion } from '../../../components/disclosure-motion';
import { Button } from '../../../components/ui/button';
import { Input, InputGroup } from '../../../components/ui/input';
import { Spinner } from '../../../components/ui/spinner';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utilities';
import { describeFailure } from '../../../stores/toasts';
import { useControlledView, useSourceControlClient } from '../controlled-view-context';
import { controlledViewQueryKey } from '../view-operation-client';
import { CommitAvatar } from './commit-avatar';
import { CommitHoverCard } from './commit-hover-card';
import { openGitCommitFileDiff } from './git-diff-actions';

const PAGE_SIZE = 5;

function CommitDetails({
    path,
    repository,
    sha,
}: {
    path?: string;
    repository: GitRepositorySummary;
    sha: string;
}) {
    const { viewId } = useControlledView();
    const client = useSourceControlClient();
    const arguments_ = {
        repositoryId: repository.id,
        sha,
        path,
    };
    const details = useQuery({
        queryKey: controlledViewQueryKey(viewId, 'git.commitDetails', arguments_),
        queryFn: ({ signal }) => client.commitDetails(arguments_, signal),
    });
    if (details.isPending)
        return <div className="px-3 py-2 text-[11px] text-muted">Loading commit…</div>;
    if (details.isError)
        return (
            <div className="px-3 py-2 text-[11px] text-danger">
                {describeFailure(details.error, 'Unable to load commit')}
            </div>
        );
    return (
        <div className="commit-details border-y border-border bg-background py-1">
            <div className="px-3 py-1 text-[10px] font-bold tracking-[0.06em] text-muted uppercase">
                Changed files · {details.data.files.length}
            </div>
            {details.data.files.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted">No files in this scope.</div>
            ) : (
                details.data.files.map((file) => (
                    <button
                        type="button"
                        className="flex min-h-6 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left text-[11px] text-foreground hover:bg-elevated"
                        key={`${file.previousPath ?? ''}:${file.path}`}
                        title={
                            file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
                        }
                        onClick={() => openGitCommitFileDiff(repository.id, sha, file.path)}
                    >
                        <span className="w-14 shrink-0 text-muted">{file.status}</span>
                        <span className="truncate">{file.path}</span>
                    </button>
                ))
            )}
            {details.data.filesTruncated && (
                <div className="px-3 py-1 text-[11px] text-warning">File list truncated.</div>
            )}
        </div>
    );
}

function CommitRow({
    commit,
    now,
    repository,
    selected,
    onSelect,
}: {
    commit: GitCommit;
    /**
     * Shared clock owned by `CommitHistory` so retained rows never stack one interval each.
     */
    now: number;
    repository: GitRepositorySummary;
    selected: boolean;
    onSelect: () => void;
}) {
    const absoluteTime = new Date(commit.authoredAt).toLocaleString();
    return (
        <CommitHoverCard
            commit={commit}
            now={now}
            repository={repository}
            trigger={
                <button
                    type="button"
                    className={cn(
                        'commit-row flex w-full cursor-pointer gap-2 border-0 bg-surface px-3 py-1.5 text-left hover:bg-elevated',
                        selected && 'bg-elevated',
                    )}
                    aria-label={`Commit ${commit.subject}`}
                    onClick={onSelect}
                >
                    <CommitAvatar
                        author={commit.author}
                        className="mt-0.5"
                        email={commit.authorEmail}
                        repository={repository}
                        size={18}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex w-full min-w-0 items-center gap-2">
                            <span className="truncate text-foreground">
                                {commit.subject || '(no subject)'}
                            </span>
                            <code className="ml-auto shrink-0 text-[10px] text-muted">
                                {commit.shortSha}
                            </code>
                        </span>
                        <span className="flex w-full min-w-0 items-center gap-1 text-[10px] text-muted">
                            <span className="truncate">{commit.author}</span>
                            <span>·</span>
                            <time
                                dateTime={new Date(commit.authoredAt).toISOString()}
                                title={absoluteTime}
                            >
                                {relativeTime(commit.authoredAt, now)}
                            </time>
                        </span>
                        {commit.decorations.length > 0 && (
                            <span className="flex max-w-full gap-1 overflow-hidden">
                                {commit.decorations.map((decoration) => (
                                    <span
                                        className="truncate rounded bg-elevated px-1 text-[10px] text-muted"
                                        key={decoration}
                                    >
                                        {decoration}
                                    </span>
                                ))}
                            </span>
                        )}
                    </span>
                </button>
            }
        />
    );
}

export function CommitHistory({ repository }: { repository: GitRepositorySummary }) {
    const client = useSourceControlClient();
    const [expanded, setExpanded] = useState(false);
    const now = useNow(30_000);
    const [path, setPath] = useState('');
    const debouncedPath = useDebouncedValue(path, 200);
    const [commits, setCommits] = useState<GitCommit[]>([]);
    const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
    const [selectedSha, setSelectedSha] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const requestSequence = useRef(0);
    const activeRequest = useRef<
        { controller: AbortController; head?: string; sequence: number } | undefined
    >(undefined);
    const scopePath = debouncedPath.trim() || undefined;

    const loadPage = useCallback(
        async (offset: number, shouldReplace: boolean, head?: string) => {
            activeRequest.current?.controller.abort();
            const request = {
                controller: new AbortController(),
                head,
                sequence: ++requestSequence.current,
            };
            activeRequest.current = request;
            setLoading(true);
            if (shouldReplace) {
                setCommits([]);
                setSelectedSha(undefined);
            }
            setError(undefined);
            try {
                const page = await client.commits(
                    {
                        repositoryId: repository.id,
                        offset,
                        pageSize: PAGE_SIZE,
                        path: scopePath,
                    },
                    request.controller.signal,
                );
                if (request !== activeRequest.current) return;
                setCommits((current) =>
                    shouldReplace ? page.commits : [...current, ...page.commits],
                );
                setNextOffset(page.nextOffset);
            } catch (error_) {
                if (request !== activeRequest.current) return;
                setError(describeFailure(error_, 'Unable to load commits'));
            } finally {
                if (request === activeRequest.current) activeRequest.current = undefined;
                setLoading(activeRequest.current !== undefined);
            }
        },
        [client, repository.id, scopePath],
    );

    useEffect(() => {
        if (!expanded) {
            activeRequest.current?.controller.abort();
            activeRequest.current = undefined;
            return;
        }
        // loadPage tracks its own loading/error state via the effect's activeRequest guard, so
        // this deferred kickoff intentionally discards the returned promise.
        const timer = setTimeout(() => {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void loadPage(0, true, repository.head);
        }, 0);
        return () => {
            clearTimeout(timer);
            activeRequest.current?.controller.abort();
            activeRequest.current = undefined;
        };
    }, [expanded, loadPage, repository.head]);

    return (
        <section
            /**
             * While collapsed, the section pins to the bottom of the panel's scroll viewport so a long Changes list can
             * never push the Commits entry point out of sight; expanding returns it to normal flow so the commit list
             * scrolls with the panel.
             */
            className={cn('commit-history bg-surface', !expanded && 'sticky bottom-0 z-10')}
        >
            <button
                type="button"
                className="flex h-7 w-full cursor-pointer items-center gap-1 border-0 bg-transparent px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:text-foreground"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate">Commits</span>
                {expanded && <span className="ml-auto">{commits.length}</span>}
            </button>
            <DisclosureMotion animate expanded={expanded} kind="git-history">
                {() => (
                    <div>
                        <div className="border-y border-border p-1.5">
                            <InputGroup appearance="workbench" size="dense">
                                <Input
                                    appearance="embedded"
                                    className="flex-1 text-foreground"
                                    aria-label={`History path for ${repository.name}`}
                                    placeholder="History path (optional)"
                                    size="dense"
                                    value={path}
                                    onChange={(event) => setPath(event.currentTarget.value)}
                                />
                                {path.length > 0 && (
                                    <Tooltip content="Clear History Path">
                                        <button
                                            type="button"
                                            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground"
                                            aria-label="Clear history path"
                                            onClick={() => setPath('')}
                                        >
                                            <X size={12} />
                                        </button>
                                    </Tooltip>
                                )}
                            </InputGroup>
                        </div>
                        {error ? (
                            <div className="px-3 py-2 text-[11px] text-danger">{error}</div>
                        ) : loading && commits.length === 0 ? (
                            <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted">
                                <Spinner size={12} /> Loading commits…
                            </div>
                        ) : commits.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-muted">No commits.</div>
                        ) : (
                            commits.map((commit) => (
                                <div key={commit.sha}>
                                    <CommitRow
                                        commit={commit}
                                        now={now}
                                        repository={repository}
                                        selected={selectedSha === commit.sha}
                                        onSelect={() =>
                                            setSelectedSha((current) =>
                                                current === commit.sha ? undefined : commit.sha,
                                            )
                                        }
                                    />
                                    {selectedSha === commit.sha && (
                                        <CommitDetails
                                            path={scopePath}
                                            repository={repository}
                                            sha={commit.sha}
                                        />
                                    )}
                                </div>
                            ))
                        )}
                        {nextOffset !== undefined && (
                            <Button
                                className="load-more-commits h-7 w-full gap-1.5 rounded-none text-[11px] text-muted hover:text-foreground"
                                size="sm"
                                variant="ghost"
                                disabled={loading || path !== debouncedPath}
                                onClick={() => {
                                    // eslint-disable-next-line no-void -- intentional floating-promise discard: loadPage owns its own loading/error state
                                    void loadPage(nextOffset, false, repository.head);
                                }}
                            >
                                {loading ? (
                                    <>
                                        <Spinner size={11} /> Loading…
                                    </>
                                ) : (
                                    'Load more commits'
                                )}
                            </Button>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
