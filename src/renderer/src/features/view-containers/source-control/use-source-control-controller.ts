import type { RefCallback } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GitDiffTab } from '@shared/git-diff';
import { parseGitDiffTab } from '@shared/git-diff';
import type { GitSummary, SessionRecord } from '@shared/types';
import { useQuery } from '@tanstack/react-query';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { queryClient, useToastOnQueryError } from '../../../queries/client';
import { useSelectedSession } from '../../../stores/selectors';
import { useActivePaneTab } from '../../workbench/pane-actions';
import { useControlledView, useSourceControlClient } from '../controlled-view-context';
import { subscribeViewEvents } from '../view-event-bridge';
import { controlledViewQueryKey } from '../view-operation-client';
import { describeSourceControlViewError } from './source-control-error';
import type { SourceControlViewMode, SourceControlViewNavigation } from './source-control-state';
import {
    sourceControlNavigationForScope,
    updateSourceControlViewNavigation,
} from './source-control-state';

interface SourceControlViewEmptyController {
    message: string;
    status: 'empty';
}

interface SourceControlViewReadyController {
    activeDiff: GitDiffTab | undefined;
    flashedRepoId: string | undefined;
    focusRepository: (repoId: string) => void;
    mode: SourceControlViewMode;
    navigation: SourceControlViewNavigation;
    pullRequestRefresh: number;
    repositoriesRef: RefCallback<HTMLDivElement>;
    session: SessionRecord;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    setRepositoryExpanded: (repoId: string, isExpanded: boolean) => void;
    status: 'ready';
    summary: GitSummary;
}

export type SourceControlController =
    SourceControlViewEmptyController | SourceControlViewReadyController;

interface SourceControlViewRefreshActions {
    invalidateCommitDetails: () => void;
    refreshPullRequest: () => void;
    refreshWorkingTree: () => void;
}

export function refreshSourceControlView(
    mode: SourceControlViewMode,
    actions: SourceControlViewRefreshActions,
): void {
    if (mode === 'pull-request') {
        actions.refreshPullRequest();
        return;
    }
    if (mode === 'commit') actions.invalidateCommitDetails();
    actions.refreshWorkingTree();
}

/**
 * Owns Session-scoped navigation, Git summary refresh, and repository jump sequencing. The panel view renders the
 * resulting state without duplicating query keys, timers, or scope transitions in JSX.
 */
export function useSourceControlController(): SourceControlController {
    const { extensionGeneration, viewId } = useControlledView();
    const client = useSourceControlClient();
    const session = useSelectedSession();
    const activeResource = useActivePaneTab()?.resource;
    const scope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [navigationByScope, setNavigationByScope] = useState<
        Record<string, SourceControlViewNavigation>
    >({});
    const [pullRequestRefresh, setPullRequestRefresh] = useState(0);
    const [workingRefresh, setWorkingRefresh] = useState(0);
    const [flashedRepoId, setFlashedRepoId] = useState<string>();
    const reduceMotion = useShouldReduceMotion();
    const repositoriesReference = useRef<HTMLDivElement>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
    const navigation = sourceControlNavigationForScope(navigationByScope, scope);
    const mode = navigation.mode;
    const refresh = useCallback(
        () =>
            refreshSourceControlView(mode, {
                // Commit mode reads HEAD from `git.summary` but must also retry a cached details failure.
                invalidateCommitDetails: () => {
                    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
                    void queryClient.invalidateQueries({
                        predicate: ({ queryKey }) =>
                            queryKey[0] === 'viewContainers.viewOperation' &&
                            (queryKey[1] as { operation?: string; viewId?: string } | undefined)
                                ?.viewId === viewId &&
                            (queryKey[1] as { operation?: string } | undefined)?.operation ===
                                'git.commitDetails',
                    });
                },
                refreshPullRequest: () => setPullRequestRefresh((value) => value + 1),
                refreshWorkingTree: () => setWorkingRefresh((value) => value + 1),
            }),
        [mode, viewId],
    );
    useEffect(
        () =>
            !session
                ? () => {}
                : subscribeViewEvents(
                      {
                          viewId,
                          sessionId: session.id,
                          workbenchProjectId: session.workbenchProjectId,
                          extensionGeneration,
                      },
                      (event) => {
                          if (event.payload.change.kind === 'refresh') {
                              refresh();
                              return;
                          }
                          if (event.payload.change.kind !== 'mode') return;
                          if (!scope) return;
                          const nextMode = event.payload.change.mode;
                          setNavigationByScope((current) =>
                              updateSourceControlViewNavigation(
                                  current,
                                  scope,
                                  sourceControlNavigationForScope(current, scope),
                                  { mode: nextMode },
                              ),
                          );
                      },
                  ),
        [extensionGeneration, refresh, scope, session, viewId],
    );
    const sessionId = session?.id;
    const activeDiff =
        activeResource?.kind === 'file' ? parseGitDiffTab(activeResource.path) : undefined;
    /**
     * Runtime invalidation refreshes repository activity automatically. The monotonic nonce makes a manual refresh
     * request a newer snapshot generation instead of joining an in-flight cached request.
     */
    const {
        data: summary,
        isError,
        error,
    } = useQuery({
        queryKey: controlledViewQueryKey(viewId, 'git.summary', { refresh: workingRefresh }, scope),
        queryFn: ({ signal }) => client.summary(workingRefresh, signal),
        enabled: Boolean(sessionId),
    });
    useToastOnQueryError(isError, error, 'Git refresh failed');

    const setRepositoriesElement = useCallback<RefCallback<HTMLDivElement>>((node) => {
        repositoriesReference.current = node;
    }, []);
    if (!session) return { message: 'Create a Session to inspect Git.', status: 'empty' };
    if (!summary) return { message: 'Loading Git status…', status: 'empty' };
    if (!summary.isRepository)
        return {
            message: describeSourceControlViewError(summary.error ?? ''),
            status: 'empty',
        };
    if (summary.repositories.length === 0)
        return { message: 'No approved Git repositories found.', status: 'empty' };

    const updateNavigation = (patch: Partial<SourceControlViewNavigation>): void => {
        if (!scope) return;
        setNavigationByScope((current) =>
            updateSourceControlViewNavigation(current, scope, navigation, patch),
        );
    };
    const setRepoExpanded = (repoId: string, isExpanded: boolean): void =>
        updateNavigation({
            expandedRepositories: {
                ...navigation.expandedRepositories,
                [repoId]: isExpanded,
            },
        });
    const focusRepo = (repoId: string): void => {
        const isExpanded = navigation.expandedRepositories[repoId] ?? true;
        setRepoExpanded(repoId, !isExpanded);
        setFlashedRepoId(repoId);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashedRepoId(undefined), 1600);
        requestAnimationFrame(() => {
            repositoriesReference.current
                ?.querySelector(`[data-git-repository-id="${CSS.escape(repoId)}"]`)
                ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
        });
    };
    return {
        activeDiff,
        flashedRepoId,
        focusRepository: focusRepo,
        mode,
        navigation,
        pullRequestRefresh,
        repositoriesRef: setRepositoriesElement,
        session,
        setDirectoryExpanded: (key, isExpanded) =>
            updateNavigation({
                expandedDirectories: {
                    ...navigation.expandedDirectories,
                    [key]: isExpanded,
                },
            }),
        setRepositoryExpanded: setRepoExpanded,
        status: 'ready',
        summary,
    };
}
