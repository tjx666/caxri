import { useRef } from 'react';

import type {
    BootstrapState,
    CommandId,
    ProjectRecord,
    ProjectStatusOverview,
} from '@caxri/protocol';
import { Monitor } from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useIsLocalOnlyAvailable } from '../../stores/environment';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { NotificationCenter } from '../toasts/notification-center';
import { WindowZoomIndicator } from '../window-zoom/window-zoom-indicator';
import { useActivePaneTab } from '../workbench/pane-actions';
import { ActiveFileStatus } from './active-file-status';
import { activeFileStatusTier } from './active-file-status-target';
import { ActiveTerminalStatus } from './active-terminal-status';
import { AgentChatWaitingChip } from './agent-chat-waiting-chip';
import { BotInboxChip } from './bot-inbox-chip';
import { BotStatusChip } from './bot-status-chip';
import { BranchPicker } from './branch-picker';
import type { ChipVisibility } from './chip-priority';
import { CodexGlobalResetChip } from './codex-global-reset-chip';
import { EnvironmentMonitorChip } from './environment-monitor-chip';
import { useChipVisibility } from './hooks/use-chip-visibility';
import { PeerApprovalChip } from './peer-approval-chip';
import { PermissionAutoAllowChip } from './permission-auto-allow-chip';
import { RemoteDebuggingChip } from './remote-debugging-chip';
import { RepoStatusChips } from './repo-status-chips';
import { relaunchCaxri } from './runtime-commands';
import { ScreencastModeChip } from './screencast-mode-chip';
import { SshHostStatus } from './ssh-host-status';
import { StatusItem, statusItemClassName } from './status-item';
import { UpdateStatusChip } from './update-status-chip';
import { WorkbenchRootPicker } from './workbench-root-picker';

/**
 * Low-frequency fallback only. `projectStatus.changed` and `sessionPullRequests.changed` push a targeted refetch of
 * this query the moment the Server's delivery projection for the Session changes (see `invalidateProjectStatusQuery`
 * and `invalidateSessionPullRequestDependentQueries` in `queries/invalidation.ts`), so this interval exists purely to
 * recover from a missed or dropped event rather than to notice a change itself (issue caxri#1310).
 */
const PROJECT_OVERVIEW_FALLBACK_REFETCH_INTERVAL_MS = 5 * 60_000;

type ServerStatus = BootstrapState['runtime']['status'];

const statusStateClassName = 'statusbar-state flex-none rounded px-2 text-[10px]';

/**
 * A healthy status bar says nothing: it only speaks up while Caxri is degraded, in the user's vocabulary rather than
 * naming Server or Runtime.
 */
const DEGRADED_STATES: Partial<
    Record<
        ServerStatus,
        { labelKey: TranslationKey; detailKey: TranslationKey; className: string; relaunch?: true }
    >
> = {
    /**
     * Main opens a native dialog (Relaunch Caxri, Reveal Logs, Quit) when the status turns failed; the chip is the same
     * relaunch, kept reachable after the dialog is dismissed.
     */
    failed: {
        labelKey: 'statusBar.runtime.failed',
        detailKey: 'statusBar.runtime.failedDetail',
        relaunch: true,
        className:
            'statusbar-state-danger bg-[color-mix(in_srgb,var(--danger)_18%,transparent)] text-danger',
    },
    restarting: {
        labelKey: 'statusBar.runtime.restarting',
        detailKey: 'statusBar.runtime.restartingDetail',
        className:
            'statusbar-state-warning bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-warning',
    },
};

/**
 * `projectStatus.overview` may shell out to a delivery CLI (e.g. `gh`), so it is never invalidated by `files.changed`
 * (see `invalidateFileDependentQueries` in `queries/invalidation.ts`). It instead follows the Server's own delivery
 * push: `projectStatus.changed` and `sessionPullRequests.changed` both invalidate this query for the affected Session,
 * which is what lets the status bar converge with the Status panel and the sidebar row within the same Server refresh
 * instead of waiting out a fixed poll (issue caxri#1310); `PROJECT_OVERVIEW_FALLBACK_REFETCH_INTERVAL_MS` only recovers
 * from a missed or dropped push. Branch and changed-file count instead come from the `git.overview` query: a Files-free
 * projection of the same repository snapshot `SourceControlView` and `GitDiffEditor` read through `git.summary`,
 * invalidated by the Server-driven `git.changed` event, so the status bar reflects a Git-affecting change immediately
 * without pulling the full working-tree `files[]` payload across IPC.
 */
