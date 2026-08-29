import type { ReactNode } from 'react';
import { useState } from 'react';

import type { BootstrapState, CaxriMethod, CommandId } from '@caxri/protocol';
import { isExternalEditorTabPath, parseGitDiffTab } from '@caxri/protocol';
import { relativeTime } from '@caxri/utils';
import { useQueryClient } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
    Braces,
    Cast,
    CircleAlert,
    FileDiff,
    FolderGit2,
    Gauge,
    GitBranch,
    GitCommitHorizontal,
    GitPullRequest,
    LoaderCircle,
    MemoryStick,
    Monitor,
    Pause,
    Workflow,
} from 'lucide-react';

import { useContainerWidth } from '@/hooks/use-container-width';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useNow } from '@/hooks/use-now';
import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Separator } from '../../components/ui/separator';
import { Tooltip } from '../../components/ui/tooltip';
import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import {
    useSelectedSession,
    useSelectedWorkbenchProject,
    useTerminal,
} from '../../stores/selectors';
import { sessionViewScope } from '../../stores/session-view';
import { pushToast, tryCommand } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    editorLanguageLabel,
    editorStatusKey,
    useEditorStatusStore,
} from '../editor/editor-status';
import { useScreencastStore } from '../screencast/screencast';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { useActivePaneTab } from '../workbench/pane-actions';
import { resolveChipVisibility } from './chip-priority';

/**
 * No live push exists for delivery metadata, so a stale read is refreshed on a fixed interval.
 */
const PROJECT_OVERVIEW_REFETCH_INTERVAL_MS = 60_000;
const AUTHORIZE_WORKBENCH_ROOT_VALUE = '__authorize_workbench_root__';

type ServerStatus = BootstrapState['runtime']['status'];

const statusItemClassName =
    'statusbar-item inline-flex h-5 min-w-0 items-center gap-[5px] overflow-hidden rounded border-0 bg-transparent px-[5px] text-foreground no-underline cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--foreground)] [&>svg]:flex-none [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

const statusStateClassName = 'statusbar-state flex-none rounded px-2 text-[10px]';
const statusInfoClassName =
    'statusbar-info inline-flex h-5 min-w-0 flex-none items-center gap-[5px] overflow-hidden rounded px-[5px] text-foreground [&>svg]:flex-none [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

/**
 * DESIGN.md requires explanatory prose in both the accessible name and a hover tooltip: an `aria-label` alone leaves
 * sighted mouse users with less information than assistive tech gets. Wrapped in the shared `Tooltip` primitive rather
 * than a bare `title` attribute so it renders consistently (and visibly) instead of relying on Chromium's native,
 * easy-to-miss tooltip.
 */
function StatusInfo({
    announce,
    ariaLabel,
    children,
    className,
    icon: Icon,
    title,
}: {
    announce?: boolean;
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    icon?: LucideIcon;
    title: ReactNode;
}) {
    return (
        <Tooltip content={title}>
            <span
                aria-label={ariaLabel}
                aria-live={announce ? 'polite' : undefined}
                className={cn(statusInfoClassName, className)}
                role={announce ? 'status' : undefined}
            >
                {Icon && <Icon size={12} />}
                <span>{children}</span>
            </span>
        </Tooltip>
    );
}

