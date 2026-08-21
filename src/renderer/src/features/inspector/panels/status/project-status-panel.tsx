import type { MouseEvent } from 'react';
import { useState } from 'react';

import type { ProjectStatusRepository, ProjectStatusState } from '@shared/types';
import { keepPreviousData } from '@tanstack/react-query';
import {
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    Circle,
    CircleCheck,
    CircleDot,
    CircleX,
    EyeOff,
    GitBranch,
    GitPullRequest,
    Monitor,
    Package,
    RefreshCw,
    Rocket,
} from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { PanelHeader } from '../../../../components/panel-header';
import { Button } from '../../../../components/ui/button';
import { Spinner } from '../../../../components/ui/spinner';
import { Tooltip } from '../../../../components/ui/tooltip';
import { openExternalUrl } from '../../../../lib/external-link';
import { cn } from '../../../../lib/utilities';
import { useToastOnQueryError } from '../../../../queries/client';
import { useSelectedSession } from '../../../../stores/selectors';
import { pushToast } from '../../../../stores/toasts';
import type { ProjectStatusTreeNode } from './project-status-tree';
import { buildProjectStatusNodes } from './project-status-tree';

/**
 * Delivery metadata uses a fixed polling interval; the Runtime also pushes cache-refresh invalidations.
 */
const PROJECT_STATUS_REFETCH_INTERVAL_MS = 60_000;

const rowClassName =
    'project-status-row flex w-full min-w-0 items-center gap-1.5 h-7 pr-2 border-0 bg-surface text-foreground text-left no-underline hover:bg-elevated [&>svg]:flex-none';

function StateIcon({ state }: { state?: ProjectStatusState }) {
    if (state === 'success')
        return <CircleCheck className="state-success text-success" size={14} />;
    if (state === 'failure') return <CircleX className="state-failure text-danger" size={14} />;
    // Spinner bakes in `size-4` (16px); `size-3.5` (14px) here wins via the component's internal
    // cn/tailwind-merge so this icon matches its 14px siblings instead of rendering oversized.
    if (state === 'pending') return <Spinner className="state-pending size-3.5 text-warning" />;
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

/**
 * Main denies every `window.open`/target=_blank navigation, so `node.url` anchors stay semantic-only `<a href>`
 * elements and route the actual navigation through `external.open`.
 */
const openNodeUrl = (url: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
    void openExternalUrl(url, (message) => pushToast('error', message));
};

function StatusTreeNode({ depth, node }: { depth: number; node: ProjectStatusTreeNode }) {
    const isExpandable = node.kind === 'deployments' || node.kind === 'pullRequest';
    const [expanded, setExpanded] = useState(
        node.kind === 'pullRequest' && node.state === 'failure',
    );
    const chevron = expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />;
    const content = (
        <>
            {/*
             * Expandable rows with a `url` render the chevron in a dedicated sibling toggle button occupying this
             * slot, so their content contributes nothing here and the icon column stays aligned across all rows.
             */}
            {isExpandable ? (
                node.url ? undefined : (
                    chevron
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
                <small className="project-status-description ml-auto min-w-0 flex-[0_999999_auto] truncate text-[11px] text-muted">
                    {node.description}
                </small>
            )}
        </>
    );
    const style = { paddingLeft: 8 + depth * 16 };
    return (
        <>
            {isExpandable && node.url ? (
                <div
                    className="project-status-expandable-row flex min-w-0 items-center gap-1.5 bg-surface"
                    style={style}
                >
                    <button
                        className="project-status-toggle grid h-7 w-[13px] flex-none cursor-pointer place-items-center border-0 bg-surface text-muted hover:bg-elevated hover:text-foreground"
                        aria-expanded={expanded}
                        aria-label={`Toggle ${node.label} checks`}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {chevron}
                    </button>
                    <a
                        className={cn(rowClassName, 'min-w-0 flex-1 pl-0')}
                        href={node.url}
                        rel="noreferrer"
                        title={node.label}
                        onClick={openNodeUrl(node.url)}
                    >
                        {content}
                    </a>
                </div>
            ) : isExpandable ? (
                <button
                    className={cn(rowClassName, 'min-w-0 cursor-pointer')}
                    style={style}
                    aria-expanded={expanded}
                    title={node.label}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {content}
                </button>
            ) : node.url ? (
                <a
                    className={rowClassName}
                    style={style}
                    href={node.url}
                    rel="noreferrer"
                    title={node.description ?? node.label}
                    onClick={openNodeUrl(node.url)}
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
                className="project-status-repository-row flex h-[34px] w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-surface px-2 text-left text-foreground hover:bg-elevated"
                aria-expanded={expanded}
                title={repository.rootPath}
                onClick={() => setExpanded((value) => !value)}
            >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Icon size={15} />
                <strong className="truncate font-semibold">{repository.name}</strong>
                {repository.kind === 'submodule' && (
                    <small className="truncate text-[11px] text-muted">submodule</small>
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
 * Loads delivery metadata only while the Status tab is mounted, keeping startup CLI-free.
 */
export function ProjectStatusPanel() {
    const session = useSelectedSession();
    const sessionId = session?.id;
    const [refreshToken, setRefreshToken] = useState<string>();
    const {
        data: summary,
        isError,
        error,
        isFetching,
    } = usePolledQuery(
        'projectStatus.summary',
        { sessionId: sessionId ?? '', refreshToken },
        {
            label: 'projectStatus.summary',
            intervalMs: PROJECT_STATUS_REFETCH_INTERVAL_MS,
            enabled: Boolean(sessionId),
            placeholderData: keepPreviousData,
        },
    );
    useToastOnQueryError(isError, error, 'Project Status refresh failed');

    if (!session)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                Create a Session to inspect status.
            </div>
        );
    const isRefreshing = isFetching;
    const refresh = (): void => {
        setRefreshToken(crypto.randomUUID());
    };
    return (
        <div className="inspector-content project-status-panel flex min-h-0 flex-1 flex-col overflow-auto">
            <PanelHeader
                className="project-status-heading"
                title="Project Status"
                actions={
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
                }
            />
            {!summary && (
                <div className="empty-panel px-3 py-4 text-center text-muted">
                    Loading Project Status…
                </div>
            )}
            {summary?.error && (
                <div className="empty-panel px-3 py-4 text-center text-muted">{summary.error}</div>
            )}
            {summary && !summary.error && summary.repositories.length === 0 && (
                <div className="empty-panel px-3 py-4 text-center text-muted">
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
