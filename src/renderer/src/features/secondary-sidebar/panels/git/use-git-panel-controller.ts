import type { RefCallback } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GitDiffTab } from '@shared/git-diff';
import { parseGitDiffTab } from '@shared/git-diff';
import type { GitSummary, SessionRecord } from '@shared/types';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { queryClient, useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession } from '../../../../stores/selectors';
import { useActivePaneTab } from '../../../workbench/pane-actions';
import { describeGitPanelError } from './git-panel-error';
import type { GitPanelMode, GitPanelNavigation } from './git-panel-state';
import { gitPanelNavigationForScope, updateGitPanelNavigation } from './git-panel-state';

interface GitPanelEmptyController {
    message: string;
    status: 'empty';
}

interface GitPanelReadyController {
    activeDiff: GitDiffTab | undefined;
    flashedRepoId: string | undefined;
    focusRepository: (repoId: string) => void;
    mode: GitPanelMode;
    navigation: GitPanelNavigation;
    pullRequestRefresh: number;
    refresh: () => void;
    repositoriesRef: RefCallback<HTMLDivElement>;
    session: SessionRecord;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    setMode: (mode: GitPanelMode) => void;
    setRepositoryExpanded: (repoId: string, isExpanded: boolean) => void;
    status: 'ready';
    summary: GitSummary;
}

export type GitPanelController = GitPanelEmptyController | GitPanelReadyController;

interface GitPanelRefreshActions {
    invalidateCommitDetails: () => void;
    refreshPullRequest: () => void;
    refreshWorkingTree: () => void;
}

export function refreshGitPanel(mode: GitPanelMode, actions: GitPanelRefreshActions): void {
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
export function useGitPanelController(): GitPanelController {
    const session = useSelectedSession();
    const activeResource = useActivePaneTab()?.resource;
    const scope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const [navigationByScope, setNavigationByScope] = useState<Record<string, GitPanelNavigation>>(
        {},
    );
    const [pullRequestRefresh, setPullRequestRefresh] = useState(0);
    const [workingRefresh, setWorkingRefresh] = useState(0);
    const [flashedRepoId, setFlashedRepoId] = useState<string>();
    const reduceMotion = useShouldReduceMotion();
    const repositoriesReference = useRef<HTMLDivElement>(null);
    const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(flashTimer.current), []);
    const navigation = gitPanelNavigationForScope(navigationByScope, scope);
    const mode = navigation.mode;
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
    } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '', refresh: workingRefresh },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, 'Git refresh failed');

    const setRepositoriesElement = useCallback<RefCallback<HTMLDivElement>>((node) => {
        repositoriesReference.current = node;
    }, []);
    if (!session) return { message: 'Create a Session to inspect Git.', status: 'empty' };
    if (!summary) return { message: 'Loading Git status…', status: 'empty' };
    if (!summary.isRepository)
        return {
            message: describeGitPanelError(summary.error ?? ''),
            status: 'empty',
        };
    if (summary.repositories.length === 0)
        return { message: 'No approved Git repositories found.', status: 'empty' };

    const updateNavigation = (patch: Partial<GitPanelNavigation>): void => {
        if (!scope) return;
        setNavigationByScope((current) =>
            updateGitPanelNavigation(current, scope, navigation, patch),
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
    const refresh = (): void =>
        refreshGitPanel(mode, {
            // Commit mode reads HEAD from `git.summary` but must also retry a cached `git.commitDetails` failure.
            invalidateCommitDetails: () => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard
                void queryClient.invalidateQueries({ queryKey: ['git.commitDetails'] });
            },
            refreshPullRequest: () => setPullRequestRefresh((value) => value + 1),
            refreshWorkingTree: () => setWorkingRefresh((value) => value + 1),
        });

    return {
        activeDiff,
        flashedRepoId,
        focusRepository: focusRepo,
        mode,
        navigation,
        pullRequestRefresh,
        refresh,
        repositoriesRef: setRepositoriesElement,
        session,
        setDirectoryExpanded: (key, isExpanded) =>
            updateNavigation({
                expandedDirectories: {
                    ...navigation.expandedDirectories,
                    [key]: isExpanded,
                },
            }),
        setMode: (nextMode) => updateNavigation({ mode: nextMode }),
        setRepositoryExpanded: setRepoExpanded,
        status: 'ready',
        summary,
    };
}
