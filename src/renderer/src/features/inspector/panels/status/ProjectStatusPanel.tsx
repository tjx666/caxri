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
import { useState } from 'react';

import type { ProjectStatusRepository, ProjectStatusState } from '@shared/types';

import { Button } from '../../../../components/ui/button';
import { cn } from '../../../../lib/utils';
import { useCaxriQuery, useToastOnQueryError } from '../../../../state/queries';
import { useSelectedSession } from '../../../../state/selectors';
import { buildProjectStatusNodes, type ProjectStatusTreeNode } from './project-status-tree';

/** No live push exists for delivery metadata, so a stale read is refreshed on a fixed interval. */
const PROJECT_STATUS_REFETCH_INTERVAL_MS = 60_000;

const rowClassName =
    'project-status-row flex w-full min-w-0 items-center gap-1.5 h-7 pr-2 border-0 bg-surface text-foreground text-left no-underline hover:bg-elevated';

function StateIcon({ state }: { state?: ProjectStatusState }) {
    if (state === 'success')
        return <CircleCheck className="state-success text-success" size={14} />;
    if (state === 'failure') return <CircleX className="state-failure text-danger" size={14} />;
    if (state === 'pending')
        return <LoaderCircle className="state-pending animate-spin text-warning" size={14} />;
    if (state === 'neutral') return <Circle className="state-neutral text-muted" size={14} />;
    return <CircleDot className="state-unknown text-muted" size={14} />;
}

function NodeIcon({ node }: { node: ProjectStatusTreeNode }) {
    if (node.state) return <StateIcon state={node.state} />;
    if (node.kind === 'branch') return <GitBranch size={14} />;
    if (node.kind === 'deployments') return <ListTree size={14} />;
    if (node.kind === 'deployment') return <Rocket size={14} />;
    if (node.kind === 'pullRequest') return <GitPullRequest size={14} />;
    if (node.kind === 'hidden') return <EyeOff size={14} />;
    if (node.kind === 'error')
        return <AlertTriangle className="state-failure text-danger" size={14} />;
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
                <span className="project-status-indent w-[13px] flex-none" />
            )}
            <NodeIcon node={node} />
            <span className="project-status-label min-w-0 flex-1 truncate">{node.label}</span>
            {node.description && (
                <small className="project-status-description flex-[0_1_auto] truncate text-muted text-[11px]">
                    {node.description}
                </small>
            )}
        </>
    );
    const style = { paddingLeft: 8 + depth * 16 };
    return (
        <>
            {expandable ? (
                <div
                    className="project-status-expandable-row flex min-w-0 items-center bg-surface"
                    style={style}
                >
                    <button
                        className={cn(rowClassName, 'min-w-0 flex-1 pl-0 cursor-pointer')}
                        aria-expanded={expanded}
                        title={node.label}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {content}
                    </button>
                    {node.url && (
                        <a
                            className="project-status-external grid w-[26px] h-7 place-items-center text-muted hover:text-foreground"
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
                    className={rowClassName}
                    style={style}
                    href={node.url}
                    target="_blank"
                    rel="noreferrer"
                    title={node.description ?? node.label}
                >
                    {content}
                </a>
            ) : (
                <div className={rowClassName} style={style} title={node.description}>
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
        <section className="project-status-repository border-b border-border">
            <button
                className="project-status-repository-row flex w-full min-w-0 items-center gap-1.5 h-[34px] px-2 border-0 bg-surface text-foreground text-left cursor-pointer hover:bg-elevated"
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Icon size={15} />
                <strong className="truncate font-semibold">{repository.name}</strong>
                {repository.kind === 'submodule' && (
                    <small className="truncate text-muted text-[11px]">submodule</small>
                )}
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
    const {
        data: summary,
        isError,
        error,
        isFetching,
        refetch,
    } = useCaxriQuery(
        'projectStatus.summary',
        { sessionId: sessionId ?? '' },
        {
            enabled: Boolean(sessionId),
            refetchInterval: PROJECT_STATUS_REFETCH_INTERVAL_MS,
        },
    );
    useToastOnQueryError(isError, error, 'Project Status refresh failed');
    const refresh = (): void => void refetch();
    const refreshing = isFetching;

    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to inspect status.
            </div>
        );
    return (
        <div className="inspector-content project-status-panel flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="project-status-heading flex min-h-[38px] items-center justify-between pt-1 pr-1.5 pb-1 pl-2.5 border-b border-border uppercase">
                <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.04em]">
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
                    <RefreshCw className={refreshing ? 'animate-spin' : undefined} size={14} />
                </Button>
            </div>
            {!summary && (
                <div className="empty-panel py-4 px-3 text-muted text-center">
                    Loading Project Status…
                </div>
            )}
            {summary?.error && (
                <div className="empty-panel py-4 px-3 text-muted text-center">{summary.error}</div>
            )}
            {summary && !summary.error && summary.repositories.length === 0 && (
                <div className="empty-panel py-4 px-3 text-muted text-center">
                    No repositories found.
                </div>
            )}
            {summary && summary.repositories.length > 0 && (
                <div
                    className="project-status-repositories min-h-0 flex-1 overflow-auto"
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
