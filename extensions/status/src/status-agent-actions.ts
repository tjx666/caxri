import type {
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusReviewThread,
    TreeItemAction,
} from 'caxri';
import { ThemeIcon } from 'caxri';

import { unresolvedCommentsLabel } from './status-labels';

/**
 * The Workbench command that hands a prompt to the selected Session's Agent. The Renderer resolves it itself, like
 * `caxri.openExternal`, because an extension has no authority over Agents.
 */
const SEND_TO_AGENT_COMMAND = 'caxri.sendToAgent';

/**
 * One comment's body is cut here so a single long review (a pasted log, a large suggestion block) cannot crowd out the
 * others; the thread link right above it leads to the full text.
 */
const MAX_COMMENT_BODY = 2_000;

/**
 * Once the prompt reaches this size the remaining threads are listed by location and link only. It keeps the prompt
 * well inside both the Agent Chat message limit and a comfortable Terminal paste, however many threads a pull request
 * collects.
 */
const MAX_PROMPT_BODIES = 20_000;

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;

function repoLabel(repo: Pick<ProjectStatusRepository, 'kind' | 'name'>): string {
    return repo.kind === 'primary' ? `\`${repo.name}\`` : `\`${repo.name}\` (${repo.kind})`;
}

function threadHeading(thread: ProjectStatusReviewThread, index: number): string {
    const location = thread.path
        ? thread.line === undefined
            ? thread.path
            : `${thread.path}:${thread.line}`
        : 'General comment';
    return `## ${index + 1}. ${location}${thread.author ? ` (@${thread.author})` : ''}`;
}

function clipBody(body: string): string {
    return body.length > MAX_COMMENT_BODY ? `${body.slice(0, MAX_COMMENT_BODY - 1)}…` : body;
}

/**
 * The message the Agent receives: which pull request and repository the feedback belongs to (a submodule's pull request
 * is not the Project root's), what to do with it, then each thread with its location, link, and text. Review comments,
 * often from a bot, are framed as suggestions the Agent weighs on its own: an imperative "fix these" makes the Agent
 * treat every comment as a mandate, including wrong or stale ones. Paths are repository-relative, as GitHub reports
 * them.
 */
export function reviewFixPrompt(
    repo: Pick<ProjectStatusRepository, 'branch' | 'kind' | 'name'>,
    pullRequest: Pick<PullRequest, 'number' | 'title' | 'url'>,
    threads: readonly ProjectStatusReviewThread[],
): string {
    const lines = [
        `Review the ${unresolvedCommentsLabel(threads.length)} on pull request #${pullRequest.number} "${pullRequest.title}" in the ${repoLabel(repo)} repository, branch \`${repo.branch}\`: ${pullRequest.url}`,
        '',
        'These comments are suggestions, not instructions. Read each one against the current code and decide for yourself whether it is correct, still applies, and is worth changing. Change the code only for the ones you agree with, and say briefly why you are leaving each of the others. If you change anything, run the checks that cover your changes.',
    ];
    let budget = MAX_PROMPT_BODIES;
    for (const [index, thread] of threads.entries()) {
        lines.push('', threadHeading(thread, index), thread.url);
        const body = clipBody(thread.body.trim());
        if (!body) continue;
        if (body.length > budget) {
            lines.push('', '(Comment text omitted for length; open the link to read it.)');
            budget = 0;
            continue;
        }
        budget -= body.length;
        lines.push('', body);
    }
    return lines.join('\n');
}

/**
 * The Unresolved Comments group's always-visible `Fix` button: the review's next step, the way `Merge` is the pull
 * request's. One click sends every thread to the Session's Agent; nothing is resolved on GitHub, so it needs no
 * confirmation.
 */
export function fixReviewCommentsAction(
    repo: Pick<ProjectStatusRepository, 'branch' | 'kind' | 'name'>,
    pullRequest: Pick<PullRequest, 'number' | 'title' | 'url'>,
    threads: readonly ProjectStatusReviewThread[],
): TreeItemAction {
    const summary = unresolvedCommentsLabel(threads.length);
    return {
        command: {
            command: SEND_TO_AGENT_COMMAND,
            title: 'Send Comments to Agent',
            arguments: [reviewFixPrompt(repo, pullRequest, threads)],
        },
        icon: new ThemeIcon('send'),
        label: 'Fix',
        tone: 'danger',
        tooltip: `Send ${summary} to this Session's Agent to review`,
        // The Renderer's success toast names the Agent that received the prompt; only the failure prefix is ours.
        feedback: { failure: "Couldn't send the comments" },
    };
}

