import { useEffect, useRef, useState } from 'react';

import { parseGitDiffTab } from '@shared/git-diff';
import { FileDiff, GitCommitHorizontal, GitPullRequest, RefreshCw } from 'lucide-react';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { PanelHeader } from '../../../../components/panel-header';
import { Button } from '../../../../components/ui/button';
import { Empty } from '../../../../components/ui/empty';
import { Tooltip } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utilities';
import { queryClient, useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession } from '../../../../stores/selectors';
import { useActiveWork } from '../../../../stores/session-view';
import type { GitPanelMode } from './git-repo-section';
import { GitRepoSection } from './git-repo-section';
import { submoduleRepositoriesByPath } from './git-tree';

/**
 * Mounted with `key={session.id}` by the Inspector shell. Workbench-root navigation is retained in this component so
 * switching roots clears stale selection while a later return restores it.
 */
export function GitPanel() {
    const session = useSelectedSession();
    const activeWork = useActiveWork();
    const scope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [navigationByScope, setNavigationByScope] = useState<
        Record<
            string,
            {
                expandedDirectories: Record<string, boolean | undefined>;
                expandedRepositories: Record<string, boolean | undefined>;
                mode: GitPanelMode;
            }
        >
    >({});
    const [pullRequestRefresh, setPullRequestRefresh] = useState(0);
    const [workingRefresh, setWorkingRefresh] = useState(0);
    const [flashedRepoId, setFlashedRepoId] = useState<string>();
    const reduceMotion = useShouldReduceMotion();
    const repositoriesReference = useRef<HTMLDivElement>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
    const navigation = scope
        ? (navigationByScope[scope] ?? {
              expandedDirectories: {},
              expandedRepositories: {},
              mode: 'working' as const,
          })
        : { expandedDirectories: {}, expandedRepositories: {}, mode: 'working' as const };
    const mode = navigation.mode;
    const updateNavigation = (patch: Partial<(typeof navigationByScope)[string]>): void => {
        if (!scope) return;
        setNavigationByScope((current) => ({
            ...current,
            [scope]: { ...navigation, ...patch },
        }));
    };
    const setMode = (nextMode: GitPanelMode): void => updateNavigation({ mode: nextMode });
    const setDirectoryExpanded = (key: string, isExpanded: boolean): void =>
        updateNavigation({
            expandedDirectories: { ...navigation.expandedDirectories, [key]: isExpanded },
        });
    const sessionId = session?.id;
    const activeDiff = activeWork?.kind === 'editor' ? parseGitDiffTab(activeWork.path) : undefined;
    /**
     * `git.changed` invalidation is wired centrally in `useRuntimeQueryInvalidation`, so this query only needs to
     * describe what it reads; the re-fetch on Git-affecting repository activity happens without a local effect. The
     * manual Refresh button instead bumps `workingRefresh`, a monotonic nonce baked into the query key: changing it
     * forces the Runtime to serve the newest snapshot generation instead of joining an in-flight cached one.
     */
    const {
        data: summary,
        isError,
        error,
    } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '', refresh: workingRefresh },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, 'Git refresh failed');
    if (!session)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                Create a Session to inspect Git.
            </Empty>
        );
    if (!summary)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                Loading Git status…
            </Empty>
        );
    if (!summary.isRepository)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">{summary.error}</Empty>
        );
    if (summary.repositories.length === 0)
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                No approved Git repositories found.
            </Empty>
        );
    /**
     * Jump target for submodule rows: toggle the submodule's own section like its header does, scroll it into view, and
     * flash it briefly so the eye lands on the right section.
     */
    const focusRepo = (repoId: string): void => {
        const isExpanded = navigation.expandedRepositories[repoId] ?? true;
        updateNavigation({
            expandedRepositories: {
                ...navigation.expandedRepositories,
                [repoId]: !isExpanded,
            },
        });
        setFlashedRepoId(repoId);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashedRepoId(undefined), 1600);
        requestAnimationFrame(() => {
            repositoriesReference.current
                ?.querySelector(`[data-git-repository-id="${CSS.escape(repoId)}"]`)
                ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
        });
    };
    const refresh = (): void => {
        if (mode === 'pull-request') {
            setPullRequestRefresh((value) => value + 1);
            return;
        }
        // Commit mode reads HEAD from `git.summary` (the working nonce) but must also retry a
        // cached `git.commitDetails` failure, whose key (same sha) would otherwise never change.
        if (mode === 'commit') {
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void queryClient.invalidateQueries({ queryKey: ['git.commitDetails'] });
        }
        setWorkingRefresh((value) => value + 1);
    };
    return (
        <div className="inspector-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <PanelHeader
                className="git-heading"
                title="Source Control"
                actions={
                    <>
                        <div
                            className="git-mode-switch flex h-7 items-center rounded-md bg-elevated p-0.5"
                            role="group"
                            aria-label="Source control mode"
                        >
                            <Tooltip content="Working Tree Changes">
                                <button
                                    type="button"
                                    className={cn(
                                        'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                        mode === 'working' && 'bg-surface text-foreground',
                                    )}
                                    aria-label="Working Tree Changes"
                                    aria-pressed={mode === 'working'}
                                    onClick={() => setMode('working')}
                                >
                                    {/* A working-tree change set is a diff, not a branch: the branch mark already
                                labels the Git tab and every repository row, and a third copy here made the
                                three modes read as one repeated glyph. */}
                                    <FileDiff size={13} />
                                </button>
                            </Tooltip>
                            <Tooltip content="Last Commit Changes">
                                <button
                                    type="button"
                                    className={cn(
                                        'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                        mode === 'commit' && 'bg-surface text-foreground',
                                    )}
                                    aria-label="Last Commit Changes"
                                    aria-pressed={mode === 'commit'}
                                    onClick={() => setMode('commit')}
                                >
                                    <GitCommitHorizontal size={13} />
                                </button>
                            </Tooltip>
                            <Tooltip content="Pull Request Changes">
                                <button
                                    type="button"
                                    className={cn(
                                        'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                        mode === 'pull-request' && 'bg-surface text-foreground',
                                    )}
                                    aria-label="Pull Request Changes"
                                    aria-pressed={mode === 'pull-request'}
                                    onClick={() => setMode('pull-request')}
                                >
                                    <GitPullRequest size={13} />
                                </button>
                            </Tooltip>
                        </div>
                        <Tooltip
                            content={
                                mode === 'pull-request' ? 'Refresh Pull Request' : 'Refresh Git'
                            }
                        >
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={
                                    mode === 'pull-request' ? 'Refresh Pull Request' : 'Refresh Git'
                                }
                                onClick={refresh}
                            >
                                <RefreshCw size={13} />
                            </Button>
                        </Tooltip>
                    </>
                }
            />
            <div
                ref={repositoriesReference}
                className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
                aria-label="Git repositories"
            >
                {summary.repositories.map((repo) => (
                    <GitRepoSection
                        key={repo.id}
                        repository={repo}
                        activeDiff={activeDiff}
                        expanded={navigation.expandedRepositories[repo.id] ?? true}
                        expandedDirectories={navigation.expandedDirectories}
                        flashed={flashedRepoId === repo.id}
                        mode={mode}
                        submodulesByPath={submoduleRepositoriesByPath(repo, summary.repositories)}
                        onFocusRepository={focusRepo}
                        onExpandedChange={(isExpanded) =>
                            updateNavigation({
                                expandedRepositories: {
                                    ...navigation.expandedRepositories,
                                    [repo.id]: isExpanded,
                                },
                            })
                        }
                        pullRequestRefresh={pullRequestRefresh}
                        sessionId={session.id}
                        setDirectoryExpanded={setDirectoryExpanded}
                    />
                ))}
            </div>
        </div>
    );
}