function ActiveFileStatus({
    sessionId,
    path,
    workbenchProjectId,
}: {
    sessionId: string;
    path: string;
    workbenchProjectId: string;
}) {
    const key = editorStatusKey(sessionViewScope(sessionId, workbenchProjectId), path);
    const editorStatus = useEditorStatusStore((state) => state.statuses[key]);
    const line = useDebouncedValue(editorStatus?.line ?? 1, 150);
    const now = useNow(30_000);
    const blame = useCaxriQuery(
        'git.blame',
        { sessionId, path, line },
        { staleTime: 60_000, retry: false },
    ).data;
    const language = editorLanguageLabel(editorStatus?.languageId ?? 'plaintext');
    const cursor = editorStatus
        ? `Ln ${editorStatus.line}, Col ${editorStatus.column}`
        : 'Ln 1, Col 1';
    const selection = editorStatus?.selectedCharacters ?? 0;
    return (
        <>
            {blame && (
                <StatusInfo
                    ariaLabel={
                        blame.uncommitted
                            ? `Git blame: uncommitted changes on line ${line}`
                            : `Git blame: ${blame.author}, ${relativeTime(blame.authoredAt, now)}, ${blame.subject}`
                    }
                    className="statusbar-blame max-w-[420px]"
                    icon={GitCommitHorizontal}
                    title={
                        blame.uncommitted ? (
                            `Uncommitted changes · line ${line}`
                        ) : (
                            // The tooltip primitive doesn't collapse `\n` like a native `title`
                            // attribute would, so the three-line author/sha/subject summary needs
                            // an explicit `whitespace-pre-line` wrapper to keep its line breaks.
                            <span className="whitespace-pre-line">
                                {`${blame.author} · ${new Date(blame.authoredAt).toLocaleString()}\n${blame.sha}\n${blame.subject}`}
                            </span>
                        )
                    }
                >
                    {blame.uncommitted
                        ? 'Uncommitted changes'
                        : `${blame.author}, ${relativeTime(blame.authoredAt, now)} · ${blame.subject}`}
                </StatusInfo>
            )}
            <StatusInfo
                ariaLabel={`Editor position: ${cursor}${selection > 0 ? `, ${selection} characters selected` : ''}`}
                className="statusbar-selection"
                title="Editor selection"
            >
                {selection > 0 && `${selection} selected · `}
                {cursor}
            </StatusInfo>
            <StatusInfo
                ariaLabel={`File type: ${language}`}
                className="statusbar-language"
                icon={Braces}
                title="File type"
            >
                {language}
            </StatusInfo>
        </>
    );
}

const openProcessExplorer = (): void => executeCommand('processExplorer.open');

function ActiveTerminalStatus({
    showChildProcessCount,
    showMemory,
    terminalId,
}: {
    /**
     * Priority-hidden first as the status bar narrows (see `chip-priority.ts`): both metrics duplicate a live reading
     * already available in Process Explorer, so hiding them loses no information the user cannot get elsewhere.
     */
    showChildProcessCount: boolean;
    showMemory: boolean;
    terminalId: string;
}) {
    const terminal = useTerminal(terminalId);
    const isCompacting = terminal?.agentOperation === 'compacting';
    const progress = useTerminalProgress(terminalId);
    const usage = usePolledQuery(
        'terminal.resources',
        { terminalId },
        { label: 'terminal.resources', intervalMs: 2_000, staleTime: 1_000, retry: false },
    ).data;
    if (!usage && !progress && !isCompacting) return null;
    const childLabel = usage
        ? `${usage.childProcessCount} ${usage.childProcessCount === 1 ? 'child process' : 'child processes'}`
        : undefined;
    const ProgressIcon =
        progress?.kind === 'error'
            ? CircleAlert
            : progress?.kind === 'paused'
              ? Pause
              : progress?.kind === 'indeterminate'
                ? LoaderCircle
                : Gauge;
    return (
        <>
            {isCompacting && (
                <StatusInfo
                    announce
                    ariaLabel="Codex is compacting context"
                    className="statusbar-agent-operation text-muted"
                    title="Codex is summarizing earlier context before continuing."
                >
                    Compacting
                </StatusInfo>
            )}
            {progress && !isCompacting && (
                <StatusInfo
                    ariaLabel={terminalProgressAriaLabel(progress)}
                    className={cn(
                        'statusbar-terminal-progress tabular-nums',
                        /**
                         * `--accent` is reserved for the one focused pane/tab (DESIGN.md principle 2). This badge
                         * renders for every Terminal with progress, not just the active one, so a background process
                         * must not borrow the accent color — only the genuinely exceptional states (`error`/`paused`)
                         * get a status color here; the common "normal" case stays neutral.
                         */
                        progress.kind === 'normal' && 'text-muted',
                        progress.kind === 'error' && 'text-danger',
                        progress.kind === 'paused' && 'text-warning',
                    )}
                    icon={ProgressIcon}
                    title={terminalProgressAriaLabel(progress)}
                >
                    {terminalProgressLabel(progress)}
                </StatusInfo>
            )}
            {/**
             * Deliberately informational-only, not the primary entry point: "Open Process Explorer" already lives in the native
             * Help menu and the Command Palette (`processExplorer.open` in `shared/commands.ts`), so it stays reachable regardless
             * of the active tab. Duplicating it as an always-present status-bar button would compete with those two discoverable
             * routes for a diagnostic tool most users open rarely; instead this chip earns its place by doubling as a live memory
             * reading for the active Terminal; clicking it is a convenience shortcut, not a required affordance, which is why it is
             * allowed to disappear on editor/diff tabs where there is no Terminal metric to show.
             */}
            {usage && showMemory && (
                <StatusItem
                    ariaLabel={`Open Process Explorer — Terminal memory: ${usage.memoryMb} MB`}
                    icon={MemoryStick}
                    title={`Open Process Explorer — Terminal memory: ${usage.memoryMb} MB`}
                    onClick={openProcessExplorer}
                >
                    {usage.memoryMb} MB
                </StatusItem>
            )}
            {usage && childLabel && showChildProcessCount && (
                <StatusItem
                    ariaLabel={`Open Process Explorer — Terminal: ${childLabel}`}
                    icon={Workflow}
                    title={`Open Process Explorer — Terminal: ${childLabel}`}
                    onClick={openProcessExplorer}
                >
                    {usage.childProcessCount}
                </StatusItem>
            )}
        </>
    );
}

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
 * Same hover-tooltip contract as {@link StatusInfo}, for the clickable status-bar entries.
 */
