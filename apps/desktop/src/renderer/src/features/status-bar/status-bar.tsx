import type { BootstrapState, CommandId } from '@caxri/protocol';
import { isExternalEditorTabPath, parseGitDiffTab } from '@caxri/protocol';
import { FileDiff, GitPullRequest, Monitor } from 'lucide-react';

import { useContainerWidth } from '@/hooks/use-container-width';
import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { NotificationCenter } from '../toasts/notification-center';
import { useActivePaneTab } from '../workbench/pane-actions';
import { ActiveFileStatus } from './active-file-status';
import { ActiveTerminalStatus } from './active-terminal-status';
import { BranchPicker } from './branch-picker';
import { resolveChipVisibility } from './chip-priority';
import { ScreencastModeChip } from './screencast-mode-chip';
import { StatusItem } from './status-item';
import { WorkbenchRootPicker } from './workbench-root-picker';

/**
 * No live push exists for delivery metadata, so a stale read is refreshed on a fixed interval.
 */
const PROJECT_OVERVIEW_REFETCH_INTERVAL_MS = 60_000;

type ServerStatus = BootstrapState['runtime']['status'];

const statusStateClassName = 'statusbar-state flex-none rounded px-2 text-[10px]';

/**
 * A healthy status bar says nothing: it only speaks up while Caxri is degraded, in the user's vocabulary rather than
 * naming Server or Runtime.
 */
const DEGRADED_STATES: Partial<
    Record<ServerStatus, { label: string; detail: string; className: string }>
> = {
    /**
     * No imperative "Restart" here: recovery is offered by the native Relaunch dialog, not the chip.
     */
    failed: {
        label: 'Caxri stopped',
        detail: 'Caxri stopped unexpectedly. Recovery is offered in the native Relaunch dialog.',
        className:
            'statusbar-state-danger bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] text-danger',
    },
    restarting: {
        label: 'Reconnecting…',
        detail: 'Caxri is reconnecting; this chip clears once it reconnects.',
        className:
            'statusbar-state-warning bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning',
    },
};

/**
 * `projectStatus.overview` may shell out to a delivery CLI (e.g. `gh`) for the pull request, so it stays on the 60s
 * poll and is never invalidated by `files.changed` (see `invalidateFileDependentQueries` in `queries/invalidation.ts`).
 * Branch and changed-file count instead come from the `git.overview` query — a Files-free projection of the same
 * repository snapshot `SourceControlView` and `GitDiffEditor` read through `git.summary`, invalidated by the
 * Server-driven `git.changed` event — so the status bar reflects a Git-affecting change immediately without pulling the
 * full working-tree `files[]` payload across IPC or calling the delivery CLI any more often than the interval already
 * does.
 */