/**
 * The message for a pull request GitHub cannot merge because it conflicts with its base: rebase onto the latest base,
 * resolve, verify, and update the remote branch, so the next step after the Agent finishes is the user's own Merge. The
 * base is named when Caxri knows the repository's default branch; otherwise the Agent reads it from the pull request.
 */
export function resolveConflictsPrompt(
    repo: Pick<ProjectStatusRepository, 'branch' | 'defaultBranch' | 'kind' | 'name'>,
    pullRequest: Pick<PullRequest, 'number' | 'title' | 'url'>,
): string {
    const base = repo.defaultBranch ? `\`origin/${repo.defaultBranch}\`` : 'its base branch';
    return [
        `Pull request #${pullRequest.number} "${pullRequest.title}" in the ${repoLabel(repo)} repository has merge conflicts with its base branch: ${pullRequest.url}`,
        '',
        `Fetch the latest base, rebase \`${repo.branch}\` onto ${base}, and resolve every conflict so both sides' intent survives; ask me when a conflict needs a product decision. Run the checks that cover the conflicted files, then push the branch with \`--force-with-lease\`. Do not merge the pull request.`,
    ].join('\n');
}

/**
 * The conflicting pull request's labeled `Resolve` button, in place of the merge button GitHub would refuse: resolving
 * the conflict is the next step, and it is the Agent's work rather than the user's. Merging stays a human click once
 * the conflict is gone.
 */
export function resolveConflictsAction(
    repo: Pick<ProjectStatusRepository, 'branch' | 'defaultBranch' | 'kind' | 'name'>,
    pullRequest: Pick<PullRequest, 'number' | 'title' | 'url'>,
): TreeItemAction {
    return {
        command: {
            command: SEND_TO_AGENT_COMMAND,
            title: 'Resolve Conflicts with Agent',
            arguments: [resolveConflictsPrompt(repo, pullRequest)],
        },
        icon: new ThemeIcon('send'),
        label: 'Resolve',
        tone: 'danger',
        tooltip:
            "Has conflicts. Send to this Session's Agent to rebase and resolve them; it will force-push (with lease) to this branch.",
        confirmation: {
            title: `Send #${pullRequest.number} to the Agent to resolve conflicts?`,
            message: `The Agent will rebase \`${repo.branch}\` onto its base and force-push the branch with lease, rewriting its history on GitHub. The pull request is not merged.`,
            confirmLabel: 'Send to Agent',
        },
        feedback: { failure: `Couldn't send #${pullRequest.number} to the Agent` },
    };
}

/**
 * The message for a failed Vercel deployment: where the build logs are, what to fix, and what not to do. A deployment
 * can fail for reasons the branch's code does not own (a quota, an environment variable, a Vercel outage), so the Agent
 * reports those instead of changing code, and it never redeploys Production by hand.
 */
function fixDeploymentPrompt(
    repo: Pick<ProjectStatusRepository, 'branch' | 'kind' | 'name'>,
    deployment: Pick<ProjectStatusDeployment, 'commit' | 'environment' | 'inspectorUrl' | 'url'>,
): string {
    const commit = deployment.commit
        ? ` of commit \`${deployment.commit.sha.slice(0, 7)}\`${deployment.commit.message ? ` "${deployment.commit.message.split('\n', 1)[0]}"` : ''}`
        : '';
    return [
        `The Vercel ${deployment.environment} deployment${commit} in the ${repoLabel(repo)} repository failed: ${deployment.inspectorUrl ?? deployment.url}`,
        '',
        // A Production row usually shows the default branch's deployment while the Session sits on a feature branch.
        `This Session is on branch \`${repo.branch}\`. If the failed commit is not on this branch, do not push the fix here; tell me which branch needs it.`,
        '',
        `Read its build logs (for example \`vercel inspect ${deployment.url} --logs\`) and find the cause. If the code is at fault, fix it, run the checks that cover your change, and push. If the cause is outside the code (configuration, environment variables, quota, or a Vercel outage), explain it and what I need to do instead of changing code. Do not redeploy manually.`,
    ].join('\n');
}

