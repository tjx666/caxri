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

import {
    acceptanceDescription,
    acceptanceRowLabel,
    acceptanceStatusLabel,
    acceptanceVerdictLabel,
    checkLabel,
    deploymentStateLabel,
    projectStatusStateLabel,
    publicationDescription,
    publicationLabel,
    REFRESH_ACTION_LABEL,
} from './status-labels';

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

const linearStateIcons: Partial<
    Record<NonNullable<ProjectStatusRepository['linearIssues'][number]['stateType']>, string>
> = {
    backlog: 'linear-backlog',
    canceled: 'linear-canceled',
    completed: 'linear-completed',
    duplicate: 'linear-duplicate',
    started: 'linear-started',
    triage: 'linear-triage',
    unstarted: 'linear-unstarted',
};

/**
 * Badge tone for the state name shown in an issue's hover card. Deliberately not `stateTones[linearState(…)]`: that
 * mapping calls every `started` state pending, and Linear files "In Review" and "Ready to Merge" under `started`
 * alongside "In Progress". Calling those three the same kind of in-flight is the honest reading; the icon carries the
 * workspace's own color for the distinction.
 */
const linearBadgeTones: Partial<
    Record<
        NonNullable<ProjectStatusRepository['linearIssues'][number]['stateType']>,
        'danger' | 'neutral' | 'success' | 'warning'
    >
> = {
    completed: 'success',
    triage: 'warning',
};

const stateTones: Record<ProjectStatusState, 'danger' | 'neutral' | 'success' | 'warning'> = {
    success: 'success',
    failure: 'danger',
    cancelled: 'neutral',
    pending: 'warning',
    neutral: 'neutral',
    unknown: 'neutral',
};

/**
 * `label` is deliberately absent from either row's own description: the glyph already says the lifecycle in the same
 * colors GitHub uses — green open, grey draft, purple merged, red closed — so repeating "Open" beside it spent the
 * row's scarce width restating the icon. It stays on the hover card's badge and in the accessible name, which is where
 * a reader who cannot use the color needs it.
 */
const pullRequestPresentation = {
    open: { icon: 'git-pull-request-open', label: 'Open', tone: 'success' },
    draft: { icon: 'git-pull-request-draft', label: 'Draft', tone: 'neutral' },
    merged: { icon: 'git-merge', label: 'Merged', tone: 'neutral' },
    closed: { icon: 'git-pull-request-closed', label: 'Closed', tone: 'danger' },
} as const;

const repoPresentation: Record<
    ProjectStatusRepository['kind'],
    { description?: string; icon: string }
> = {
    primary: { icon: 'repo' },
    worktree: { description: 'worktree', icon: 'worktree' },
    nested: { description: 'nested', icon: 'repo' },
    submodule: { description: 'submodule', icon: 'archive' },
};

const missingGitRepoErrors = new Set<string>([
    ProjectStatusSummaryErrorMessage.missingGitRepository,
    ProjectStatusSummaryErrorMessage.missingPrimaryRepository,
]);
const networkProviderListFormatter = new Intl.ListFormat('en', { type: 'conjunction' });

type ProjectStatusFailure = ProjectStatusRepository['errors'][number];

/**
 * Failures that state one condition for the whole Project rather than a property of the repository that happened to
 * report them: a lost connection, and a provider budget the whole account shares. The root states each of these once
 * and the repository subtrees drop them — a Project holding a repository plus its submodule otherwise printed the same
 * account-level sentence twice, each with its own Refresh button.
 */
const sharedFailureReasons = new Set<ProjectStatusFailure['reason']>(['network', 'rate-limited']);

const providerNames = {
    acceptance: 'LobeHub',
    github: 'GitHub',
    linear: 'Linear',
    vercel: 'Vercel',
} as const satisfies Record<ProjectStatusFailure['source'], string>;

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
        /**
         * `#RRGGBB` tint for `icon`, for a row standing in for content whose palette an external system owns.
         */
        iconColor?: string;
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
    if (options.icon) treeItem.iconPath = new ThemeIcon(options.icon, options.iconColor);
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

/**
 * Seven hex characters is the abbreviation Git and GitHub both display, so a row and the commit page a reader compares
 * it against agree without truncating a Vercel deployment's full 40-character SHA differently from either.
 */
function shortCommitSha(sha: string): string {
    return sha.slice(0, 7);
}

