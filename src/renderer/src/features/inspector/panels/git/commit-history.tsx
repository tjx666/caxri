import { useCallback, useEffect, useRef, useState } from 'react';

import { relativeTime } from '@caxri/utils';
import type { GitCommit, GitRepositorySummary } from '@shared/types';
import { ChevronDown, ChevronRight, GitCommitHorizontal } from 'lucide-react';

import { useDebouncedValue } from '@/hooks/use-debounced-value';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Spinner } from '../../../../components/ui/spinner';
import { caxri } from '../../../../lib/caxri';
import { cn } from '../../../../lib/utilities';
import { useCaxriQuery } from '../../../../queries/client';
import { describeFailure } from '../../../../stores/toasts';

const PAGE_SIZE = 5;

function CommitDetails({
    path,
    repository,
    sessionId,
    sha,
}: {
    path?: string;
    repository: GitRepositorySummary;
    sessionId: string;
    sha: string;
}) {
    const details = useCaxriQuery('git.commitDetails', {
        sessionId,
        repositoryId: repository.id,
        sha,
        path,
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
                    <div
                        className="flex min-h-6 items-center gap-2 px-3 text-[11px]"
                        key={`${file.previousPath ?? ''}:${file.path}`}
                        title={
                            file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
                        }
                    >
                        <span className="w-14 shrink-0 text-muted">{file.status}</span>
                        <span className="truncate">{file.path}</span>
                    </div>
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
    selected,
    onSelect,
}: {
    commit: GitCommit;
    selected: boolean;
    onSelect: () => void;
}) {
    const absoluteTime = new Date(commit.authoredAt).toLocaleString();
    return (
        <button
            type="button"
            className={cn(
                'commit-row flex w-full cursor-pointer flex-col gap-0.5 border-0 bg-surface px-3 py-1.5 text-left hover:bg-elevated',
                selected && 'bg-elevated',
            )}
            aria-label={`Commit ${commit.subject}`}
            title={`${commit.sha}\n${commit.author} · ${absoluteTime}`}
            onClick={onSelect}
        >
            <span className="flex w-full min-w-0 items-center gap-2">
                <span className="truncate text-foreground">{commit.subject || '(no subject)'}</span>
                <code className="ml-auto shrink-0 text-[10px] text-muted">{commit.shortSha}</code>
            </span>
            <span className="flex w-full min-w-0 items-center gap-1 text-[10px] text-muted">
                <span className="truncate">{commit.author}</span>
                <span>·</span>
                <time dateTime={new Date(commit.authoredAt).toISOString()} title={absoluteTime}>
                    {relativeTime(commit.authoredAt)}
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
        </button>
    );
}

export function CommitHistory({
    repository,
    sessionId,
}: {
    repository: GitRepositorySummary;
    sessionId: string;
}) {
    const [expanded, setExpanded] = useState(false);
    const [path, setPath] = useState('');
    const debouncedPath = useDebouncedValue(path, 200);
    const [commits, setCommits] = useState<GitCommit[]>([]);
    const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
    const [selectedSha, setSelectedSha] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const requestSequence = useRef(0);
    const activeRequest = useRef<{ head?: string; sequence: number } | undefined>(undefined);
    const scopePath = debouncedPath.trim() || undefined;

    const loadPage = useCallback(
        async (offset: number, shouldReplace: boolean, head?: string) => {
            const request = { head, sequence: ++requestSequence.current };
            activeRequest.current = request;
            setLoading(true);
            if (shouldReplace) {
                setCommits([]);
                setSelectedSha(undefined);
            }
            setError(undefined);
            try {
                const page = await caxri.request('git.commits', {
                    sessionId,
                    repositoryId: repository.id,
                    offset,
                    pageSize: PAGE_SIZE,
                    path: scopePath,
                });
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
        [repository.id, scopePath, sessionId],
    );

    useEffect(() => {
        if (!expanded) {
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
            activeRequest.current = undefined;
        };
    }, [expanded, loadPage, repository.head]);

    return (
        <section className="commit-history border-t border-border">
            <button
                type="button"
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-surface px-2 text-left text-[10px] font-bold tracking-[0.06em] text-muted uppercase hover:bg-elevated"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <GitCommitHorizontal size={12} />
                <span>Commits</span>
                {expanded && <span className="ml-auto">{commits.length}</span>}
            </button>
            <DisclosureMotion animate expanded={expanded} kind="git-history">
                {() => (
                    <div>
                        <div className="border-y border-border p-1.5">
                            <Input
                                appearance="workbench"
                                className="w-full text-foreground"
                                aria-label={`History path for ${repository.name}`}
                                placeholder="History path (optional)"
                                size="compact"
                                value={path}
                                onChange={(event) => setPath(event.currentTarget.value)}
                            />
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
                                            sessionId={sessionId}
                                            sha={commit.sha}
                                        />
                                    )}
                                </div>
                            ))
                        )}
                        {nextOffset !== undefined && (
                            <div className="p-1.5">
                                <Button
                                    className="w-full"
                                    variant="ghost"
                                    disabled={loading || path !== debouncedPath}
                                    onClick={() => {
                                        // eslint-disable-next-line no-void -- intentional floating-promise discard: loadPage owns its own loading/error state
                                        void loadPage(nextOffset, false, repository.head);
                                    }}
                                >
                                    {loading ? 'Loading…' : 'Load more'}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