function useProjectOverview(sessionId: string | undefined) {
    const overviewQuery = usePolledQuery(
        'projectStatus.overview',
        { sessionId: sessionId ?? '' },
        {
            label: 'projectStatus.overview',
            intervalMs: PROJECT_OVERVIEW_REFETCH_INTERVAL_MS,
            enabled: Boolean(sessionId),
        },
    );
    const gitOverviewQuery = useCaxriQuery(
        'git.overview',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    const overview = sessionId ? overviewQuery.data : undefined;
    if (!overview?.repository) return overview;
    const primary = gitOverviewQuery.data?.isRepository
        ? gitOverviewQuery.data.repositories.find((repo) => repo.kind === 'primary')
        : undefined;
    if (!primary) return overview;
    return {
        ...overview,
        repository: {
            ...overview.repository,
            id: primary.id,
            branch: primary.branch,
            changedFileCount: primary.changedFileCount,
            additions: primary.additions,
            deletions: primary.deletions,
        },
    };
}

function showSecondarySidebar(command: Extract<CommandId, `secondarySidebar.show${string}`>): void {
    executeCommand(command);
}

function RepoChangesStatus({ additions, deletions }: { additions: number; deletions: number }) {
    return (
        <StatusItem
            icon={FileDiff}
            ariaLabel={`Open changes: ${additions} ${additions === 1 ? 'addition' : 'additions'}, ${deletions} ${deletions === 1 ? 'deletion' : 'deletions'}`}
            title="Show primary repository changes"
            onClick={() => showSecondarySidebar('secondarySidebar.showGit')}
        >
            +{additions} -{deletions}
        </StatusItem>
    );
}

function ActivePaneStatus({
    showChildProcessCount,
    showMemory,
}: {
    showChildProcessCount: boolean;
    showMemory: boolean;
}) {
    const session = useSelectedSession();
    const activeResource = useActivePaneTab()?.resource;
    if (
        session &&
        activeResource?.kind === 'file' &&
        !isExternalEditorTabPath(activeResource.path) &&
        !parseGitDiffTab(activeResource.path)
    )
        return (
            <ActiveFileStatus
                sessionId={session.id}
                path={activeResource.path}
                workbenchProjectId={session.workbenchProjectId}
            />
        );
    if (activeResource?.kind === 'terminal')
        return (
            <ActiveTerminalStatus
                showChildProcessCount={showChildProcessCount}
                showMemory={showMemory}
                terminalId={activeResource.terminalId}
            />
        );
    return null;
}

export function StatusBar() {
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const sessionId = session?.id;
    const overview = useProjectOverview(sessionId);
    const repo = overview?.repository;
    const serverStatus = useWorkbenchStore((state) => state.bootstrap?.runtime.status);
    const degraded = serverStatus ? DEGRADED_STATES[serverStatus] : undefined;
    const [containerReference, containerWidth] = useContainerWidth<HTMLElement>();
    const chipVisibility = resolveChipVisibility(containerWidth);
    return (
        /**
         * `data-runtime-status` is the stable readiness signal: it is present in every visual state, including the
         * healthy one that renders no chip at all.
         */
        <footer
            ref={containerReference}
            className="statusbar col-span-full flex items-center gap-2 bg-surface px-2 text-[11px] text-muted"
            data-runtime-status={serverStatus ?? 'starting'}
        >
            <div className="statusbar-context flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                {/**
                 * With a Session selected, the WorkbenchRootPicker below already names the same root (and its tooltip shows the same
                 * rootPath), so a separate project chip would print the title twice; the chip only covers the no-Session state.
                 */}
                {workbenchProject && !sessionId && (
                    <StatusItem
                        icon={Monitor}
                        ariaLabel={`Open project files: ${workbenchProject.displayTitle}`}
                        title={workbenchProject.rootPath}
                        onClick={() => showSecondarySidebar('secondarySidebar.showFiles')}
                    >
                        {workbenchProject.displayTitle}
                    </StatusItem>
                )}
                {/*
                 * No "No Project selected" placeholder: the only way to reach this state is an empty Workbench, where
                 * the PrimarySidebar already offers "Add your first Project" at full size. Restating it in the status bar
                 * says nothing new and gives the emptiest screen its most prominent line of prose.
                 */}
                {sessionId && <WorkbenchRootPicker branch={repo?.branch} sessionId={sessionId} />}
                {repo && sessionId && (
                    <BranchPicker
                        branch={repo.branch}
                        repositoryId={repo.id}
                        sessionId={sessionId}
                    />
                )}
                {repo?.pullRequest && chipVisibility.pullRequest && (
                    <StatusItem
                        icon={GitPullRequest}
                        href={repo.pullRequest.url}
                        ariaLabel={`Open pull request #${repo.pullRequest.number}`}
                        title={repo.pullRequest.title}
                    >
                        #{repo.pullRequest.number}
                    </StatusItem>
                )}
                {repo && (
                    <RepoChangesStatus additions={repo.additions} deletions={repo.deletions} />
                )}
            </div>
            {/*
             * `min-w-0` lets this side actually shrink instead of pushing width past the window
             * edge — `<body>` has `overflow-x: hidden`, so a `flex-none` sibling here used to be
             * silently clipped below ~752px viewport width with no way to reach it. The chip-
             * priority resolution above (`chip-priority.ts`) now hides the lowest-value chips first
             * as the footer narrows, so information stays reachable without a scrollbar for every
             * ordinary window width; `overflow-x-auto` stays only as the last-resort fallback for
             * the pathological case where even the never-hide chips (degraded/runtime state and
             * Terminal progress) don't fit.
             */}
            <div className="statusbar-actions flex min-w-0 shrink items-center gap-2 overflow-x-auto">
                <NotificationCenter />
                {degraded && (
                    <Tooltip content={degraded.detail}>
                        <span className={cn(statusStateClassName, degraded.className)}>
                            {degraded.label}
                        </span>
                    </Tooltip>
                )}
                <ScreencastModeChip />
                <ActivePaneStatus
                    showChildProcessCount={chipVisibility.childProcessCount}
                    showMemory={chipVisibility.memory}
                />
            </div>
        </footer>
    );
}