function useProjectOverview(sessionId: string | undefined) {
    const overviewQuery = usePolledQuery(
        'projectStatus.overview',
        { sessionId: sessionId ?? '' },
        {
            label: 'projectStatus.overview',
            intervalMs: PROJECT_OVERVIEW_FALLBACK_REFETCH_INTERVAL_MS,
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

function ActivePaneStatus({
    showAgentThroughput,
    showAgentUsage,
    showChildProcessCount,
    showMemory,
}: {
    showAgentThroughput: boolean;
    showAgentUsage: boolean;
    showChildProcessCount: boolean;
    showMemory: boolean;
}) {
    const session = useSelectedSession();
    const activeResource = useActivePaneTab()?.resource;
    const fileStatusTier =
        activeResource?.kind === 'file' ? activeFileStatusTier(activeResource.path) : 'hidden';
    if (fileStatusTier !== 'hidden' && session && activeResource?.kind === 'file')
        return (
            <ActiveFileStatus
                sessionId={session.id}
                path={activeResource.path}
                tier={fileStatusTier}
                workbenchRootProjectId={session.workbenchRootProjectId}
            />
        );
    if (activeResource?.kind === 'terminal')
        return (
            <ActiveTerminalStatus
                showAgentThroughput={showAgentThroughput}
                showAgentUsage={showAgentUsage}
                showChildProcessCount={showChildProcessCount}
                showMemory={showMemory}
                terminalId={activeResource.terminalId}
            />
        );
    return null;
}

/**
 * Everything that describes what the active Session is working on, left-aligned. Kept apart from `StatusBar` so the
 * footer's own layout is readable next to the pile of conditional chips. It does not grow: `useChipVisibility` reads
 * each region's `scrollWidth` as its natural width, which only holds for a region sized to its content.
 */
function StatusBarContext({
    chipVisibility,
    repo,
    sessionId,
    workbenchProject,
    isWorktree,
}: {
    chipVisibility: ChipVisibility;
    isWorktree: boolean;
    repo?: NonNullable<ProjectStatusOverview['repository']>;
    sessionId?: string;
    workbenchProject?: ProjectRecord;
}) {
    const { t } = useTranslation();
    return (
        <div className="statusbar-context flex min-w-0 items-center gap-0.5 overflow-hidden">
            {/**
             * With a Session selected, the WorkbenchRootPicker below already names the same root (and its tooltip shows the same
             * rootPath), so a separate project chip would print the title twice; the chip only covers the no-Session state.
             */}
            {workbenchProject && !sessionId && (
                <StatusItem
                    icon={<Monitor />}
                    ariaLabel={t('statusBar.project.openFiles', {
                        name: workbenchProject.title,
                    })}
                    title={workbenchProject.rootPath}
                    onClick={() => showSecondarySidebar('secondarySidebar.showFiles')}
                >
                    {workbenchProject.title}
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
                    showTrigger={!isWorktree}
                />
            )}
            {repo && (
                <RepoStatusChips
                    chipVisibility={chipVisibility}
                    repo={repo}
                    sessionId={sessionId}
                />
            )}
        </div>
    );
}

export function StatusBar() {
    const { t } = useTranslation();
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const sessionId = session?.id;
    const overview = useProjectOverview(sessionId);
    const repo = overview?.repository;
    const serverStatus = useWorkbenchStore((state) => state.bootstrap?.runtime.status);
    const degraded = serverStatus ? DEGRADED_STATES[serverStatus] : undefined;
    const containerReference = useRef<HTMLElement>(null);
    const chipVisibility = useChipVisibility(containerReference);
    /**
     * Caxri Bot runs beside this Mac's own Server, so an SSH Host window has no Caxri Bot to report.
     */
    const isLocalOnlyAvailable = useIsLocalOnlyAvailable();
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
            <SshHostStatus />
            <StatusBarContext
                chipVisibility={chipVisibility}
                isWorktree={Boolean(
                    session && workbenchProject && workbenchProject.id !== session.projectId,
                )}
                repo={repo}
                sessionId={sessionId}
                workbenchProject={workbenchProject}
            />
            {/*
             * `min-w-0` lets this side actually shrink instead of pushing width past the window
             * edge: `<body>` has `overflow-x: hidden`, so a `flex-none` sibling here used to be
             * silently clipped below ~752px viewport width with no way to reach it. The chip-
             * priority resolution above (`chip-priority.ts`) hides the lowest-value chips first
             * whenever the content would not fit, so every item keeps its whole label;
             * `overflow-x-auto` stays only as the last-resort fallback for the pathological case
             * where even the never-hide chips don't fit. `ml-auto` keeps it right-aligned now that
             * the context side no longer grows.
             */}
            <div className="statusbar-actions ml-auto flex min-w-0 shrink items-center gap-2 overflow-x-auto">
                {degraded && (
                    <Tooltip content={t(degraded.detailKey)}>
                        {degraded.relaunch ? (
                            <button
                                type="button"
                                className={cn(
                                    statusStateClassName,
                                    degraded.className,
                                    'cursor-pointer hover:bg-[color-mix(in_srgb,var(--danger)_30%,transparent)] focus-visible:shadow-[0_0_0_1px_var(--foreground)] focus-visible:outline-none',
                                )}
                                aria-label={t('statusBar.runtime.relaunchAction')}
                                onClick={relaunchCaxri}
                            >
                                {t(degraded.labelKey)}
                            </button>
                        ) : (
                            <span className={cn(statusStateClassName, degraded.className)}>
                                {t(degraded.labelKey)}
                            </span>
                        )}
                    </Tooltip>
                )}
                <AgentChatWaitingChip />
                <PeerApprovalChip />
                {isLocalOnlyAvailable && <EnvironmentMonitorChip />}
                <UpdateStatusChip />
                {isLocalOnlyAvailable && <BotStatusChip />}
                {isLocalOnlyAvailable && <BotInboxChip />}
                <RemoteDebuggingChip />
                <ScreencastModeChip />
                <PermissionAutoAllowChip />
                <WindowZoomIndicator side="top" triggerClassName={statusItemClassName} />
                <CodexGlobalResetChip />
                <ActivePaneStatus
                    showAgentThroughput={chipVisibility.agentThroughput}
                    showAgentUsage={chipVisibility.agentUsage}
                    showChildProcessCount={chipVisibility.childProcessCount}
                    showMemory={chipVisibility.memory}
                />
            </div>
            {/*
             * Outside `statusbar-actions`, pinned to the far corner the way VS Code's bell is. Every chip beside it
             * follows the active tab and comes and goes as the user moves around, so an anchor placed among them
             * would slide sideways; and inside that scrolling rail the last child is exactly what an overflow would
             * push out of sight. `flex-none` is safe for one 20px control: the clipping this footer guards against
             * came from the whole actions block refusing to shrink.
             */}
            <div className="statusbar-notifications flex flex-none items-center">
                <NotificationCenter />
            </div>
        </footer>
    );
}
