import { useState } from 'react';

import type { ProjectStatusRepository, ProjectStatusState } from '@shared/types';
import {
    Activity,
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    Circle,
    CircleCheck,
    CircleDot,
    CircleX,
    ExternalLink,
    EyeOff,
    GitBranch,
    GitPullRequest,
    LoaderCircle,
    Monitor,
    Package,
    RefreshCw,
    Rocket,
} from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession } from '../../../../stores/selectors';
import type { ProjectStatusTreeNode } from './project-status-tree';
import { buildProjectStatusNodes } from './project-status-tree';

/**
No live push exists for delivery metadata, so a stale read is refreshed on a fixed interval.
 */
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
    if (node.kind === 'deployments') return <Rocket size={14} />;
    if (node.kind === 'deployment') return <Rocket size={14} />;
    if (node.kind === 'pullRequest') return <GitPullRequest size={14} />;
    if (node.kind === 'hidden') return <EyeOff size={14} />;
    if (node.kind === 'error')
        return <AlertTriangle className="state-failure text-danger" size={14} />;
    return <CircleDot size={14} />;
}

function StatusTreeNode({ depth, node }: { depth: number; node: ProjectStatusTreeNode }) {
    const isExpandable = node.kind === 'deployments' || node.kind === 'pullRequest';
    const [expanded, setExpanded] = useState(
        node.kind === 'pullRequest' && node.state === 'failure',
    );
    const content = (
        <>
            {isExpandable ? (
                expanded ? (
                    <ChevronDown size={13} />
                ) : (
                    <ChevronRight size={13} />
                )
            ) : (
                <span className="project-status-indent w-[13px] flex-none" />
            )}
            <NodeIcon node={node} />
            {/*
             * When the row overflows, the description (hostname, count) must give way before the
             * label ("Production", check names): flex shrink is weighted by `factor x basis`, so
             * the description's astronomic shrink factor keeps the label's share of any deficit
             * below Chromium's 1/64px layout precision — a mere `shrink-[999]` still leaked
             * ~0.02px of shrink onto the label, enough for `truncate` to render a spurious
             * ellipsis on a label that "fits". Once the description bottoms out at 0 the label
             * absorbs the rest and truncates for real. The label needs `grow` with an `auto`
             * basis (NOT `flex-1`, whose 0 basis collapsed it to "Pro...").
             */}
            <span className="project-status-label min-w-0 grow basis-auto truncate">
                {node.label}
            </span>
            {node.description && (
                <small className="project-status-description ml-auto min-w-0 flex-[0_999999_auto] truncate text-muted text-[11px]">
                    {node.description}
                </small>
            )}
        </>
    );
    const style = { paddingLeft: 8 + depth * 16 };
    return (
        <>
            {isExpandable ? (
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
            {isExpandable && (
                <DisclosureMotion animate expanded={expanded} kind="status-node">
                    {() =>
                        node.children.map((child) => (
                            <StatusTreeNode key={child.id} depth={depth + 1} node={child} />
                        ))
                    }
                </DisclosureMotion>
            )}
        </>
    );
}

function RepoSection({ repository }: { repository: ProjectStatusRepository }) {
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
            <DisclosureMotion animate expanded={expanded} kind="status-repository">
                {() => (
                    <div className="project-status-nodes">
                        {buildProjectStatusNodes(repository).map((node) => (
                            <StatusTreeNode key={node.id} depth={0} node={node} />
                        ))}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}

/**
Loads delivery metadata only while the Status tab is mounted, keeping startup CLI-free.
 */
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

    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to inspect status.
            </div>
        );
    const isRefreshing = isFetching;
    const refresh = (): void => {
        // Fire-and-forget: `useCaxriQuery`/`useToastOnQueryError` already own reporting a failed
        // refetch, so this manual refresh trigger has nothing further to await.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void refetch();
    };
    return (
        <div className="inspector-content project-status-panel flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="project-status-heading flex min-h-[38px] items-center justify-between pt-1 pr-1.5 pb-1 pl-2.5 border-b border-border uppercase">
                <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.04em]">
                    <Activity size={14} /> Project Status
                </span>
                <Tooltip content="Refresh Project Status">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Refresh Project Status"
                        disabled={isRefreshing}
                        onClick={refresh}
                    >
                        <RefreshCw
                            className={isRefreshing ? 'animate-spin' : undefined}
                            size={14}
                        />
                    </Button>
                </Tooltip>
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
                    {summary.repositories.map((repo) => (
                        <RepoSection key={repo.id} repository={repo} />
                    ))}
                </div>
            )}
        </div>
    );
}
