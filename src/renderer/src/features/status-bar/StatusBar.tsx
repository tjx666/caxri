import {
    Braces,
    FileDiff,
    GitBranch,
    GitCommitHorizontal,
    GitPullRequest,
    MemoryStick,
    Monitor,
    Workflow,
    type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { parseGitDiffTab } from '@shared/git-diff';
import type { InspectorCommandId } from '@shared/inspector';
import type { CaxriMethod } from '@shared/ipc';
import type { BootstrapState } from '@shared/types';

import { executeCommand } from '../../commands/execute';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utils';
import { usePanelLayoutStore } from '../../stores/panel-layout';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { useSelectedProject, useSelectedSession } from '../../stores/selectors';
import { useActiveWork } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import { tryCommand } from '../../stores/toasts';
import {
    editorLanguageLabel,
    editorStatusKey,
    useEditorStatusStore,
} from '../editor/editor-status';

/** No live push exists for delivery metadata, so a stale read is refreshed on a fixed interval. */
const PROJECT_OVERVIEW_REFETCH_INTERVAL_MS = 60_000;

type RuntimeStatus = BootstrapState['runtime']['status'];

const statusItemClassName =
    'statusbar-item inline-flex h-5 min-w-0 items-center gap-[5px] overflow-hidden rounded-[3px] border-0 bg-transparent px-[5px] text-foreground no-underline cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--foreground)] [&>svg]:flex-none [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

const statusStateClassName = 'statusbar-state flex-none rounded px-2 text-[10px]';
const statusInfoClassName =
    'statusbar-info inline-flex h-5 min-w-0 flex-none items-center gap-[5px] overflow-hidden rounded-[3px] px-[5px] text-foreground [&>svg]:flex-none [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeTime(timestamp: number): string {
    const seconds = Math.round((timestamp - Date.now()) / 1_000);
    const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 31_536_000],
        ['month', 2_592_000],
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
    ];
    for (const [unit, size] of ranges) {
        if (Math.abs(seconds) >= size)
            return RELATIVE_TIME_FORMATTER.format(Math.round(seconds / size), unit);
    }
    return RELATIVE_TIME_FORMATTER.format(seconds, 'second');
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [delayMs, value]);
    return debounced;
}

function StatusInfo({
    ariaLabel,
    children,
    className,
    icon: Icon,
    title,
}: {
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    icon?: LucideIcon;
    title: string;
}) {
    return (
        <span className={cn(statusInfoClassName, className)} aria-label={ariaLabel} title={title}>
            {Icon && <Icon size={12} />}
            <span>{children}</span>
        </span>
    );
}

function ActiveFileStatus({ sessionId, path }: { sessionId: string; path: string }) {
    const key = editorStatusKey(sessionId, path);
    const editorStatus = useEditorStatusStore((state) => state.statuses[key]);
    const line = useDebouncedValue(editorStatus?.line ?? 1, 150);
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
                            : `Git blame: ${blame.author}, ${relativeTime(blame.authoredAt)}, ${blame.subject}`
                    }
                    className="statusbar-blame max-w-[420px]"
                    icon={GitCommitHorizontal}
                    title={
                        blame.uncommitted
                            ? `Uncommitted changes · line ${line}`
                            : `${blame.author} · ${new Date(blame.authoredAt).toLocaleString()}\n${blame.sha}\n${blame.subject}`
                    }
                >
                    {blame.uncommitted
                        ? 'Uncommitted changes'
                        : `${blame.author}, ${relativeTime(blame.authoredAt)} · ${blame.subject}`}
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

function ActiveTerminalStatus({ terminalId }: { terminalId: string }) {
    const usage = useCaxriQuery(
        'terminal.resources',
        { terminalId },
        { refetchInterval: 2_000, staleTime: 1_000, retry: false },
    ).data;
    if (!usage) return null;
    const childLabel = `${usage.childProcessCount} ${usage.childProcessCount === 1 ? 'child process' : 'child processes'}`;
    const openProcessExplorer = (): void => executeCommand('processExplorer.open');
    return (
        <>
            <StatusItem
                ariaLabel={`Open Process Explorer — Terminal memory: ${usage.memoryMb} MB`}
                icon={MemoryStick}
                title={`Open Process Explorer — Terminal memory: ${usage.memoryMb} MB`}
                onClick={openProcessExplorer}
            >
                {usage.memoryMb} MB
            </StatusItem>
            <StatusItem
                ariaLabel={`Open Process Explorer — Terminal: ${childLabel}`}
                icon={Workflow}
                title={`Open Process Explorer — Terminal: ${childLabel}`}
                onClick={openProcessExplorer}
            >
                {usage.childProcessCount}
            </StatusItem>
        </>
    );
}

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
 * in `queries/client.ts`). Branch and changed-file count instead come from the `git.summary` query —
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
            id: primary.id,
            branch: primary.branch,
            changedFileCount: primary.files.length,
            additions: primary.additions,
            deletions: primary.deletions,
        },
    };
}

const BRANCH_SWITCH_DEPENDENCIES = new Set<CaxriMethod>([
    'git.summary',
    'git.branches',
    'git.diff',
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
    const branchesQuery = useCaxriQuery(
        'git.branches',
        { sessionId, repositoryId },
        { enabled: open },
    );
    useToastOnQueryError(branchesQuery.isError, branchesQuery.error, 'Unable to list branches');
    const branches = branchesQuery.data ?? [branch];

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
                    const [method, params] = query.queryKey as [
                        CaxriMethod,
                        { sessionId?: string } | undefined,
                    ];
                    return (
                        BRANCH_SWITCH_DEPENDENCIES.has(method) && params?.sessionId === sessionId
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
            onValueChange={(value) => void switchBranch(value)}
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
            <SelectContent className="min-w-48 max-w-80">
                {branches.map((name) => (
                    <SelectItem key={name} value={name} className="max-w-80">
                        {name}
                    </SelectItem>
                ))}
                {branchesQuery.isLoading && (
                    <div className="px-2 py-1.5 text-[12px] text-muted">Loading branches…</div>
                )}
            </SelectContent>
        </Select>
    );
}

function showInspector(command: InspectorCommandId): void {
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
    const activeWork = useActiveWork();
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
                {repository && sessionId && (
                    <BranchPicker
                        branch={repository.branch}
                        repositoryId={repository.id}
                        sessionId={sessionId}
                    />
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
                        ariaLabel={`Open changes: ${repository.additions} ${repository.additions === 1 ? 'addition' : 'additions'}, ${repository.deletions} ${repository.deletions === 1 ? 'deletion' : 'deletions'}`}
                        title="Show primary repository changes"
                        onClick={() => showInspector('inspector.showGit')}
                    >
                        +{repository.additions} -{repository.deletions}
                    </StatusItem>
                )}
            </div>
            <div className="statusbar-actions flex flex-none items-center gap-2">
                {degraded && (
                    <span className={cn(statusStateClassName, degraded.className)}>
                        {degraded.label}
                    </span>
                )}
                {sessionId &&
                    activeWork?.kind === 'editor' &&
                    !parseGitDiffTab(activeWork.path) && (
                        <ActiveFileStatus sessionId={sessionId} path={activeWork.path} />
                    )}
                {activeWork?.kind === 'terminal' && (
                    <ActiveTerminalStatus terminalId={activeWork.terminalId} />
                )}
            </div>
        </footer>
    );
}
