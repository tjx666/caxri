import type {
    Command,
    ProjectStatusDeployment,
    ProjectStatusRepository,
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
    durationLabel,
    ignoredChecksLabel,
    oneLine,
    projectStatusStateLabel,
    publicationDescription,
    publicationLabel,
    REFRESH_ACTION_LABEL,
    reviewThreadLocation,
    unresolvedCommentsLabel,
} from './status-labels';
import type { StatusTooltip } from './status-presentation';
import {
    acceptanceIcon,
    branchDeploymentRowDescription,
    deploymentAccessibilityLabel,
    deploymentEnvironmentLabel,
    deploymentIcon,
    deploymentRowLabel,
    deploymentTooltip,
    linearBadgeTones,
    linearIcon,
    linkText,
    pullRequestPresentation,
    repoPresentation,
    stateIcons,
    stateTones,
} from './status-presentation';

export interface StatusNode {
    item: TreeItem;
    children?: readonly StatusNode[];
}

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

/**
 * Vscode-fe-helper's "Unresolved Comments" group: the review feedback a delivery still owes, one row per thread. The
 * group opens the pull request's conversation; each thread opens its own comment. Absent when nothing is unresolved, so
 * a clean pull request spends no row on it.
 */
function reviewThreadsNode(repo: ProjectStatusRepository, prefix: string): StatusNode | undefined {
    const pullRequest = repo.pullRequest;
    if (!pullRequest) return undefined;
    const threads = pullRequest.unresolvedReviewThreads;
    if (threads === undefined) {
        /**
         * `ReviewThreadStore.attach` only fetches threads for an open or draft pull request; a merged or closed one is
         * never asked, so an absent field there is simply "not applicable", not a failure. For an open or draft pull
         * request the field is absent only because the GraphQL read threw (see `attach`'s catch), and treating that the
         * same as `[]` told the user the review was clean when Caxri never actually checked.
         */
        if (pullRequest.lifecycle !== 'open' && pullRequest.lifecycle !== 'draft') return undefined;
        return item(`${prefix}:review-threads`, 'Could not check review comments', {
            icon: stateIcons.unknown,
            url: pullRequest.url,
            tooltip: {
                description:
                    'GitHub review comments could not be read. Refresh Project Status to check again.',
            },
        });
    }
    if (threads.length === 0) return undefined;
    const summary = unresolvedCommentsLabel(threads.length);
    return item(`${prefix}:review-threads`, 'Unresolved Comments', {
        description: String(threads.length),
        icon: 'comment-unresolved',
        accessibilityLabel: `Unresolved Comments, ${summary}`,
        url: pullRequest.url,
        tooltip: {
            badge: { label: summary, tone: 'warning' },
            description: 'Open the pull request conversation; expand for individual threads.',
        },
        children: threads.map((thread, index) => {
            const location = reviewThreadLocation(thread);
            const excerpt = oneLine(thread.body, 80);
            return item(`${prefix}:review-thread:${index}`, location, {
                description: excerpt || undefined,
                icon: 'comment',
                accessibilityLabel: [location, thread.author && `by ${thread.author}`, excerpt]
                    .filter(Boolean)
                    .join(', '),
                url: thread.url,
                tooltip: {
                    ...(thread.body.trim() && { description: oneLine(thread.body, 1_024) }),
                    rows: [
                        thread.path ? { label: 'file', value: thread.path } : undefined,
                        thread.author ? { label: 'author', value: `@${thread.author}` } : undefined,
                        thread.createdAt === undefined
                            ? undefined
                            : {
                                  label: 'created',
                                  value: new Date(thread.createdAt).toLocaleString(),
                              },
                    ].filter((row): row is TreeItemTooltipRow => row !== undefined),
                },
            });
        }),
    });
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
    /**
     * `Synced` is the expected steady state and asks nothing of the reader, so the row stays quiet about it; only a
     * state worth acting on (`↑2`, `Not on origin`, `Check failed`) earns the row's trailing text. The hover card still
     * badges every state, `Synced` included.
     */
    const branchRowPublication = publication?.state === 'synced' ? undefined : branchPublication;
    const branchDescription = [isDefaultBranch ? 'default' : undefined, branchRowPublication]
        .filter(Boolean)
        .join(' · ');
    const nodes: StatusNode[] = [
        item(`${prefix}:branch`, repo.branch, {
            description: branchDescription.length > 0 ? branchDescription : undefined,
            // While the origin probe is still in flight the row already says "Checking origin…" in its description; the
            // icon must agree, so it borrows the same spinner a pending check uses rather than sitting on the static
            // pull-request or branch glyph as if nothing were happening.
            icon:
                publication?.state === 'checking'
                    ? stateIcons.pending
                    : (lifecycle?.icon ?? 'git-branch'),
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
                    acceptanceDescription(acceptance, 'spoken'),
                ]
                    .filter(Boolean)
                    .join(', '),
                description: acceptanceDescription(acceptance),
                icon: acceptanceIcon(acceptance),
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
                            ? acceptance.roundCount !== undefined && acceptance.roundCount > 1
                                ? { label: 'round', value: `latest of ${acceptance.roundCount}` }
                                : undefined
                            : { label: 'round', value: `${acceptance.round}` },
                    ].filter((row): row is TreeItemTooltipRow => row !== undefined),
                },
            }),
        );
    }
    const reviewThreads = reviewThreadsNode(repo, prefix);
    if (repo.deployments) {
        const { branchDeployments, production, preview, url: deploymentsUrl } = repo.deployments;
        const environments = [...new Set(branchDeployments.map(({ environment }) => environment))];
        /**
         * Whether `deployment` — a `branchDeployments` row — is also the branch's current Production or Preview build,
         * so that row can say "Latest" instead of the summary loop below repeating it as a second top-level row
         * (#1291).
         */
        const isLatestDeployment = (deployment: ProjectStatusDeployment): boolean =>
            (deployment.environment === 'production' &&
                production?.hostname === deployment.hostname) ||
            (deployment.environment === 'preview' && preview?.hostname === deployment.hostname);
        /**
         * Whether `deployment` — the branch's current Production or Preview build — is already one of the rows
         * `branchDeployments` renders above. Almost always true: `branchDeployments` usually already carries the newest
         * build in each environment for this same branch, which is exactly what made the same commit show up twice
         * before this fix (#1291).
         */
        const isAlreadyListed = (deployment: ProjectStatusDeployment): boolean =>
            branchDeployments.some(
                (branchDeployment) =>
                    branchDeployment.hostname === deployment.hostname &&
                    branchDeployment.environment === deployment.environment,
            );
        /**
         * Detached HEAD has no branch of its own to report deployments for, and `detached` is Git's own internal name
         * for that state (`status.ts`'s `parseGitStatus`), not something to print as though it were one. A repo with
         * genuinely nothing deployed yet on a named branch still gets the node — `0 on main` reads as "nothing shipped
         * on this branch", the fact this panel exists to report.
         */
        const isDetachedWithNothingDeployed =
            repo.branch === 'detached' && branchDeployments.length === 0;
        if (!isDetachedWithNothingDeployed)
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
                            {
                                label: 'project',
                                value: linkText(deploymentsUrl),
                                url: deploymentsUrl,
                            },
                        ],
                    },
                    children: branchDeployments.map((deployment, index) =>
                        item(
                            `${prefix}:branch-deployment:${index}`,
                            deploymentRowLabel(deployment),
                            {
                                description: branchDeploymentRowDescription(
                                    deployment,
                                    isLatestDeployment(deployment),
                                ),
                                accessibilityLabel: deploymentAccessibilityLabel(
                                    deployment.commit?.message ?? deployment.hostname,
                                    `${deployment.environment} · ${deploymentStateLabel(deployment)}`,
                                    deployment,
                                ),
                                icon: deploymentIcon(deployment),
                                tooltip: deploymentTooltip(
                                    deploymentEnvironmentLabel(deployment.environment),
                                    deployment,
                                ),
                                url: deployment.inspectorUrl,
                            },
                        ),
                    ),
                }),
            );
        // fe-helper's order: the deployment list, then the review feedback, then the latest environments.
        if (reviewThreads) nodes.push(reviewThreads);
        for (const [label, deployment] of [
            ['Production', production],
            ['Preview', preview],
        ] as const) {
            // Already shown once, inline, by the `branchDeployments` row `isLatestDeployment` marks "Latest" above.
            if (!deployment || isAlreadyListed(deployment)) continue;
            const stateLabel = deploymentStateLabel(deployment);
            nodes.push(
                item(`${prefix}:${deployment.environment}`, label, {
                    /**
                     * No trailing text: neither the alias (`project-next-i06ixdxlq-team.vercel.app`) nor the short
                     * commit SHA tells a reader anything the commit subject does not, and both spent the row's width on
                     * a hash. The alias and SHA stay on the hover card, which opens the deployment, and the alias stays
                     * in the accessible name.
                     */
                    accessibilityLabel: deploymentAccessibilityLabel(label, stateLabel, deployment),
                    icon: deploymentIcon(deployment),
                    tooltip: deploymentTooltip(label, deployment),
                    url: deployment.inspectorUrl,
                }),
            );
        }
    }
    if (reviewThreads && !repo.deployments) nodes.push(reviewThreads);
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
            command: error.logs
                ? {
                      command: 'caxri.showLogs',
                      title: 'Open Logs',
                      // The query travels with the action so the panel opens on the failing event rather than on
                      // every process's records, which is the only form in which "the details are in the logs" is
                      // an answer instead of another search.
                      arguments: [error.logs],
                  }
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
