import type { ProjectStatusError, ProjectStatusRepository } from '@caxri/protocol';

import type {
    AcceptanceStore,
    ExternalStatusSource,
    GitHubPullRequestStore,
    LinearIssueStore,
} from '../external-status';
import { ExternalStatusCliError, isNoPullRequest } from '../external-status';
import { loadPullRequestAcceptances } from './acceptance';
import type { BranchPublicationContext } from './branch';
import type { EmptyCheckRollupTracker } from './empty-check-rollup';
import { projectStatusCliError } from './external';
import { loadPullRequestLinearIssues } from './linear';
import { parseGitHubPullRequest } from './parse';
import type { PullRequestExtras } from './pull-request-extras';
import type { StalePullRequestHeadTracker } from './stale-pull-request-head';

/**
 * The GitHub part of one repository's Project Status: its pull request, plus the Linear issues and acceptance reports
 * its body links.
 */
export type GitHubLoad = Pick<
    ProjectStatusRepository,
    'pullRequest' | 'linearIssues' | 'acceptances'
> & {
    mergeCommit?: string;
    errors: ProjectStatusError[];
};

/**
 * The readers and trackers {@link loadRepoGitHub} shares with the rest of `ProjectStatusService`.
 */
export interface GitHubLoadDependencies {
    acceptance: AcceptanceStore;
    emptyCheckRollups: EmptyCheckRollupTracker;
    extras: PullRequestExtras;
    github: GitHubPullRequestStore;
    ignoredChecks: () => readonly string[];
    linear: LinearIssueStore;
    now: () => number;
    onParseFailure: (command: ExternalStatusSource, error: unknown) => void;
    staleHeads: StalePullRequestHeadTracker;
}

/**
 * The GitHub part of a repository's status when there is no pull request to show, or reading it failed. A function, not
 * a shared literal: each caller gets its own arrays rather than aliases of one.
 */
function emptyGitHubLoad(): {
    acceptances: [];
    linearIssues: [];
    errors: ProjectStatusError[];
} {
    return { acceptances: [], linearIssues: [], errors: [] };
}

/**
 * The GitHub part of a repository's status after `gh` failed for a reason other than "no pull request": one `github`
 * error row carrying the failure kind and, for a rate limit, when to retry.
 */
function failedGitHubLoad(error: unknown): ReturnType<typeof emptyGitHubLoad> {
    const failure =
        error instanceof ExternalStatusCliError
            ? error
            : new ExternalStatusCliError('gh', 'other', String(error));
    return {
        ...emptyGitHubLoad(),
        errors: [projectStatusCliError('gh', failure.kind, { retryAt: failure.retryAt })],
    };
}

/**
 * Reads one repository's pull request (by `number` when the Session names one, otherwise by branch) and what its body
 * links. An explicit refresh (`isForced`) bypasses every shared record.
 */
export async function loadRepoGitHub(
    dependencies: GitHubLoadDependencies,
    cwd: string,
    context: BranchPublicationContext,
    isForced: boolean,
    number: number | undefined,
): Promise<GitHubLoad> {
    const { ignoredChecks, onParseFailure } = dependencies;
    if (!context.owner || !context.repo || !context.branch) return emptyGitHubLoad();
    try {
        const { owner, repo } = context;
        const target = number ? { number } : { branch: context.branch };
        const parsed = await dependencies.staleHeads.read(context, isForced, {
            view: (maxAgeMs) => dependencies.github.view({ ...target, cwd, maxAgeMs, owner, repo }),
            parse: (output) => parseGitHubPullRequest(output, ignoredChecks()),
        });
        if (!parsed) return emptyGitHubLoad();
        parsed.pullRequest = dependencies.emptyCheckRollups.settle(
            parsed.pullRequest,
            dependencies.now(),
        );
        /**
         * Both readers work from the same already-fetched body, and neither blocks the other: a Linear outage must not
         * hide the acceptance verdict, and an `lh` that is not installed must not hide the linked issues.
         */
        const [linear, acceptance, pullRequest] = await Promise.all([
            loadPullRequestLinearIssues(dependencies.linear, cwd, parsed.body, {
                isForced,
                onParseFailure: (error) => onParseFailure('linear', error),
            }),
            loadPullRequestAcceptances(dependencies.acceptance, cwd, parsed.body, {
                isForced,
                onParseFailure: (error) => onParseFailure('lh', error),
            }),
            dependencies.extras.attach(cwd, context, parsed.pullRequest, {
                ignoredChecks: ignoredChecks(),
                isForced,
            }),
        ]);
        return {
            pullRequest,
            mergeCommit: parsed.mergeCommit,
            linearIssues: linear.issues,
            acceptances: acceptance.acceptances,
            errors: [
                ...(linear.error ? [linear.error] : []),
                ...(acceptance.error ? [acceptance.error] : []),
            ],
        };
    } catch (error) {
        if (isNoPullRequest(error)) return emptyGitHubLoad();
        onParseFailure('gh', error);
        return failedGitHubLoad(error);
    }
}
