import type {
    CancellationToken,
    ExtensionContext,
    ProjectStatusRepository,
    ProjectStatusState,
    TreeDataProvider,
} from 'caxri';
import caxri, { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'caxri';

interface StatusNode {
    item: TreeItem;
    children?: readonly StatusNode[];
}

const stateIcons: Record<ProjectStatusState, string> = {
    success: 'check',
    failure: 'error',
    pending: 'loading',
    neutral: 'circle-outline',
    unknown: 'question',
};

function item(
    label: string,
    options: {
        command?: { command: string; title: string };
        description?: string;
        icon?: string;
        url?: string;
        children?: readonly StatusNode[];
    } = {},
): StatusNode {
    const treeItem = new TreeItem(
        label,
        options.children?.length
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
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

function repoChildren(repo: ProjectStatusRepository): StatusNode[] {
    const children: StatusNode[] = [
        item(repo.branch, {
            description: 'Branch',
            icon: 'git-branch',
            url: repo.branchUrl,
        }),
    ];
    const pullRequest = repo.pullRequest;
    if (pullRequest) {
        children.push(
            item(`#${pullRequest.number} ${pullRequest.title}`, {
                description: pullRequest.state,
                icon: stateIcons[pullRequest.state],
                url: pullRequest.url,
                children: pullRequest.checks.map((check) =>
                    item(check.name, {
                        description: check.state,
                        icon: stateIcons[check.state],
                        url: check.url,
                    }),
                ),
            }),
        );
    }
    if (repo.linearIssues.length > 0) {
        children.push(
            item('Linear', {
                icon: 'issues',
                children: repo.linearIssues.map((issue) =>
                    item(issue.title ? `${issue.identifier} ${issue.title}` : issue.identifier, {
                        description: issue.state,
                        icon: issue.stateType === 'completed' ? 'pass' : 'issues',
                        url: issue.url,
                    }),
                ),
            }),
        );
    }
    if (repo.deployments) {
        const deployments = [
            ...repo.deployments.branchDeployments,
            ...(repo.deployments.production ? [repo.deployments.production] : []),
            ...(repo.deployments.preview ? [repo.deployments.preview] : []),
        ];
        const unique = new Map(deployments.map((value) => [value.url, value])).values().toArray();
        children.push(
            item('Deployments', {
                icon: 'cloud',
                children: unique.map((deployment) =>
                    item(deployment.hostname, {
                        description: `${deployment.environment} · ${deployment.state}`,
                        icon: stateIcons[deployment.state],
                        url: deployment.url,
                    }),
                ),
            }),
        );
    }
    children.push(
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
    return children;
}

class ProjectStatusProvider implements TreeDataProvider<StatusNode> {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<StatusNode | readonly StatusNode[] | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    async getChildren(
        element: StatusNode | undefined,
        token: CancellationToken,
    ): Promise<readonly StatusNode[]> {
        if (element) return element.children ?? [];
        const summary = await caxri.workspace.getProjectStatus();
        if (token.isCancellationRequested) return [];
        if (summary.error) return [item(summary.error, { icon: 'error' })];
        return summary.repositories.map((repo) =>
            item(repo.name, {
                description: repo.branch,
                icon: 'repo',
                children: repoChildren(repo),
            }),
        );
    }

    getTreeItem(element: StatusNode): TreeItem {
        return element.item;
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    dispose(): void {
        this.changed.dispose();
    }
}

export function activate(context: ExtensionContext): void {
    const provider = new ProjectStatusProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerTreeDataProvider('caxri.project-status.overview', provider),
        caxri.commands.registerCommand('caxri.project-status.refresh', () => provider.refresh()),
        caxri.workspace.onDidChangeActiveContext(() => provider.refresh()),
    );
}
