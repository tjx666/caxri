import type {
    Command,
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusState,
    ProjectStatusSummary,
    TreeItemRichTooltip,
    TreeItemTooltipRow,
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
    cancelled: 'circle-slash',
    pending: 'loading',
    neutral: 'circle-outline',
    unknown: 'circle-dot',
};

/**
 * Vercel cancellation stays neutral for aggregation but must remain recognizable in deployment rows.
 */
const deploymentIcons: Record<ProjectStatusState, string> = {
    ...stateIcons,
    neutral: 'circle-slash',
};

function deploymentStateLabel(deployment: ProjectStatusDeployment): string {
    return deployment.state === 'neutral' ? 'canceled' : deployment.state;
}

const linearStateIcons: Partial<
    Record<NonNullable<ProjectStatusRepository['linearIssues'][number]['stateType']>, string>
> = {
    backlog: 'linear-backlog',
    canceled: 'linear-canceled',
    completed: 'linear-completed',
    duplicate: 'linear-canceled',
    started: 'linear-started',
    triage: 'linear-triage',
    unstarted: 'linear-unstarted',
};

const stateTones: Record<ProjectStatusState, 'danger' | 'neutral' | 'success' | 'warning'> = {
    success: 'success',
    failure: 'danger',
    cancelled: 'neutral',
    pending: 'warning',
    neutral: 'neutral',
    unknown: 'neutral',
};

const pullRequestPresentation = {
    open: { icon: 'git-pull-request-open', label: 'Open', tone: 'success' },
    draft: { icon: 'git-pull-request-draft', label: 'Draft', tone: 'neutral' },
    merged: { icon: 'git-merge', label: 'Merged', tone: 'neutral' },
    closed: { icon: 'git-pull-request-closed', label: 'Closed', tone: 'danger' },
} as const;