function StatusItem({
    ariaLabel,
    children,
    className,
    href,
    icon: Icon,
    onClick,
    title,
}: {
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    href?: string;
    icon: LucideIcon;
    onClick?: () => void;
    title: ReactNode;
}) {
    const content = (
        <>
            <Icon size={13} />
            <span>{children}</span>
        </>
    );
    return (
        <Tooltip content={title}>
            {href ? (
                <a
                    className={cn(statusItemClassName, className)}
                    href={href}
                    rel="noreferrer"
                    aria-label={ariaLabel}
                    onClick={(event) => {
                        // Main denies every `window.open`/target=_blank navigation, so this anchor
                        // is semantic only — the actual navigation goes through `external.open`.
                        event.preventDefault();
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
                        void openExternalUrl(href, (message) => pushToast('error', message));
                    }}
                >
                    {content}
                </a>
            ) : (
                <button
                    type="button"
                    className={cn(statusItemClassName, className)}
                    aria-label={ariaLabel}
                    onClick={onClick}
                >
                    {content}
                </button>
            )}
        </Tooltip>
    );
}

/**
 * Screencast Mode has no other persistent cue while active — see `screencast.ts`'s `toggleScreencastMode` for the
 * paired toast. Muted tokens keep it quiet per DESIGN.md's status bar redline (only degraded Server state earns a loud
 * chip); clicking replays the same toggle command a keybinding or the command palette would run.
 */
const screencastChipClassName = 'text-muted';

/**
 * The chip name alone implies recording safety it does not provide, so both the accessible name and the hover tooltip
 * spell out the actual behavior: Screencast Mode only overlays click ripples and a privacy-filtered keystroke badge
 * (see `screencast.ts`'s `describeScreencastKey`) — it never hides or redacts anything already visible on screen, so
 * source code and Terminal output stay exactly as exposed as they would be without it.
 */
const SCREENCAST_CHIP_LABEL =
    'Screencast Mode is on — click to turn it off. It overlays click ripples and keystroke hints for recording; it does not hide or redact anything already on screen.';

function ScreencastModeChip() {
    const isEnabled = useScreencastStore((state) => state.enabled);
    if (!isEnabled) return null;
    return (
        <StatusItem
            icon={Cast}
            ariaLabel={SCREENCAST_CHIP_LABEL}
            title={SCREENCAST_CHIP_LABEL}
            className={screencastChipClassName}
            onClick={() => executeCommand('developer.toggleScreencastMode')}
        >
            Screencast
        </StatusItem>
    );
}

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

const BRANCH_SWITCH_DEPENDENCIES = new Set<CaxriMethod>([
    'git.summary',
    'git.overview',
    'git.branches',
    'git.diffDocument',
    'git.pullRequestChanges',
    'git.pullRequestDiffDocument',
    'git.commits',
    'git.commitDetails',
    'git.blame',
    'projectStatus.overview',
    'projectStatus.summary',
]);

