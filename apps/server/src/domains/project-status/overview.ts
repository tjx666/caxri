import type { ProjectStatusOverview } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { parseGitHubRemote } from '@caxri/utils';
import { ProjectStatusSummaryErrorMessage as statusError } from 'caxri';

import type { AcceptanceStore, GitHubPullRequestStore, LinearIssueStore } from '../external-status';
import type { GitService } from '../git';
import type { SessionTranscriptContext } from '../session';
import { loadOverviewAcceptances } from './acceptance';
import type { RepoRemoteCache } from './branch';
import { loadOverviewLinearIssues } from './linear';
import type { ProjectStatusServiceOptions } from './options';
import type { SessionPullRequestResolver } from './session-pull-request';
import { loadOverviewPullRequest } from './session-pull-request';

/**
 * What the status bar's overview needs from `ProjectStatusService`: the same shared stores the Status panel reads, so
 * an overview and a panel refresh of one Session join one fetch per source.
 */
export interface OverviewSources {
    acceptance: AcceptanceStore;
    git: Pick<GitService, 'summary'>;
    github: GitHubPullRequestStore;
    ignoredChecks: readonly string[];
    linear: LinearIssueStore;
    logger: StructuredLogger;
    now: () => number;
    readGit: Parameters<RepoRemoteCache['read']>[1];
    remotes: RepoRemoteCache;
    resolver?: SessionPullRequestResolver;
    sessionContext?: ProjectStatusServiceOptions['sessionContext'];
}

/**
 * What this Session's own Agent conversation named. Read once per overview and handed to both chips:
 * `SessionContextService` scans incrementally and shares the in-flight read, but asking it twice still costs a second
 * pass over everything the Agent appended.
 */
async function readConversation(
    sources: OverviewSources,
    sessionId: string,
): Promise<SessionTranscriptContext | undefined> {
    try {
        return await sources.sessionContext?.(sessionId);
    } catch {
        // The conversation is the weakest source either chip has, so an unreadable transcript degrades to "no extra
        // context" rather than failing the overview the status bar draws from.
        return undefined;
    }
}

/**
 * The primary repository's branch, pull request, Linear issues, and Acceptance rounds for the status bar.
 */
export async function loadProjectStatusOverview(
    sources: OverviewSources,
    sessionId: string,
): Promise<ProjectStatusOverview> {
    const { now } = sources;
    const gitSummary = await sources.git.summary(sessionId, 0, 'projectStatus');
    if (!gitSummary.isRepository) {
        return { refreshedAt: now(), error: gitSummary.error };
    }
    const repo = gitSummary.repositories.find((candidate) => candidate.kind === 'primary');
    if (!repo) return { refreshedAt: now(), error: statusError.missingPrimaryRepository };
    const { remote } = await sources.remotes.read(repo.rootPath, sources.readGit);
    const github = parseGitHubRemote(remote);
    const githubUrl = github ? `https://github.com/${github.owner}/${github.repo}` : undefined;
    // Independent reads; both usually join the same in-flight transcript pass in `SessionContextService`.
    const [{ pullRequest, pullRequestBody, pullRequestUnavailable }, conversation] =
        await Promise.all([
            loadOverviewPullRequest(sources.github, sources.logger, {
                github,
                ignoredChecks: sources.ignoredChecks,
                repo,
                resolver: sources.resolver,
                sessionId,
            }),
            readConversation(sources, sessionId),
        ]);
    const [linearIssues, acceptances] = await Promise.all([
        loadOverviewLinearIssues(sources.linear, repo.rootPath, {
            branch: repo.branch,
            conversation: conversation?.linearReferences ?? [],
            pullRequestBody,
        }),
        loadOverviewAcceptances(sources.acceptance, repo.rootPath, {
            conversation: conversation?.acceptanceReferences ?? [],
            pullRequestBody,
        }),
    ]);
    return {
        repository: {
            id: repo.id,
            branch: repo.branch,
            branchUrl: githubUrl
                ? `${githubUrl}/tree/${encodeURIComponent(repo.branch)}`
                : undefined,
            changedFileCount: repo.files.length,
            additions: repo.additions,
            deletions: repo.deletions,
            pullRequest,
            ...(pullRequestUnavailable && { pullRequestUnavailable }),
            linearIssues,
            acceptances,
        },
        refreshedAt: now(),
    };
}
