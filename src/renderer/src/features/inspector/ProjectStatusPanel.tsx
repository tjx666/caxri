import {
    Activity,
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    Circle,
    CircleCheck,
    CircleDot,
    CircleX,
    EyeOff,
    ExternalLink,
    GitBranch,
    GitPullRequest,
    ListTree,
    LoaderCircle,
    Monitor,
    Package,
    RefreshCw,
    Rocket,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type {
    ProjectStatusRepository,
    ProjectStatusState,
    ProjectStatusSummary,
} from '@shared/types';

import { Button } from '../../components/ui/button';
import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../state/selectors';
import { describeFailure, pushToast } from '../../state/toasts';
import { buildProjectStatusNodes, type ProjectStatusTreeNode } from './project-status-tree';

function StateIcon({ state }: { state?: ProjectStatusState }) {
    if (state === 'success') return <CircleCheck className="state-success" size={14} />;
    if (state === 'failure') return <CircleX className="state-failure" size={14} />;
    if (state === 'pending') return <LoaderCircle className="state-pending spinning" size={14} />;
    if (state === 'neutral') return <Circle className="state-neutral" size={14} />;
    return <CircleDot className="state-unknown" size={14} />;
}

function NodeIcon({ node }: { node: ProjectStatusTreeNode }) {
    if (node.state) return <StateIcon state={node.state} />;
    if (node.kind === 'branch') return <GitBranch size={14} />;
    if (node.kind === 'deployments') return <ListTree size={14} />;
    if (node.kind === 'deployment') return <Rocket size={14} />;
    if (node.kind === 'pullRequest') return <GitPullRequest size={14} />;
    if (node.kind === 'hidden') return <EyeOff size={14} />;
    if (node.kind === 'error') return <AlertTriangle className="state-failure" size={14} />;
    return <CircleDot size={14} />;
}

function StatusTreeNode({ depth, node }: { depth: number; node: ProjectStatusTreeNode }) {
    const expandable = node.kind === 'deployments' || node.kind === 'pullRequest';
    const [expanded, setExpanded] = useState(
        node.kind === 'pullRequest' && node.state === 'failure',
    );
    const content = (
        <>
            {expandable ? (
                expanded ? (
                    <ChevronDown size={13} />
                ) : (
                    <ChevronRight size={13} />
                )
            ) : (
                <span className="project-status-indent" />
            )}
            <NodeIcon node={node} />
            <span className="project-status-label">{node.label}</span>
            {node.description && (
                <small className="project-status-description">{node.description}</small>
            )}
        </>
    );
    const style = { paddingLeft: 8 + depth * 16 };
    return (
        <>
            {expandable ? (
                <div className="project-status-expandable-row" style={style}>
                    <button
                        className="project-status-row"
                        aria-expanded={expanded}
                        title={node.label}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {content}
                    </button>
                    {node.url && (
                        <a
                            className="project-status-external"
                            href={node.url}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${node.label}`}
                            title={`Open ${node.label}`}
                        >
                            <ExternalLink size={13} />
                        </a>
                    )}
                </div>
            ) : node.url ? (
                <a
                    className="project-status-row"
                    style={style}
                    href={node.url}
                    target="_blank"
                    rel="noreferrer"
                    title={node.description ?? node.label}
                >
                    {content}
                </a>
            ) : (
                <div className="project-status-row" style={style} title={node.description}>
                    {content}
                </div>
            )}
            {expandable &&
                expanded &&
                node.children.map((child) => (
                    <StatusTreeNode key={child.id} depth={depth + 1} node={child} />
                ))}
        </>
    );
}

function RepositorySection({ repository }: { repository: ProjectStatusRepository }) {
    const [expanded, setExpanded] = useState(true);
    const Icon = repository.kind === 'submodule' ? Package : Monitor;
    return (
        <section className="project-status-repository">
            <button
                className="project-status-repository-row"
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Icon size={15} />
                <strong>{repository.name}</strong>
                {repository.kind === 'submodule' && <small>submodule</small>}
            </button>
            {expanded && (
                <div className="project-status-nodes">
                    {buildProjectStatusNodes(repository).map((node) => (
                        <StatusTreeNode key={node.id} depth={0} node={node} />
                    ))}
                </div>
            )}
        </section>
    );
}

/** Loads delivery metadata only while the Status tab is mounted, keeping startup CLI-free. */
export function ProjectStatusPanel() {
    const session = useSelectedSession();
    const sessionId = session?.id;
    const [summary, setSummary] = useState<ProjectStatusSummary>();
    const [refreshing, setRefreshing] = useState(false);
    const refresh = useCallback((): void => {
        if (!sessionId) return;
        setRefreshing(true);
        void caxri
            .request('projectStatus.summary', { sessionId })
            .then(setSummary)
            .catch((error: unknown) =>
                pushToast('error', describeFailure(error, 'Project Status refresh failed')),
            )
            .finally(() => setRefreshing(false));
    }, [sessionId]);
    useEffect(() => {
        const initialRefresh = window.setTimeout(refresh, 0);
        const timer = window.setInterval(refresh, 60_000);
        return () => {
            window.clearTimeout(initialRefresh);
            window.clearInterval(timer);
        };
    }, [refresh]);

    if (!session) return <div className="empty-panel">Create a Session to inspect status.</div>;
    return (
        <div className="inspector-content project-status-panel">
            <div className="project-status-heading">
                <span>
                    <Activity size={14} /> Project Status
                </span>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Refresh Project Status"
                    title="Refresh Project Status"
                    disabled={refreshing}
                    onClick={refresh}
                >
                    <RefreshCw className={refreshing ? 'spinning' : undefined} size={14} />
                </Button>
            </div>
            {!summary && <div className="empty-panel">Loading Project Status…</div>}
            {summary?.error && <div className="empty-panel">{summary.error}</div>}
            {summary && !summary.error && summary.repositories.length === 0 && (
                <div className="empty-panel">No repositories found.</div>
            )}
            {summary && summary.repositories.length > 0 && (
                <div
                    className="project-status-repositories"
                    aria-label="Project Status repositories"
                >
                    {summary.repositories.map((repository) => (
                        <RepositorySection key={repository.id} repository={repository} />
                    ))}
                </div>
            )}
        </div>
    );
}