function BranchPicker({
    branch,
    repositoryId,
    sessionId,
}: {
    branch: string;
    repositoryId: string;
    sessionId: string;
}) {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState(false);
    const now = useNow(30_000);
    const branchesQuery = useCaxriQuery(
        'git.branches',
        { sessionId, repositoryId },
        { enabled: open },
    );
    useToastOnQueryError(branchesQuery.isError, branchesQuery.error, 'Unable to list branches');
    const loadedBranches = branchesQuery.data ?? [];
    // The current branch is pinned first; the rest keep the Server's most-recent-commit order.
    // Before the query resolves only the current branch is known, without a commit time.
    const branches: Array<{ name: string; committedAt?: number }> = [
        loadedBranches.find((candidate) => candidate.name === branch) ?? { name: branch },
        ...loadedBranches.filter((candidate) => candidate.name !== branch),
    ];

    const switchBranch = async (nextBranch: string | null): Promise<void> => {
        if (!nextBranch || nextBranch === branch || switching) return;
        setSwitching(true);
        try {
            const result = await tryCommand('Unable to switch branch', () =>
                caxri.request('git.switchBranch', {
                    sessionId,
                    repositoryId,
                    branch: nextBranch,
                }),
            );
            if (result === undefined) return;
            await queryClient.invalidateQueries({
                predicate: (query) => {
                    const [method, parameters] = query.queryKey as [
                        CaxriMethod,
                        { sessionId?: string } | undefined,
                    ];
                    return (
                        BRANCH_SWITCH_DEPENDENCIES.has(method) &&
                        parameters?.sessionId === sessionId
                    );
                },
            });
        } finally {
            setSwitching(false);
        }
    };

    return (
        <Select
            value={branch}
            open={open}
            disabled={switching}
            onOpenChange={setOpen}
            onValueChange={(value) => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, switchBranch() reports its own errors via tryCommand
                void switchBranch(value);
            }}
        >
            <SelectTrigger
                showIcon={false}
                aria-label={`Switch branch from ${branch}`}
                title={`Switch branch from ${branch}`}
                className={cn(
                    statusItemClassName,
                    'h-5 w-auto max-w-full justify-start px-[5px] text-[11px]',
                )}
            >
                <GitBranch size={13} />
                <SelectValue>{branch}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-96 min-w-48">
                {branches.map(({ name, committedAt }) => (
                    <SelectItem key={name} value={name} className="max-w-96">
                        <span className="flex min-w-0 items-baseline gap-2">
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                {name}
                            </span>
                            {committedAt !== undefined && (
                                <span className="flex-none text-[11px] text-muted">
                                    {relativeTime(committedAt, now)}
                                </span>
                            )}
                        </span>
                    </SelectItem>
                ))}
                {branchesQuery.isLoading && (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted">
                        <LoaderCircle className="animate-spin" size={12} />
                        Loading branches…
                    </div>
                )}
            </SelectContent>
        </Select>
    );
}

