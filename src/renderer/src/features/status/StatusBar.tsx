import {
    FileDiff,
    GitBranch,
    GitPullRequest,
    Monitor,
    PanelRight,
    type LucideIcon,
} from 'lucide-react';
import { type ReactNode } from 'react';

import type { BootstrapState } from '@shared/types';

import { executeCommand } from '../../commands/execute';
import { cn } from '../../lib/utils';
import { usePanelLayoutStore } from '../../state/panel-layout';
import { useCaxriQuery } from '../../state/queries';
import { useSelectedProject, useSelectedSession, useSessionTerminals } from '../../state/selectors';
import { useWorkbenchStore } from '../../state/workbench';

/** No live push exists for delivery metadata, so a stale read is refreshed on a fixed interval. */
const PROJECT_OVERVIEW_REFETCH_INTERVAL_MS = 60_000;

type RuntimeStatus = BootstrapState['runtime']['status'];

const statusItemClassName =
    'statusbar-item inline-flex h-5 min-w-0 items-center gap-[5px] overflow-hidden rounded-[3px] border-0 bg-transparent px-[5px] text-foreground no-underline cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--foreground)] [&>svg]:flex-none [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

const statusStateClassName = 'statusbar-state flex-none rounded px-2 text-[10px]';

/**
 * A healthy backend says nothing: the status bar only speaks up while Caxri is degraded, and it
 * does so in the user's vocabulary rather than naming the Runtime process.
 */
const DEGRADED_STATES: Partial<Record<RuntimeStatus, { label: string; className: string }>> = {
    /** No imperative "Restart" here: recovery is offered by the native Relaunch dialog, not the chip. */
    failed: {
        label: 'Backend stopped',
        className:
            'statusbar-state-danger bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] text-danger',
    },
    restarting: {
        label: 'Reconnecting…',
        className:
            'statusbar-state-warning bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning',
    },
};

function StatusItem({
    ariaLabel,
    children,
    href,
    icon: Icon,
    onClick,
    title,
}: {
    ariaLabel: string;
    children: ReactNode;
    href?: string;
    icon: LucideIcon;
    onClick?: () => void;
    title: string;
}) {
    const content = (
        <>
            <Icon size={13} />
            <span>{children}</span>
        </>
    );
    return href ? (
        <a
            className={statusItemClassName}
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={ariaLabel}
            title={title}
        >
            {content}
        </a>
    ) : (
        <button
            type="button"
            className={statusItemClassName}
            aria-label={ariaLabel}
            title={title}
            onClick={onClick}
        >
            {content}
        </button>
    );
}

/**
 * `projectStatus.overview` may shell out to a delivery CLI (e.g. `gh`) for the pull request, so it
 * stays on the 60s poll and is never invalidated by `files.changed` (see `invalidateFileDependentQueries`
 * in `state/queries.ts`). Branch and changed-file count instead come from the `git.summary` query —
 * the same cheap read `GitPanel` and `GitDiffEditor` use, already invalidated on `files.changed` — so
 * the status bar reflects a Git-affecting change immediately without waiting on the slow poll or
 * calling the delivery CLI any more often than the interval already does.
 */
function useProjectOverview(sessionId: string | undefined) {
    const overviewQuery = useCaxriQuery(
        'projectStatus.overview',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId), refetchInterval: PROJECT_OVERVIEW_REFETCH_INTERVAL_MS },
    );
    const gitSummaryQuery = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    const overview = sessionId ? overviewQuery.data : undefined;
    if (!overview?.repository) return overview;
    const primary = gitSummaryQuery.data?.isRepository
        ? gitSummaryQuery.data.repositories.find((repository) => repository.kind === 'primary')
        : undefined;
    if (!primary) return overview;
    return {
        ...overview,
        repository: {
            ...overview.repository,
            branch: primary.branch,
            changedFileCount: primary.files.length,
        },
    };
}

function showInspector(command: 'inspector.showFiles' | 'inspector.showGit'): void {
    usePanelLayoutStore.getState().setInspectorVisible(true);
    executeCommand(command);
}

export function StatusBar() {
    const project = useSelectedProject();
    const sessionId = useSelectedSession()?.id;
    const overview = useProjectOverview(sessionId);
    const repository = overview?.repository;
    const runtimeStatus = useWorkbenchStore((state) => state.bootstrap?.runtime.status);
    const degraded = runtimeStatus ? DEGRADED_STATES[runtimeStatus] : undefined;
    const runningCount = useSessionTerminals().filter(
        (terminal) => terminal.lastProcessState === 'running',
    ).length;
    const inspectorVisible = usePanelLayoutStore((state) => state.inspectorVisible);
    const toggleLabel = inspectorVisible ? 'Hide Inspector' : 'Show Inspector';
    return (
        /**
         * `data-runtime-status` is the stable readiness signal: it is present in every visual
         * state, including the healthy one that renders no chip at all.
         */
        <footer
            className="statusbar col-span-full flex items-center gap-2 px-2 border-t border-border bg-surface text-muted text-[11px]"
            data-runtime-status={runtimeStatus ?? 'starting'}
        >
            <div className="statusbar-context min-w-0 flex-1 flex items-center gap-0.5 overflow-hidden">
                {project ? (
                    <StatusItem
                        icon={Monitor}
                        ariaLabel={`Open project files: ${project.displayTitle}`}
                        title={project.rootPath}
                        onClick={() => showInspector('inspector.showFiles')}
                    >
                        {project.displayTitle}
                    </StatusItem>
                ) : (
                    <span className="statusbar-empty overflow-hidden text-ellipsis whitespace-nowrap">
                        No Project selected
                    </span>
                )}
                {repository && (
                    <StatusItem
                        icon={GitBranch}
                        href={repository.branchUrl}
                        ariaLabel={`Open branch ${repository.branch}`}
                        title={
                            repository.branchUrl
                                ? `Open ${repository.branch} on GitHub`
                                : `Show Git changes for ${repository.branch}`
                        }
                        onClick={() => showInspector('inspector.showGit')}
                    >
                        {repository.branch}
                    </StatusItem>
                )}
                {repository?.pullRequest && (
                    <StatusItem
                        icon={GitPullRequest}
                        href={repository.pullRequest.url}
                        ariaLabel={`Open pull request #${repository.pullRequest.number}`}
                        title={repository.pullRequest.title}
                    >
                        #{repository.pullRequest.number}
                    </StatusItem>
                )}
                {repository && (
                    <StatusItem
                        icon={FileDiff}
                        ariaLabel={`Open ${repository.changedFileCount} changes`}
                        title="Show primary repository changes"
                        onClick={() => showInspector('inspector.showGit')}
                    >
                        {repository.changedFileCount}{' '}
                        {repository.changedFileCount === 1 ? 'change' : 'changes'}
                    </StatusItem>
                )}
            </div>
            <div className="statusbar-actions flex flex-none items-center gap-2">
                {degraded && (
                    <span className={cn(statusStateClassName, degraded.className)}>
                        {degraded.label}
                    </span>
                )}
                <span className="statusbar-count flex-none">{runningCount} running</span>
                <button
                    type="button"
                    className={cn(
                        'statusbar-toggle',
                        'grid flex-none size-4 place-items-center p-0 border-0 rounded bg-transparent text-muted cursor-pointer',
                        'hover:text-foreground aria-pressed:text-foreground',
                        'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--foreground)_45%,transparent)]',
                    )}
                    aria-pressed={inspectorVisible}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    onClick={() => executeCommand('inspector.toggle')}
                >
                    <PanelRight size={12} />
                </button>
            </div>
        </footer>
    );
}