/**
 * What the deployment built, not where it landed. A Vercel alias is a generated hash that is already unreadable at
 * SecondarySidebar width, while the commit subject answers the question a deployment list is actually asked. Falls back
 * to the alias for a direct CLI upload, which carries no Git provenance.
 */
function deploymentRowLabel(deployment: ProjectStatusDeployment): string {
    return deployment.commit?.message ?? deployment.hostname;
}

function deploymentRowDescription(deployment: ProjectStatusDeployment): string | undefined {
    return deployment.commit ? shortCommitSha(deployment.commit.sha) : undefined;
}

/**
 * Screen readers keep every identifier the visible row had to give up — the commit subject and the alias — while a part
 * the label already announced is dropped rather than repeated.
 */
function deploymentAccessibilityLabel(
    lead: string,
    detail: string,
    deployment: ProjectStatusDeployment,
): string {
    return [`${lead}, ${detail}`, deployment.commit?.message, deployment.hostname]
        .filter((part) => part !== undefined && part !== lead)
        .join(' · ');
}

function deploymentTooltip(title: string, deployment: ProjectStatusDeployment): StatusTooltip {
    const { commit } = deployment;
    return {
        title,
        badge: { label: deploymentStateLabel(deployment), tone: stateTones[deployment.state] },
        rows: [
            ...(commit
                ? [
                      {
                          label: 'commit',
                          value: [shortCommitSha(commit.sha), commit.message]
                              .filter(Boolean)
                              .join(' '),
                          ...(commit.url && { url: commit.url }),
                      },
                  ]
                : []),
            ...(commit?.authorLogin ? [{ label: 'author', value: commit.authorLogin }] : []),
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
function buildRepoChildren(
    repo: ProjectStatusRepository,
    shouldHideSharedErrors = false,
): StatusNode[] {
    const prefix = `status:repo:${repo.id}`;
    const isDefaultBranch = repo.defaultBranch === repo.branch;
    const publication = repo.publication;
    /**
     * The branch row wears its pull request's lifecycle glyph in place of the generic `git-branch`, so the subtree
     * answers "does this branch have a pull request, and where is it?" at the branch itself. The pull request row below
     * drops the trailing copy it used to carry: the same glyph twice in one subtree taught the eye nothing while
     * spending the row's right edge on it. An absent lifecycle keeps the branch glyph rather than asserting a state the
     * provider never reported.
     */
    const lifecycle = repo.pullRequest?.lifecycle
        ? pullRequestPresentation[repo.pullRequest.lifecycle]
        : undefined;
    const branchPublication = publication ? publicationLabel(publication) : undefined;
    const branchDescription = [isDefaultBranch ? 'default' : undefined, branchPublication]
        .filter(Boolean)
        .join(' · ');
    const nodes: StatusNode[] = [
        item(`${prefix}:branch`, repo.branch, {
            description: branchDescription.length > 0 ? branchDescription : undefined,
            icon: lifecycle?.icon ?? 'git-branch',
            accessibilityLabel: [
                repo.branch,
                branchDescription.length > 0 ? branchDescription : undefined,
                lifecycle && repo.pullRequest
                    ? `pull request #${repo.pullRequest.number} ${lifecycle.label}`
                    : undefined,
            ]
                .filter(Boolean)
                .join(', '),
            url: repo.branchUrl,
            tooltip: {
                ...((branchPublication !== undefined || isDefaultBranch) && {
                    badge: { label: branchPublication ?? 'default', tone: 'neutral' },
                }),
                description: publication ? publicationDescription(publication.state) : undefined,
                rows: [
                    ...(lifecycle && repo.pullRequest
                        ? [
                              {
                                  label: 'pull request',
                                  value: `#${repo.pullRequest.number} ${lifecycle.label}`,
                              },
                          ]
                        : []),
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
        nodes.push(
            item(
                `${prefix}:linear:${issue.identifier}`,
                issue.title ? `${issue.identifier} ${issue.title}` : issue.identifier,
                {
                    /**
                     * No description: the leading glyph already carries the workflow state in the workspace's own
                     * color, so printing "In Progress" beside it spent the row's width restating the icon while
                     * squeezing the issue title. The state stays on the hover card's badge and the accessible name.
                     */
                    accessibilityLabel: [issue.identifier, issue.title, issue.state]
                        .filter(Boolean)
                        .join(', '),
                    icon: linearIcon(issue.stateType),
                    iconColor: issue.stateColor,
                    url: issue.url,
                    tooltip: {
                        ...(issue.state && {
                            badge: {
                                label: issue.state,
                                tone:
                                    (issue.stateType && linearBadgeTones[issue.stateType]) ??
                                    'neutral',
                            },
                        }),
                    },
                },
            ),
        );
    }
    for (const acceptance of repo.acceptances) {
        const { state } = acceptance;
        nodes.push(
            item(`${prefix}:acceptance:${acceptance.id}`, acceptanceRowLabel(acceptance), {
                accessibilityLabel: [
                    acceptanceRowLabel(acceptance),
                    acceptance.status && acceptanceStatusLabel(acceptance.status),
                    acceptance.verdict && acceptanceVerdictLabel(acceptance.verdict),
                    acceptanceDescription(acceptance),
                ]
                    .filter(Boolean)
                    .join(', '),
                description: acceptanceDescription(acceptance),
                icon: stateIcons[state],
                url: acceptance.url,
                tooltip: {
                    ...(acceptance.status && {
                        badge: {
                            label: acceptanceStatusLabel(acceptance.status),
                            tone: stateTones[state],
                        },
                    }),
                    rows: [
                        acceptance.verdict
                            ? {
                                  label: 'verdict',
                                  value: acceptanceVerdictLabel(acceptance.verdict),
                              }
                            : undefined,
                        acceptance.totalChecks === undefined ||
                        acceptance.passedChecks === undefined
                            ? undefined
                            : {
                                  label: 'checks',
                                  value: `${acceptance.passedChecks} of ${acceptance.totalChecks} passed`,
                              },
                        acceptance.round === undefined
                            ? undefined
                            : { label: 'round', value: `${acceptance.round}` },
                    ].filter((row): row is TreeItemTooltipRow => row !== undefined),
                },
            }),
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
                    item(`${prefix}:branch-deployment:${index}`, deploymentRowLabel(deployment), {
                        trailingIcon:
                            deployment.environment === 'production'
                                ? 'circle-arrow-up'
                                : 'deployment-preview',
                        description: deploymentRowDescription(deployment),
                        accessibilityLabel: deploymentAccessibilityLabel(
                            deploymentRowLabel(deployment),
                            `${deployment.environment} · ${deploymentStateLabel(deployment)}`,
                            deployment,
                        ),
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
            const stateLabel = deploymentStateLabel(deployment);
            nodes.push(
                item(`${prefix}:${deployment.environment}`, label, {
                    /**
                     * The description carries the short commit SHA, never the alias: a Vercel alias is mostly a
                     * generated hash (`project-next-i06ixdxlq-team.vercel.app`), so the row spent half its width on a
                     * string that was unreadable before it was even truncated. The alias stays on the hover card's
                     * `alias` row, which opens the deployment, and in the accessible name.
                     */
                    description: deploymentRowDescription(deployment),
                    accessibilityLabel: deploymentAccessibilityLabel(label, stateLabel, deployment),
                    icon: deploymentIcons[deployment.state],
                    tooltip: deploymentTooltip(label, deployment),
                    url: deployment.inspectorUrl,
                }),
            );
        }
    }
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        /**
         * A pull request whose lifecycle the provider never sent is not a pull request in an unknown state — it is one
         * we did not hear about. `Unknown` also already meant two other things in this tree, and reusing it a third
         * time made the badge unreadable.
         */
        const lifecycleLabel = lifecycle?.label ?? 'Not reported';
        const children = pullRequest.checks.map((check, index) => {
            const duration = durationLabel(check.durationMs);
            return item(`${prefix}:check:${index}`, check.name, {
                description: duration,
                icon: stateIcons[check.state],
                url: check.url,
                tooltip: {
                    badge: {
                        label: projectStatusStateLabel(check.state),
                        tone: stateTones[check.state],
                    },
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
                /**
                 * The leading icon aggregates the check states shown by the child rows, rather than spending the
                 * description on a `CI failed` string that competed with the title for width. The lifecycle moved up to
                 * the branch row (see `lifecycle` above), so this row no longer repeats it in the trailing slot.
                 */
                icon: stateIcons[pullRequest.state],
                accessibilityLabel: `#${pullRequest.number} ${pullRequest.title}, ${lifecycleLabel}, ${checkLabel(pullRequest.state)}`,
                url: pullRequest.url,
                tooltip: {
                    badge: { label: lifecycleLabel, tone: lifecycle?.tone ?? 'neutral' },
                    rows: [
                        { label: 'checks', value: checkLabel(pullRequest.state) },
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
        if (shouldHideSharedErrors && sharedFailureReasons.has(error.reason)) continue;
        const isFailure = error.kind === 'failure';
        const errorNode = item(`${prefix}:error:${error.source}`, error.message, {
            variant: 'message',
            description: error.hint,
            icon: isFailure
                ? 'circle-x'
                : error.source === 'vercel'
                  ? 'cloud'
                  : error.source === 'github'
                    ? 'git-branch'
                    : 'issues',
            tooltip: {
                badge: { label: error.source, tone: isFailure ? 'danger' : 'neutral' },
                description: error.hint,
            },
            command:
                error.detailsView === 'logs'
                    ? { command: 'caxri.showLogs', title: 'Open Logs' }
                    : { command: 'caxri.project-status.refresh', title: REFRESH_ACTION_LABEL },
        });
        nodes.push(
            error.source === 'vercel'
                ? item(`${prefix}:deployments`, 'Deployments', {
                      icon: 'rocket',
                      children: [errorNode],
                      collapsibleState: TreeItemCollapsibleState.Expanded,
                  })
                : errorNode,
        );
    }
    return nodes;
}

export function buildRepoNode(
    repo: ProjectStatusRepository,
    shouldHideSharedErrors = false,
): StatusNode {
    const presentation = repoPresentation[repo.kind];
    return item(`status:repo:${repo.id}`, repo.name, {
        description: presentation.description,
        icon: presentation.icon,
        children: buildRepoChildren(repo, shouldHideSharedErrors),
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

export function buildStatusRootNodes(
    summary: ProjectStatusSummary,
    /**
     * Decides whether a recorded pause is still running. Injected so a test can place a deadline on either side of it.
     */
    now: number = Date.now(),
): StatusNode[] {
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
                        title: REFRESH_ACTION_LABEL,
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
                    title: REFRESH_ACTION_LABEL,
                },
            }),
        ];
    const sharedErrors = summary.repositories.flatMap((repo) =>
        repo.errors.filter((error) => sharedFailureReasons.has(error.reason)),
    );
    return [
        ...networkNodes(sharedErrors.filter((error) => error.reason === 'network')),
        ...rateLimitNodes(
            sharedErrors.filter((error) => error.reason === 'rate-limited'),
            now,
        ),
        ...summary.repositories.map((repo) => buildRepoNode(repo, true)),
    ];
}

/**
 * One row for a connection every provider lost together: the user has a single thing to fix, so naming the providers
 * inside one sentence beats repeating an identical row per provider.
 */
function networkNodes(errors: readonly ProjectStatusFailure[]): StatusNode[] {
    if (errors.length === 0) return [];
    const [first] = errors;
    const names = failureSources(errors).map((source) => providerNames[source]);
    const isShared = names.length > 1;
    return [
        item('status:network', isShared ? 'No network connection' : first.message, {
            variant: 'message',
            description: isShared
                ? `Caxri could not reach ${networkProviderListFormatter.format(names)}. Reconnect, then refresh.`
                : first.hint,
            icon: 'cloud',
            command: { command: 'caxri.project-status.refresh', title: REFRESH_ACTION_LABEL },
        }),
    ];
}

/**
 * One row per rate-limited provider, rather than one row for all of them: each budget resets on its own schedule, and
 * the Server already wrote that provider's deadline into its hint. Grouping them would have to drop the one fact that
 * makes the row worth reading.
 */
function rateLimitNodes(errors: readonly ProjectStatusFailure[], now: number): StatusNode[] {
    const bySource = new Map<ProjectStatusFailure['source'], ProjectStatusFailure>();
    for (const error of errors) if (!bySource.has(error.source)) bySource.set(error.source, error);
    return [...bySource]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([source, error]) => {
            /**
             * Caxri honours this pause itself and recovers without the user, so inside the window there is nothing to
             * offer: Refresh would spend a click on a request the limiter answers with this very error. Past the
             * deadline — or with no deadline at all — the action comes back.
             */
            const isPaused = error.retryAt !== undefined && error.retryAt > now;
            return item(`status:rate-limit:${source}`, error.message, {
                variant: 'message',
                description: error.hint,
                icon: 'hourglass',
                ...(!isPaused && {
                    command: {
                        command: 'caxri.project-status.refresh',
                        title: REFRESH_ACTION_LABEL,
                    },
                }),
            });
        });
}

function failureSources(
    errors: readonly ProjectStatusFailure[],
): Array<ProjectStatusFailure['source']> {
    return [...new Set(errors.map((error) => error.source))].toSorted((a, b) => a.localeCompare(b));
}
