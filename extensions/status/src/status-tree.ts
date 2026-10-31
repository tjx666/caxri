import type {
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusSummary,
    TreeItemAction,
    TreeItemTooltipRow,
} from 'caxri';
import { l10n, ProjectStatusSummaryErrorMessage, TreeItemCollapsibleState } from 'caxri';

import { fixDeploymentAction } from './status-agent-actions';
import {
    isPullRequestRowExpanded,
    pullRequestCheckNodes,
    pullRequestCheckSummary,
} from './status-checks';
import type { StatusNode } from './status-item';
import { item } from './status-item';
import {
    acceptanceDescription,
    acceptanceRowLabel,
    acceptanceStatusLabel,
    acceptanceVerdictLabel,
    checkLabel,
    deploymentStateLabel,
    ignoredChecksLabel,
    publicationDescription,
    publicationLabel,
    refreshActionLabel,
} from './status-labels';
import { mergeReadinessLabel, pullRequestRowActions } from './status-merge';
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
    pullRequestCheckIcon,
    pullRequestPresentation,
    repoPresentation,
    stateIcons,
    stateTones,
} from './status-presentation';
import { reviewNode } from './status-review';
import { localizeServerStatusText } from './status-server-text';
import { networkNodes, rateLimitNodes, sharedFailureReasons } from './status-shared-failures';

/**
 * A failed deployment, Production or Preview, offers `Fix` wherever its row appears: the summary row or its entry under
 * Deployments. A running or queued one has nothing to fix yet.
 */
function deploymentActions(
    repo: ProjectStatusRepository,
    deployment: ProjectStatusDeployment,
): TreeItemAction[] | undefined {
    return deployment.state === 'failure' ? [fixDeploymentAction(repo, deployment)] : undefined;
}

