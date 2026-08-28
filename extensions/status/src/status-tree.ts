import type {
    Command,
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusState,
    ProjectStatusSummary,
    TreeItemVariant,
} from 'caxri';
import {
    ProjectStatusSummaryErrorMessage,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
} from 'caxri';

export interface StatusNode {
    item: TreeItem;
    children?: readonly StatusNode[];
}

const stateIcons: Record<ProjectStatusState, string> = {
    success: 'circle-check',
    failure: 'circle-x',
    pending: 'loading',
    neutral: 'circle-outline',
    unknown: 'circle-dot',
};

const stateTones: Record<ProjectStatusState, 'danger' | 'neutral' | 'success' | 'warning'> = {
    success: 'success',
    failure: 'danger',
    pending: 'warning',
    neutral: 'neutral',
    unknown: 'neutral',
};

const repoPresentation: Record<
    ProjectStatusRepository['kind'],
    { description?: string; icon: string }
> = {
    primary: { icon: 'monitor' },
    worktree: { description: 'worktree', icon: 'monitor' },
    nested: { description: 'nested', icon: 'monitor' },
    submodule: { description: 'submodule', icon: 'package' },
};

const missingGitRepoErrors = new Set<string>([
    ProjectStatusSummaryErrorMessage.missingGitRepository,
    ProjectStatusSummaryErrorMessage.missingPrimaryRepository,
]);