const checkLabels: Record<ProjectStatusState, string> = {
    success: 'CI passed',
    failure: 'CI failed',
    cancelled: 'CI cancelled',
    pending: 'CI pending',
    neutral: 'CI neutral',
    unknown: 'CI unknown',
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

/**
 * The parts a row contributes to its hover card. `title` defaults to the row label; the row's own `url` is appended as
 * the trailing `link` row by {@link richTooltip}.
 */
interface StatusTooltip {
    badge?: TreeItemRichTooltip['badge'];
    description?: string;
    rows?: readonly TreeItemTooltipRow[];
    title?: string;
}

/**
 * A tooltip row value is capped at 2048 characters by the process boundary, while a provider URL may be much longer.
 * Clamping well below that bound keeps one pathological deployment URL from rejecting the whole `getChildren` batch.
 */
const MAX_LINK_TEXT_LENGTH = 256;

/**
 * Drops the scheme so a link stays readable inside the bounded hover card at SecondarySidebar width. The row keeps the
 * untouched `url`, so a clamped display text still opens the full destination.
 */
function linkText(url: string): string {
    const text = url.replace(/^https?:\/\//, '');
    return text.length > MAX_LINK_TEXT_LENGTH
        ? `${text.slice(0, MAX_LINK_TEXT_LENGTH - 1)}…`
        : text;
}

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
        accessibilityLabel?: string;
        children?: readonly StatusNode[];
        collapsibleState?: TreeItemCollapsibleState;
        command?: Command;
        description?: string;
        icon?: string;
        trailingIcon?: string;
        tooltip?: StatusTooltip;
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
    treeItem.tooltip = richTooltip(label, options.tooltip, options.url);
    treeItem.accessibilityInformation = {
        label:
            options.accessibilityLabel ?? [label, options.description].filter(Boolean).join(', '),
    };
    if (options.icon) treeItem.iconPath = new ThemeIcon(options.icon);
    if (options.trailingIcon) treeItem.trailingIcon = new ThemeIcon(options.trailingIcon);
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
 * Every Status row wears the same hover card, so the panel never mixes a rich card with a plain multi-line string. The
 * row's own destination becomes the trailing `link` row unless the caller already published that URL under a more
 * specific label, which keeps a deployment from repeating its alias.
 */
function richTooltip(
    label: string,
    tooltip: StatusTooltip | undefined,
    url: string | undefined,
): TreeItemRichTooltip {
    const rows = tooltip?.rows ?? [];
    return {
        kind: 'rich',
        title: tooltip?.title ?? label,
        ...(tooltip?.description && { description: tooltip.description }),
        ...(tooltip?.badge && { badge: tooltip.badge }),
        rows:
            url && rows.every((row) => row.url !== url)
                ? [...rows, { label: 'link', value: linkText(url), url }]
                : rows,
    };
}

function ignoredChecksLabel(count: number): string {
    return `${count} ignored check${count === 1 ? '' : 's'}`;
}

function deploymentTooltip(title: string, deployment: ProjectStatusDeployment): StatusTooltip {
    return {
        title,
        badge: { label: deploymentStateLabel(deployment), tone: stateTones[deployment.state] },
        rows: [
            { label: 'alias', value: deployment.hostname, url: deployment.url },
            ...(deployment.inspectorUrl
                ? [{ label: 'inspect', value: 'details', url: deployment.inspectorUrl }]
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

function linearIcon(
    stateType: ProjectStatusRepository['linearIssues'][number]['stateType'],
): string {
    const customIcon = stateType ? linearStateIcons[stateType] : undefined;
    return customIcon ?? stateIcons[linearState(stateType)];
}

/**
 * Preserves the screenshot-defined pre-extension ordering while assigning stable provider IDs to every row.
 */
function buildRepoChildren(repo: ProjectStatusRepository): StatusNode[] {
    const prefix = `status:repo:${repo.id}`;
    const isDefaultBranch = repo.defaultBranch === repo.branch;
    const publication = repo.publication;
    const publicationLabels = {
        'checking': 'Checking origin…',
        'unpublished': 'Not on origin',
        'published': 'On origin',
        'synced': 'Synced',
        'ahead': `↑${publication?.ahead ?? 0}`,
        'behind': `↓${publication?.behind ?? 0}`,
        'diverged': `↑${publication?.ahead ?? 0} ↓${publication?.behind ?? 0}`,
        'unknown': 'Unknown',
        'no-origin': 'No origin',
        'unsupported': 'Unknown',
        'detached': 'Detached HEAD',
        'unborn': 'No commits',
    };
    const publicationLabel = publication ? publicationLabels[publication.state] : undefined;
    const branchDescription = [isDefaultBranch ? 'default' : undefined, publicationLabel]
        .filter(Boolean)
        .join(' · ');
    const publicationDescriptions: Partial<
        Record<NonNullable<typeof publication>['state'], string>
    > = {
        'unpublished':
            'No same-named branch exists on origin. It may exist on another remote or under another name.',
        'published':
            'The branch exists on origin, but local history is insufficient to compare commits. This does not confirm that every local commit has been pushed.',
        'synced': 'Local and origin branch tips match at the checked time.',
        'ahead': 'Local commits not on the compared origin branch at the checked time.',
        'behind': 'Origin commits not on the local branch at the checked time.',
        'diverged': 'Both branches have commits absent from the other at the checked time.',
        'unknown': 'Could not verify the branch on origin. Refresh Project Status to retry.',
        'unsupported': 'Remote verification currently supports GitHub origins only.',
        'no-origin': 'This repository has no origin remote.',
        'detached': 'HEAD is not attached to a local branch.',
        'unborn': 'This branch has no commits yet.',
        'checking': 'Checking the same-named branch on origin.',
    };
    const nodes: StatusNode[] = [
        item(`${prefix}:branch`, repo.branch, {
            description: branchDescription.length > 0 ? branchDescription : undefined,
            icon: 'git-branch',
            url: repo.branchUrl,
            tooltip: {
                ...((publicationLabel !== undefined || isDefaultBranch) && {
                    badge: { label: publicationLabel ?? 'default', tone: 'neutral' },
                }),
                description: publication ? publicationDescriptions[publication.state] : undefined,
                rows: [
                    ...(publication?.remoteBranch
                        ? [{ label: 'compared branch', value: publication.remoteBranch }]
                        : []),
                    ...(publication?.checkedAt === undefined
                        ? []
                        : [
                              {
                                  label: 'checked',
                                  value: new Date(publication.checkedAt).toLocaleString(),
                              },
                          ]),
                    ...(isDefaultBranch && publication
                        ? [{ label: 'default', value: repo.branch }]
                        : []),
                    !isDefaultBranch && repo.defaultBranch
                        ? { label: 'default', value: repo.defaultBranch }
                        : undefined,
                ].filter((row): row is TreeItemTooltipRow => row !== undefined),
            },
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
                    icon: linearIcon(issue.stateType),
                    url: issue.url,
                    tooltip: {
                        ...(issue.state && {
                            badge: { label: issue.state, tone: stateTones[state] },
                        }),
                    },
                },
            ),
        );
    }
    if (repo.deployments) {
        const { branchDeployments, url: deploymentsUrl } = repo.deployments;
        const environments = [...new Set(branchDeployments.map(({ environment }) => environment))];
        nodes.push(
            item(`${prefix}:deployments`, 'Deployments', {
                description:
                    environments.length === 1
                        ? `${branchDeployments.length} on ${environments[0]}`
                        : `${branchDeployments.length} on ${repo.branch}`,
                icon: 'rocket',
                tooltip: {
                    rows: [
                        { label: 'branch', value: repo.branch },
                        ...environments.map((environment) => ({
                            label: environment,
                            value: `${branchDeployments.filter((deployment) => deployment.environment === environment).length}`,
                        })),
                        { label: 'project', value: linkText(deploymentsUrl), url: deploymentsUrl },
                    ],
                },
                children: branchDeployments.map((deployment, index) =>
                    item(`${prefix}:branch-deployment:${index}`, deployment.hostname, {
                        trailingIcon:
                            deployment.environment === 'production'
                                ? 'circle-arrow-up'
                                : 'deployment-preview',
                        accessibilityLabel: `${deployment.hostname}, ${deployment.environment} · ${deploymentStateLabel(deployment)}`,
                        icon: deploymentIcons[deployment.state],
                        tooltip: deploymentTooltip(deployment.environment, deployment),
                        url: deployment.inspectorUrl,
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
                    description: deployment.hostname,
                    accessibilityLabel: `${label}, ${deploymentStateLabel(deployment)} · ${deployment.hostname}`,
                    icon: deploymentIcons[deployment.state],
                    tooltip: deploymentTooltip(label, deployment),
                    url: deployment.inspectorUrl,
                }),
            );
        }
    }
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        const presentation = pullRequest.lifecycle
            ? pullRequestPresentation[pullRequest.lifecycle]
            : { icon: 'circle-dot', label: 'Unknown', tone: 'neutral' as const };
        const children = pullRequest.checks.map((check, index) => {
            const duration = durationLabel(check.durationMs);
            return item(`${prefix}:check:${index}`, check.name, {
                description: duration,
                icon: stateIcons[check.state],
                url: check.url,
                tooltip: {
                    badge: { label: check.state, tone: stateTones[check.state] },
                    rows: [
                        ...(duration ? [{ label: 'duration', value: duration }] : []),
                        ...(check.url
                            ? [{ label: 'logs', value: linkText(check.url), url: check.url }]
                            : []),
                    ],
                },
            });
        });
        if (pullRequest.hiddenCheckCount > 0) {
            children.push(
                item(
                    `${prefix}:hidden-checks`,
                    `${ignoredChecksLabel(pullRequest.hiddenCheckCount)} hidden`,
                    { icon: 'eye-off' },
                ),
            );
        }
        nodes.push(
            item(`${prefix}:pr`, `#${pullRequest.number} ${pullRequest.title}`, {
                icon: presentation.icon,
                description: `${presentation.label} · ${checkLabels[pullRequest.state]}`,
                url: pullRequest.url,
                tooltip: {
                    badge: { label: presentation.label, tone: presentation.tone },
                    rows: [
                        { label: 'checks', value: pullRequest.state },
                        ...(pullRequest.hiddenCheckCount > 0
                            ? [
                                  {
                                      label: 'hidden',
                                      value: ignoredChecksLabel(pullRequest.hiddenCheckCount),
                                  },
                              ]
                            : []),
                    ],
                },
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
                tooltip: {
                    badge: { label: error.source, tone: 'danger' },
                    description: error.hint,
                },
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
        tooltip: {
            ...(presentation.description && {
                badge: { label: presentation.description, tone: 'neutral' },
            }),
            // The Extension Host strips `rootPath` from the summary it hands extensions, so a repository hover
            // identifies itself by branch and remote rather than by its location on disk.
            rows: [
                { label: 'branch', value: repo.branch },
                ...(repo.githubUrl
                    ? [
                          {
                              label: 'repository',
                              value: linkText(repo.githubUrl),
                              url: repo.githubUrl,
                          },
                      ]
                    : []),
            ],
        },
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
