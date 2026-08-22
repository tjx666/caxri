import type { ProjectStatusRepository, ProjectStatusState } from 'caxri';
import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'caxri';

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

function durationLabel(durationMs: number | undefined): string | undefined {
    if (durationMs === undefined) return undefined;
    const seconds = Math.round(durationMs / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function item(
    label: string,
    options: {
        children?: readonly StatusNode[];
        collapsibleState?: TreeItemCollapsibleState;
        command?: { command: string; title: string };
        description?: string;
        icon?: string;
        url?: string;
    } = {},
): StatusNode {
    const treeItem = new TreeItem(
        label,
        options.collapsibleState ??
            (options.children?.length
                ? TreeItemCollapsibleState.Collapsed
                : TreeItemCollapsibleState.None),
    );
    treeItem.description = options.description;
    treeItem.tooltip = options.url;
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

/**
 * Preserves the hierarchy and terse descriptions from the pre-extension Status surface.
 */
export function buildRepoChildren(repo: ProjectStatusRepository): StatusNode[] {
    const nodes: StatusNode[] = [
        item(repo.branch, {
            description: repo.defaultBranch === repo.branch ? 'default' : undefined,
            icon: 'git-branch',
            url: repo.branchUrl,
        }),
    ];
    for (const issue of repo.linearIssues) {
        const state: ProjectStatusState =
            issue.stateType === 'completed'
                ? 'success'
                : issue.stateType === 'canceled' || issue.stateType === 'duplicate'
                  ? 'neutral'
                  : issue.stateType === 'started'
                    ? 'pending'
                    : 'unknown';
        nodes.push(
            item(issue.title ? `${issue.identifier} ${issue.title}` : issue.identifier, {
                description: issue.state,
                icon: stateIcons[state],
                url: issue.url,
            }),
        );
    }
    if (repo.deployments) {
        const { branchDeployments } = repo.deployments;
        const environments = [...new Set(branchDeployments.map(({ environment }) => environment))];
        nodes.push(
            item('Deployments', {
                description:
                    environments.length === 1
                        ? `${branchDeployments.length} on ${environments[0]}`
                        : `${branchDeployments.length} on ${repo.branch}`,
                icon: 'rocket',
                children: branchDeployments.map((deployment) =>
                    item(deployment.hostname, {
                        description: environments.length === 1 ? undefined : deployment.environment,
                        icon: stateIcons[deployment.state],
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
                item(label, {
                    description: deployment.hostname,
                    icon: stateIcons[deployment.state],
                    url: deployment.url,
                }),
            );
        }
    }
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        const children = pullRequest.checks.map((check) =>
            item(check.name, {
                description: durationLabel(check.durationMs),
                icon: stateIcons[check.state],
                url: check.url,
            }),
        );
        if (pullRequest.hiddenCheckCount > 0) {
            children.push(
                item(
                    `${pullRequest.hiddenCheckCount} ignored check${pullRequest.hiddenCheckCount === 1 ? '' : 's'} hidden`,
                    { icon: 'eye-off' },
                ),
            );
        }
        nodes.push(
            item(`#${pullRequest.number} ${pullRequest.title}`, {
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
    nodes.push(
        ...repo.errors.map((error) =>
            item(error.message, {
                description: error.hint,
                icon: 'warning',
                ...(error.detailsView === 'logs' && {
                    command: { command: 'caxri.showLogs', title: 'Show Logs' },
                }),
            }),
        ),
    );
    return nodes;
}

export function buildRepoNode(repo: ProjectStatusRepository): StatusNode {
    return item(repo.name, {
        description: repo.kind === 'submodule' ? 'submodule' : undefined,
        icon: repo.kind === 'submodule' ? 'package' : 'monitor',
        children: buildRepoChildren(repo),
        collapsibleState: TreeItemCollapsibleState.Expanded,
    });
}