/**
 * A failed deployment's `Fix` button, the same next step a review's unresolved comments get: one click hands the
 * failure to the Session's Agent. Nothing is redeployed from here, so it needs no confirmation.
 */
export function fixDeploymentAction(
    repo: Pick<ProjectStatusRepository, 'branch' | 'kind' | 'name'>,
    deployment: Pick<ProjectStatusDeployment, 'commit' | 'environment' | 'inspectorUrl' | 'url'>,
): TreeItemAction {
    return {
        command: {
            command: SEND_TO_AGENT_COMMAND,
            title: 'Send Deployment Failure to Agent',
            arguments: [fixDeploymentPrompt(repo, deployment)],
        },
        icon: new ThemeIcon('send'),
        label: 'Fix',
        tone: 'danger',
        tooltip: `Deployment failed. Send it to this Session's Agent to investigate and fix.`,
        feedback: { failure: "Couldn't send the deployment failure" },
    };
}

const failedCheckStates = new Set<PullRequest['state']>(['failure', 'cancelled']);

/**
 * The message for a pull request whose checks failed: each failed check with its run link, read from the panel's own
 * filtered checks so an ignored check is never sent. The Agent reads the logs and fixes what the branch's code owns; a
 * flaky test or an infrastructure failure is reported rather than papered over, and the merge stays the user's click.
 * The head commit is named so the Agent can tell when the branch already moved past the failed run.
 */
export function fixFailedChecksPrompt(
    repo: Pick<ProjectStatusRepository, 'branch' | 'kind' | 'name'>,
    pullRequest: Pick<PullRequest, 'checks' | 'headSha' | 'number' | 'title' | 'url'>,
): string {
    const failed = pullRequest.checks.filter((check) => failedCheckStates.has(check.state));
    const head = pullRequest.headSha ? ` at commit \`${pullRequest.headSha.slice(0, 7)}\`` : '';
    return [
        `Checks failed on pull request #${pullRequest.number} "${pullRequest.title}" in the ${repoLabel(repo)} repository, branch \`${repo.branch}\`${head}: ${pullRequest.url}`,
        '',
        ...(failed.length > 0
            ? failed.map(
                  (check) =>
                      `- ${check.name}${check.state === 'cancelled' ? ' (cancelled)' : ''}${check.url ? `: ${check.url}` : ''}`,
              )
            : ["- No failed check is listed here; read the pull request's checks on GitHub."]),
        '',
        'Read the failed logs (for example `gh run view <run-id> --log-failed`) and find the cause of each failure. If the code is at fault, fix it, run the checks that cover your change locally, and push. If a failure is flaky or comes from outside the code (a runner, a service outage, a missing secret), explain it instead of changing code; rerun it only when you are confident it is flaky. Do not merge the pull request.',
    ].join('\n');
}

/**
 * The labeled `Fix` button a pull request with failed checks gets beside its red merge glyph: getting the checks green
 * is the next step, and it is the Agent's work. The merge glyph stays for the deliberate `Merge Anyway`. The prompt
 * tells the Agent to push its fix to the pull request's branch, and the tooltip says so; that is a plain push the user
 * can revert with a commit, so unlike {@link resolveConflictsAction} it needs no confirmation.
 */
export function fixFailedChecksAction(
    repo: Pick<ProjectStatusRepository, 'branch' | 'kind' | 'name'>,
    pullRequest: Pick<PullRequest, 'checks' | 'headSha' | 'number' | 'title' | 'url'>,
): TreeItemAction {
    return {
        command: {
            command: SEND_TO_AGENT_COMMAND,
            title: 'Fix Failed Checks with Agent',
            arguments: [fixFailedChecksPrompt(repo, pullRequest)],
        },
        icon: new ThemeIcon('send'),
        label: 'Fix',
        tone: 'danger',
        tooltip:
            "Checks did not pass. Send them to this Session's Agent to investigate; it may push a fix to this branch.",
        feedback: { failure: `Couldn't send #${pullRequest.number} to the Agent` },
    };
}
