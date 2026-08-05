import {
    FileDiff,
    GitBranch,
    GitPullRequest,
    Monitor,
    PanelRight,
    type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import type { BootstrapState, ProjectStatusOverview } from '@shared/types';

import { executeCommand } from '../../commands/execute';
import { caxri } from '../../lib/caxri';
import { usePanelLayoutStore } from '../../state/panel-layout';
import { useSelectedProject, useSelectedSession, useSessionTerminals } from '../../state/selectors';
import { useWorkbenchStore } from '../../state/workbench';

type RuntimeStatus = BootstrapState['runtime']['status'];

/**
 * A healthy backend says nothing: the status bar only speaks up while Caxri is degraded, and it
 * does so in the user's vocabulary rather than naming the Runtime process.
 */
const DEGRADED_STATES: Partial<Record<RuntimeStatus, { label: string; className: string }>> = {
    /** No imperative "Restart" here: recovery is offered by the native Relaunch dialog, not the chip. */
    failed: { label: 'Backend stopped', className: 'statusbar-state-danger' },
    restarting: { label: 'Reconnecting…', className: 'statusbar-state-warning' },
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
            className="statusbar-item"
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
            className="statusbar-item"
            aria-label={ariaLabel}
            title={title}
            onClick={onClick}
        >
            {content}
        </button>
    );
}

function useProjectOverview(sessionId: string | undefined): ProjectStatusOverview | undefined {
    const [snapshot, setSnapshot] = useState<{
        overview: ProjectStatusOverview;
        sessionId: string;
    }>();
    const refreshOverview = useCallback((): void => {
        if (!sessionId) return;
        void caxri
            .request('projectStatus.overview', { sessionId })
            .then((overview) => setSnapshot({ overview, sessionId }))
            .catch(() => undefined);
    }, [sessionId]);
    useEffect(() => {
        if (!sessionId) return;
        const initialRefresh = window.setTimeout(refreshOverview, 0);
        const interval = window.setInterval(refreshOverview, 60_000);
        return () => {
            window.clearTimeout(initialRefresh);
            window.clearInterval(interval);
        };
    }, [refreshOverview, sessionId]);
    useEffect(() => {
        if (!sessionId) return;
        let refreshTimer: number | undefined;
        let active = true;
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'files.changed' || event.payload.sessionId !== sessionId) return;
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                void caxri
                    .request('git.summary', { sessionId })
                    .then((summary) => {
                        if (!active) return;
                        const primary = summary.repositories.find(
                            (repository) => repository.kind === 'primary',
                        );
                        if (!primary) return;
                        setSnapshot((current) =>
                            current?.sessionId === sessionId && current.overview.repository
                                ? {
                                      ...current,
                                      overview: {
                                          ...current.overview,
                                          repository: {
                                              ...current.overview.repository,
                                              branch: primary.branch,
                                              changedFileCount: primary.files.length,
                                          },
                                      },
                                  }
                                : current,
                        );
                    })
                    .catch(() => undefined);
            }, 150);
        });
        return () => {
            active = false;
            unsubscribe();
            if (refreshTimer) window.clearTimeout(refreshTimer);
        };
    }, [sessionId]);
    return snapshot && snapshot.sessionId === sessionId ? snapshot.overview : undefined;
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
        <footer className="statusbar" data-runtime-status={runtimeStatus ?? 'starting'}>
            <div className="statusbar-context">
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
                    <span className="statusbar-empty">No Project selected</span>
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
            <div className="statusbar-actions">
                {degraded && (
                    <span className={`statusbar-state ${degraded.className}`}>
                        {degraded.label}
                    </span>
                )}
                <span className="statusbar-count">{runningCount} running</span>
                <button
                    type="button"
                    className="statusbar-toggle"
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