function durationLabel(durationMs: number | undefined): string | undefined {
    if (durationMs === undefined) return undefined;
    const seconds = Math.round(durationMs / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function item(
    id: string,
    label: string,
    options: {
        children?: readonly StatusNode[];
        collapsibleState?: TreeItemCollapsibleState;
        command?: Command;
        description?: string;
        icon?: string;
        tooltip?: TreeItem['tooltip'];
        url?: string;
        variant?: TreeItemVariant;
    } = {},
): StatusNode {
    const treeItem = new TreeItem(
        label,
        options.collapsibleState ??
            (options.children?.length
                ? TreeItemCollapsibleState.Collapsed
                : TreeItemCollapsibleState.None),
    );
    treeItem.id = id;
    treeItem.variant = options.variant;
    treeItem.description = options.description;
    treeItem.tooltip =
        options.tooltip ?? [label, options.description, options.url].filter(Boolean).join('\n');
    treeItem.accessibilityInformation = {
        label: [label, options.description].filter(Boolean).join(', '),
    };
    if (options.icon) treeItem.iconPath = new ThemeIcon(options.icon);
    if (options.url) {
        treeItem.command = {
            command: 'caxri.openExternal',
            title: `Open ${label}`,
            arguments: [options.url],
        };
    }
    if (options.command) treeItem.command = options.command;
    return { item: treeItem, children: options.children };
}

function deploymentTooltip(
    title: string,
    deployment: ProjectStatusDeployment,
): NonNullable<TreeItem['tooltip']> {
    return {
        kind: 'rich',
        title,
        badge: { label: deployment.state, tone: stateTones[deployment.state] },
        rows: [
            { label: 'alias', value: deployment.hostname, url: deployment.url },
            ...(deployment.state === 'success' && deployment.inspectorUrl
                ? [{ label: 'inspect', value: 'logs', url: deployment.inspectorUrl }]
                : []),
            ...(deployment.createdAt === undefined
                ? []
                : [
                      {
                          label: 'created',
                          value: new Date(deployment.createdAt).toLocaleString(),
                      },
                  ]),
        ],
    };
}

function linearState(
    stateType: ProjectStatusRepository['linearIssues'][number]['stateType'],
): ProjectStatusState {
    if (stateType === 'completed') return 'success';
    if (stateType === 'canceled' || stateType === 'duplicate') return 'neutral';
    if (stateType === 'started') return 'pending';
    return 'unknown';
}

/**
 * Preserves the screenshot-defined pre-extension ordering while assigning stable provider IDs to every row.
 */
function buildRepoChildren(repo: ProjectStatusRepository): StatusNode[] {
    const prefix = `status:repo:${repo.id}`;
    const nodes: StatusNode[] = [
        item(`${prefix}:branch`, repo.branch, {
            description: repo.defaultBranch === repo.branch ? 'default' : undefined,
            icon: 'git-branch',
            url: repo.branchUrl,
        }),
    ];
    for (const issue of repo.linearIssues) {
        const state = linearState(issue.stateType);
        nodes.push(
            item(
                `${prefix}:linear:${issue.identifier}`,
                issue.title ? `${issue.identifier} ${issue.title}` : issue.identifier,
                {
                    description: issue.state,
                    icon: stateIcons[state],
                    url: issue.url,
                },
            ),
        );
    }
    if (repo.deployments) {
        const { branchDeployments } = repo.deployments;
        const environments = [...new Set(branchDeployments.map(({ environment }) => environment))];
        nodes.push(
            item(`${prefix}:deployments`, 'Deployments', {
                description:
                    environments.length === 1
                        ? `${branchDeployments.length} on ${environments[0]}`
                        : `${branchDeployments.length} on ${repo.branch}`,
                icon: 'rocket',
                children: branchDeployments.map((deployment, index) =>
                    item(`${prefix}:branch-deployment:${index}`, deployment.hostname, {
                        description: `${deployment.environment} · ${deployment.state}`,
                        icon: stateIcons[deployment.state],
                        tooltip: deploymentTooltip(deployment.environment, deployment),
                        url: deployment.url,
                    }),
                ),
            }),
        );
        for (const [label, deployment] of [
            ['Production', repo.deployments.production],
            ['Preview', repo.deployments.preview],
        ] as const) {
            if (!deployment) continue;
            nodes.push(
                item(`${prefix}:${deployment.environment}`, label, {
                    description: `${deployment.state} · ${deployment.hostname}`,
                    icon: stateIcons[deployment.state],
                    tooltip: deploymentTooltip(label, deployment),
                    url: deployment.url,
                }),
            );
        }
    }
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        const children = pullRequest.checks.map((check, index) =>
            item(`${prefix}:check:${index}`, check.name, {
                description: durationLabel(check.durationMs),
                icon: stateIcons[check.state],
                url: check.url,
            }),
        );
        if (pullRequest.hiddenCheckCount > 0) {
            children.push(
                item(
                    `${prefix}:hidden-checks`,
                    `${pullRequest.hiddenCheckCount} ignored check${pullRequest.hiddenCheckCount === 1 ? '' : 's'} hidden`,
                    { icon: 'eye-off' },
                ),
            );
        }
        nodes.push(
            item(`${prefix}:pr`, `#${pullRequest.number} ${pullRequest.title}`, {
                icon: stateIcons[pullRequest.state],
                url: pullRequest.url,
                children,
                collapsibleState:
                    pullRequest.state === 'failure'
                        ? TreeItemCollapsibleState.Expanded
                        : TreeItemCollapsibleState.Collapsed,
            }),
        );
    }
    for (const error of repo.errors) {
        nodes.push(
            item(`${prefix}:error:${error.source}`, error.message, {
                description: error.hint,
                icon: 'circle-x',
                ...(error.detailsView === 'logs' && {
                    command: { command: 'caxri.showLogs', title: 'Show Logs' },
                }),
            }),
        );
    }
    return nodes;
}

export function buildRepoNode(repo: ProjectStatusRepository): StatusNode {
    const presentation = repoPresentation[repo.kind];
    return item(`status:repo:${repo.id}`, repo.name, {
        description: presentation.description,
        icon: presentation.icon,
        children: buildRepoChildren(repo),
        collapsibleState: TreeItemCollapsibleState.Expanded,
        variant: 'header',
    });
}

export function buildStatusRootNodes(summary: ProjectStatusSummary): StatusNode[] {
    if (summary.error) {
        const isMissingGitRepo = missingGitRepoErrors.has(summary.error);
        return [
            item(
                'status:summary:error',
                isMissingGitRepo ? 'No Git repository' : 'Project Status unavailable',
                {
                    variant: 'message',
                    description: isMissingGitRepo
                        ? 'Initialize a Git repository in the Project root, then refresh.'
                        : summary.error,
                    icon: isMissingGitRepo ? 'git-branch' : 'circle-x',
                    command: {
                        command: 'caxri.project-status.refresh',
                        title: isMissingGitRepo ? 'Refresh' : 'Retry',
                    },
                },
            ),
        ];
    }
    if (summary.repositories.length === 0)
        return [
            item('status:empty', 'No repositories found', {
                variant: 'message',
                description: 'Add a Git repository to this Project, then refresh.',
                icon: 'git-branch',
                command: {
                    command: 'caxri.project-status.refresh',
                    title: 'Refresh',
                },
            }),
        ];
    return summary.repositories.map(buildRepoNode);
}