const missingGitRepoErrors = new Set<string>([
    ProjectStatusSummaryErrorMessage.missingGitRepository,
    ProjectStatusSummaryErrorMessage.missingPrimaryRepository,
]);
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
    /**
     * Only a pull request whose head is this branch may speak for the branch. A Session keeps its last delivery (or one
     * made from another worktree or repository) attached to the repository row, so after the Session moves to a new
     * branch the retained pull request is history: its `merged` state must not color the current branch (#2147). A
     * missing `headBranch` proves nothing, so it never counts as a match. The pull request row keeps using `lifecycle`,
     * which is the pull request's own truth.
     */
    const branchLifecycle = repo.pullRequest?.headBranch === repo.branch ? lifecycle : undefined;
    const branchPublication = publication ? publicationLabel(publication) : undefined;
    /**
     * `Synced` is the expected steady state and asks nothing of the reader, so the row stays quiet about it; only a
     * state worth acting on (`↑2`, `Not on origin`, `Check failed`) earns the row's trailing text. The hover card still
     * badges every state, `Synced` included.
     */
    const branchRowPublication = publication?.state === 'synced' ? undefined : branchPublication;
    const branchDescription = [
        isDefaultBranch ? l10n.t('default') : undefined,
        branchRowPublication,
    ]
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
                    : (branchLifecycle?.icon ?? 'git-branch'),
            accessibilityLabel: [
                repo.branch,
                branchDescription.length > 0 ? branchDescription : undefined,
                branchLifecycle && repo.pullRequest
                    ? l10n.t('pull request #{number} {state}', {
                          number: repo.pullRequest.number,
                          state: branchLifecycle.label,
                      })
                    : undefined,
                // The trailing "No origin" is terse; the spoken row says what it needs, as the hover card does.
                publication?.state === 'no-origin'
                    ? l10n.t('add a GitHub remote named origin to compare it')
                    : undefined,
            ]
                .filter(Boolean)
                .join(', '),
            url: repo.branchUrl,
            tooltip: {
                ...((branchPublication !== undefined || isDefaultBranch) && {
                    badge: { label: branchPublication ?? l10n.t('default'), tone: 'neutral' },
                }),
                description: publication ? publicationDescription(publication.state) : undefined,
                rows: [
                    ...(branchLifecycle && repo.pullRequest
                        ? [
                              {
                                  label: l10n.t('pull request'),
                                  value: `#${repo.pullRequest.number} ${branchLifecycle.label}`,
                              },
                          ]
                        : []),
                    ...(publication?.remoteBranch
                        ? [{ label: l10n.t('compared branch'), value: publication.remoteBranch }]
                        : []),
                    ...(publication?.checkedAt === undefined
                        ? []
                        : [
                              {
                                  label: l10n.t('checked'),
                                  value: new Date(publication.checkedAt).toLocaleString(),
                              },
                          ]),
                    ...(isDefaultBranch && publication
                        ? [{ label: l10n.t('default'), value: repo.branch }]
                        : []),
                    !isDefaultBranch && repo.defaultBranch
                        ? { label: l10n.t('default'), value: repo.defaultBranch }
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
                                  label: l10n.t('verdict'),
                                  value: acceptanceVerdictLabel(acceptance.verdict),
                              }
                            : undefined,
                        acceptance.totalChecks === undefined ||
                        acceptance.passedChecks === undefined
                            ? undefined
                            : {
                                  label: l10n.t('checks'),
                                  value: l10n.t('{count} of {total} passed', {
                                      count: acceptance.passedChecks,
                                      total: acceptance.totalChecks,
                                  }),
                              },
                        acceptance.round === undefined
                            ? acceptance.roundCount !== undefined && acceptance.roundCount > 1
                                ? {
                                      label: l10n.t('round'),
                                      value: l10n.t('latest of {count}', {
                                          count: acceptance.roundCount,
                                      }),
                                  }
                                : undefined
                            : { label: l10n.t('round'), value: `${acceptance.round}` },
                    ].filter((row): row is TreeItemTooltipRow => row !== undefined),
                },
            }),
        );
    }
    const review = reviewNode(repo, prefix);
    if (repo.deployments) {
        const { branchDeployments, production, preview, url: deploymentsUrl } = repo.deployments;
        const environments = [...new Set(branchDeployments.map(({ environment }) => environment))];
        /**
         * Whether `deployment`, a `branchDeployments` row, is also the branch's current Production or Preview build, so
         * that row can say "Latest" instead of the summary loop below repeating it as a second top-level row (#1291).
         */
        const isLatestDeployment = (deployment: ProjectStatusDeployment): boolean =>
            (deployment.environment === 'production' &&
                production?.hostname === deployment.hostname) ||
            (deployment.environment === 'preview' && preview?.hostname === deployment.hostname);
        /**
         * Whether `deployment`, the branch's current Production or Preview build, is already one of the rows
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
         * genuinely nothing deployed yet on a named branch still gets the node: `0 on main` reads as "nothing shipped
         * on this branch", the fact this panel exists to report.
         */
        const isDetachedWithNothingDeployed =
            repo.branch === 'detached' && branchDeployments.length === 0;
        if (!isDetachedWithNothingDeployed)
            nodes.push(
                item(`${prefix}:deployments`, l10n.t('Deployments'), {
                    description:
                        environments.length === 1
                            ? environments[0] === 'production'
                                ? l10n.t('{count} on production', {
                                      count: branchDeployments.length,
                                  })
                                : l10n.t('{count} on preview', { count: branchDeployments.length })
                            : l10n.t('{count} on {branch}', {
                                  count: branchDeployments.length,
                                  branch: repo.branch,
                              }),
                    icon: 'rocket',
                    tooltip: {
                        rows: [
                            { label: l10n.t('branch'), value: repo.branch },
                            ...environments.map((environment) => ({
                                label:
                                    environment === 'production'
                                        ? l10n.t('production')
                                        : l10n.t('preview'),
                                value: `${branchDeployments.filter((deployment) => deployment.environment === environment).length}`,
                            })),
                            {
                                label: l10n.t('project'),
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
                                    `${deployment.environment === 'production' ? l10n.t('production') : l10n.t('preview')} · ${deploymentStateLabel(deployment)}`,
                                    deployment,
                                ),
                                icon: deploymentIcon(deployment),
                                tooltip: deploymentTooltip(
                                    deploymentEnvironmentLabel(deployment.environment),
                                    deployment,
                                ),
                                url: deployment.inspectorUrl,
                                actions: deploymentActions(repo, deployment),
                            },
                        ),
                    ),
                }),
            );
        // fe-helper's order: the deployment list, then the review feedback, then the latest environments.
        if (review) nodes.push(review);
        for (const [label, deployment] of [
            [l10n.t('Production'), production],
            [l10n.t('Preview'), preview],
        ] as const) {
            // Already shown once, inline, by the `branchDeployments` row `isLatestDeployment` marks "Latest" above.
            if (!deployment || isAlreadyListed(deployment)) continue;
            const stateLabel = deploymentStateLabel(deployment);
            nodes.push(
                item(`${prefix}:${deployment.environment}`, label, {
                    /**
                     * No trailing text: neither the alias (`app-git-branch.example.vercel.app`) nor the short commit
                     * SHA tells a reader anything the commit subject does not, and both spent the row's width on a
                     * hash. The alias and SHA stay on the hover card, which opens the deployment, and the alias stays
                     * in the accessible name.
                     */
                    accessibilityLabel: deploymentAccessibilityLabel(label, stateLabel, deployment),
                    icon: deploymentIcon(deployment),
                    tooltip: deploymentTooltip(label, deployment),
                    url: deployment.inspectorUrl,
                    actions: deploymentActions(repo, deployment),
                }),
            );
        }
    }
    if (review && !repo.deployments) nodes.push(review);
    if (repo.pullRequest) {
        const pullRequest = repo.pullRequest;
        /**
         * A pull request whose lifecycle the provider never sent is not a pull request in an unknown state: it is one
         * we did not hear about. `Unknown` also already meant two other things in this tree, and reusing it a third
         * time made the badge unreadable.
         */
        const lifecycleLabel = lifecycle?.label ?? l10n.t('Not reported');
        const children = pullRequestCheckNodes(prefix, pullRequest);
        /**
         * The row sits under the checked-out branch, so a pull request the Session's Agent opened from another worktree
         * would read as that branch's. Naming its own branch only when they differ keeps the ordinary row unchanged.
         */
        const otherBranch =
            pullRequest.headBranch && pullRequest.headBranch !== repo.branch
                ? pullRequest.headBranch
                : undefined;
        nodes.push(
            item(`${prefix}:pr`, `#${pullRequest.number} ${pullRequest.title}`, {
                actions: pullRequestRowActions(repo, pullRequest),
                /**
                 * The leading icon aggregates the check states shown by the child rows, rather than spending the
                 * description on a `CI failed` string that competed with the title for width. The lifecycle moved up to
                 * the branch row (see `lifecycle` above), so this row no longer repeats it in the trailing slot.
                 */
                icon: pullRequestCheckIcon(pullRequest),
                /**
                 * Trailing counts name only the checks that ask for attention (`1 failing · 3 running`), so a row whose
                 * checks all passed stays quiet while a pending or failed one says how many without expanding.
                 */
                description: pullRequestCheckSummary(pullRequest.checks),
                accessibilityLabel: [
                    `#${pullRequest.number} ${pullRequest.title}`,
                    lifecycleLabel,
                    pullRequest.lifecycle === 'open' && pullRequest.mergeState === 'conflicting'
                        ? l10n.t('has conflicts')
                        : undefined,
                    checkLabel(pullRequest.state),
                    otherBranch ? l10n.t('from {branch}', { branch: otherBranch }) : undefined,
                ]
                    .filter(Boolean)
                    .join(', '),
                url: pullRequest.url,
                tooltip: {
                    badge: { label: lifecycleLabel, tone: lifecycle?.tone ?? 'neutral' },
                    rows: [
                        ...(otherBranch ? [{ label: l10n.t('branch'), value: otherBranch }] : []),
                        // Names where a merge would land, so a pull request opened against a release branch or a
                        // stacked parent is not mistaken for one targeting the default branch.
                        ...(pullRequest.baseBranch
                            ? [{ label: l10n.t('base'), value: pullRequest.baseBranch }]
                            : []),
                        { label: l10n.t('checks'), value: checkLabel(pullRequest.state) },
                        ...(pullRequest.lifecycle === 'open' && pullRequest.mergeState
                            ? [{ label: l10n.t('merge'), value: mergeReadinessLabel(pullRequest) }]
                            : []),
                        ...(pullRequest.hiddenCheckCount > 0
                            ? [
                                  {
                                      label: l10n.t('hidden'),
                                      value: ignoredChecksLabel(pullRequest.hiddenCheckCount),
                                  },
                              ]
                            : []),
                    ],
                },
                children,
                collapsibleState: isPullRequestRowExpanded(pullRequest)
                    ? TreeItemCollapsibleState.Expanded
                    : TreeItemCollapsibleState.Collapsed,
            }),
        );
    }
    for (const error of repo.errors) {
        if (shouldHideSharedErrors && sharedFailureReasons.has(error.reason)) continue;
        const isFailure = error.kind === 'failure';
        const message = localizeServerStatusText(error.message);
        const hint = error.hint && localizeServerStatusText(error.hint);
        const errorNode = item(`${prefix}:error:${error.source}`, message, {
            variant: 'message',
            description: hint,
            icon: isFailure
                ? 'circle-x'
                : error.source === 'vercel'
                  ? 'cloud'
                  : error.source === 'github'
                    ? 'git-branch'
                    : 'issues',
            tooltip: {
                badge: { label: error.source, tone: isFailure ? 'danger' : 'neutral' },
                description: hint,
            },
            command: error.logs
                ? {
                      command: 'caxri.showLogs',
                      title: l10n.t('Open Logs'),
                      // The query travels with the action so the panel opens on the failing event rather than on
                      // every process's records, which is the only form in which "the details are in the logs" is
                      // an answer instead of another search.
                      arguments: [error.logs],
                  }
                : { command: 'caxri.project-status.refresh', title: refreshActionLabel() },
        });
        nodes.push(
            error.source === 'vercel'
                ? item(`${prefix}:deployments`, l10n.t('Deployments'), {
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
                { label: l10n.t('branch'), value: repo.branch },
                ...(repo.githubUrl
                    ? [
                          {
                              label: l10n.t('repository'),
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
                isMissingGitRepo
                    ? l10n.t('No Git repository')
                    : l10n.t('Project Status unavailable'),
                {
                    variant: 'message',
                    description: isMissingGitRepo
                        ? l10n.t('Initialize a Git repository in the Project root, then refresh.')
                        : summary.error,
                    icon: isMissingGitRepo ? 'git-branch' : 'circle-x',
                    command: {
                        command: 'caxri.project-status.refresh',
                        title: refreshActionLabel(),
                    },
                },
            ),
        ];
    }
    if (summary.repositories.length === 0)
        return [
            item('status:empty', l10n.t('No repositories found'), {
                variant: 'message',
                description: l10n.t('Add a Git repository to this Project, then refresh.'),
                icon: 'git-branch',
                command: {
                    command: 'caxri.project-status.refresh',
                    title: refreshActionLabel(),
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