function WorkbenchRootPicker({ branch, sessionId }: { branch?: string; sessionId: string }) {
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState(false);
    const rootsQuery = useCaxriQuery(
        'session.workbenchRoots',
        { sessionId },
        { enabled: open, staleTime: 0 },
    );
    useToastOnQueryError(rootsQuery.isError, rootsQuery.error, 'Unable to list Workbench Roots');
    if (!session || !workbenchProject) return null;
    const roots = rootsQuery.data ?? [
        {
            projectId: workbenchProject.id,
            displayTitle: workbenchProject.displayTitle,
            branch: branch ?? 'No branch',
            owner: workbenchProject.id === session.projectId,
        },
    ];
    const current = roots.find((root) => root.projectId === session.workbenchProjectId) ?? roots[0];
    const switchRoot = async (projectId: string | null): Promise<void> => {
        if (!projectId || switching) return;
        setSwitching(true);
        try {
            if (projectId === AUTHORIZE_WORKBENCH_ROOT_VALUE) {
                const selected = await tryCommand('Unable to authorize Workbench Root', () =>
                    caxri.request('session.authorizeWorkbenchRoot', { sessionId }),
                );
                if (selected && !('canceled' in selected))
                    await useWorkbenchStore.getState().refresh();
                return;
            }
            if (projectId === session.workbenchProjectId) return;
            const selected = await tryCommand('Unable to switch Workbench Root', () =>
                caxri.request('session.selectWorkbenchRoot', { sessionId, projectId }),
            );
            if (selected) await useWorkbenchStore.getState().refresh();
        } finally {
            setSwitching(false);
        }
    };
    return (
        <Select
            value={session.workbenchProjectId}
            open={open}
            disabled={switching}
            onOpenChange={setOpen}
            onValueChange={(value) => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, switchRoot() reports its own errors via tryCommand
                void switchRoot(value);
            }}
        >
            <SelectTrigger
                showIcon={false}
                aria-label={`Switch Workbench Root from ${current.displayTitle}, branch ${current.branch}`}
                title={workbenchProject.rootPath}
                className={cn(
                    statusItemClassName,
                    'h-5 w-auto max-w-full justify-start px-[5px] text-[11px]',
                )}
            >
                <FolderGit2 size={13} />
                {/**
                 * The trigger shows only the root's title: the adjacent BranchPicker already renders the same branch, so repeating it
                 * here made the status bar read "title · branch · branch". The dropdown items keep "title · branch" because the branch
                 * is what tells parallel worktree roots apart.
                 */}
                <SelectValue>{current.displayTitle}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-96 min-w-56">
                {roots.map((root) => (
                    <SelectItem key={root.projectId} value={root.projectId} className="max-w-96">
                        {root.displayTitle} · {root.branch}
                    </SelectItem>
                ))}
                <Separator className="my-1" />
                <SelectItem value={AUTHORIZE_WORKBENCH_ROOT_VALUE} className="max-w-96">
                    Authorize another worktree…
                </SelectItem>
                {rootsQuery.isLoading && (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted">
                        <LoaderCircle className="animate-spin" size={12} />
                        Loading Workbench Roots…
                    </div>
                )}
            </SelectContent>
        </Select>
    );
}

function showSecondarySidebar(command: Extract<CommandId, `secondarySidebar.show${string}`>): void {
    executeCommand(command);
}

export function StatusBar() {
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const sessionId = session?.id;
    const overview = useProjectOverview(sessionId);
    const repo = overview?.repository;
    const serverStatus = useWorkbenchStore((state) => state.bootstrap?.runtime.status);
    const degraded = serverStatus ? DEGRADED_STATES[serverStatus] : undefined;
    const activeResource = useActivePaneTab()?.resource;
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
                    <StatusItem
                        icon={FileDiff}
                        ariaLabel={`Open changes: ${repo.additions} ${repo.additions === 1 ? 'addition' : 'additions'}, ${repo.deletions} ${repo.deletions === 1 ? 'deletion' : 'deletions'}`}
                        title="Show primary repository changes"
                        onClick={() => showSecondarySidebar('secondarySidebar.showGit')}
                    >
                        +{repo.additions} -{repo.deletions}
                    </StatusItem>
                )}
            </div>
            {/*
             * `min-w-0` lets this side actually shrink instead of pushing width past the window
             * edge — `<body>` has `overflow-x: hidden`, so a `flex-none` sibling here used to be
             * silently clipped below ~752px viewport width with no way to reach it. The chip-
             * priority resolution above (`chip-priority.ts`) now hides the lowest-value chips first
             * as the footer narrows, so information stays reachable without a scrollbar for every
             * ordinary window width; `overflow-x-auto` stays only as the last-resort fallback for
             * the pathological case where even the never-hide chips (degraded/runtime state,
             * active Agent operation) don't fit.
             */}
            <div className="statusbar-actions flex min-w-0 shrink items-center gap-2 overflow-x-auto">
                {degraded && (
                    <Tooltip content={degraded.detail}>
                        <span className={cn(statusStateClassName, degraded.className)}>
                            {degraded.label}
                        </span>
                    </Tooltip>
                )}
                <ScreencastModeChip />
                {sessionId &&
                    activeResource?.kind === 'file' &&
                    !isExternalEditorTabPath(activeResource.path) &&
                    !parseGitDiffTab(activeResource.path) && (
                        <ActiveFileStatus
                            sessionId={sessionId}
                            path={activeResource.path}
                            workbenchProjectId={session.workbenchProjectId}
                        />
                    )}
                {activeResource?.kind === 'terminal' && (
                    <ActiveTerminalStatus
                        showChildProcessCount={chipVisibility.childProcessCount}
                        showMemory={chipVisibility.memory}
                        terminalId={activeResource.terminalId}
                    />
                )}
            </div>
        </footer>
    );
}
