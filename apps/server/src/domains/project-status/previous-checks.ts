import type { ProjectStatusPreviousChecks, ProjectStatusRepository } from '@caxri/protocol';
import { isIgnoredCheck } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import type { ExternalStatusCommandTelemetry, ExternalStatusRunner } from '../external-status';
import { parseExternalJson } from '../external-status';
import type { GitHubCheck } from './parse';
import { aggregateChecks, checkState } from './parse';

type PullRequest = ProjectStatusRepository['pullRequest'];

/**
 * The head plus this many earlier commits. A verdict further back than ten commits says little about the head, and a
 * longer window multiplies the per-commit check contexts the query reads.
 */
const COMMIT_WINDOW = 11;
/**
 * One commit's checks rarely exceed this; the head's own list comes from `gh pr view`, which has the same practical
 * ceiling.
 */
const CONTEXT_PAGE_SIZE = 100;
/**
 * Matches the pull-request store's TTL (`external-status/github.ts`) for a selection that skipped a commit still
 * running: that commit may settle and become the better answer.
 */
const UNSETTLED_TTL_MS = 90_000;
const MAX_RECORDS = 128;

/**
 * `statusCheckRollup` on each recent commit, with only the fields `checkState` and `isIgnoredCheck` read. Check runs
 * carry their workflow name through the check suite, the same name `gh pr view` reports as `workflowName`.
 *
 * @see https://docs.github.com/en/graphql/reference/objects#statuscheckrollup
 */
const PREVIOUS_CHECKS_QUERY = `query PreviousChecks($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:${COMMIT_WINDOW}){nodes{commit{oid messageHeadline statusCheckRollup{contexts(first:${CONTEXT_PAGE_SIZE}){nodes{__typename ... on CheckRun{name status conclusion checkSuite{workflowRun{workflow{name}}}} ... on StatusContext{context state}}}}}}}}}}`;

const workflowSchema = z.object({ name: z.string().nullish() });
const workflowRunSchema = z.object({ workflow: workflowSchema.nullish() });

const contextSchema = z.object({
    __typename: z.string().optional(),
    name: z.string().nullish(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    context: z.string().nullish(),
    state: z.string().nullish(),
    checkSuite: z.object({ workflowRun: workflowRunSchema.nullish() }).nullish(),
});

const contextsSchema = z.object({ nodes: z.array(contextSchema.nullable()) });
const rollupSchema = z.object({ contexts: contextsSchema });

const commitSchema = z.object({
    oid: z.string(),
    messageHeadline: z.string().nullish(),
    statusCheckRollup: rollupSchema.nullish(),
});

const commitNodeSchema = z.object({ commit: commitSchema });
const commitsSchema = z.object({ nodes: z.array(commitNodeSchema.nullable()) });
const pullRequestSchema = z.object({ commits: commitsSchema });
const repoSchema = z.object({ pullRequest: pullRequestSchema.nullable() });

const responseSchema = z.object({
    data: z.object({ repository: repoSchema.nullable() }),
});

const compareSchema = z.array(
    z.object({
        path: z.string().min(1),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
    }),
);

/**
 * The commit chosen by {@link selectPreviousChecks}, before the files changed since it are attached.
 */
export interface PreviousChecksSelection {
    oid: string;
    title: string;
    state: ProjectStatusPreviousChecks['state'];
    commitsBefore: number;
}

/**
 * Walks back from the head to the newest commit whose visible checks reached a verdict. A commit with no checks (an
 * intermediate commit of a multi-commit push), only cancelled checks (superseded by a later push), or checks still
 * running is skipped. `isSettled` is false when a running commit was skipped or the list does not end at `headSha`: the
 * answer may still change for the same head, so it must not be kept for the head's lifetime.
 */
export function selectPreviousChecks(
    output: string,
    headSha: string,
    ignoredChecks: readonly string[],
): { selection?: PreviousChecksSelection; isSettled: boolean } {
    const response = parseExternalJson(output, responseSchema, 'GitHub pull request commits');
    const commits = (response.data.repository?.pullRequest?.commits.nodes ?? []).flatMap((node) =>
        node ? [node.commit] : [],
    );
    if (commits.at(-1)?.oid !== headSha) return { isSettled: false };
    let isSettled = true;
    for (let index = commits.length - 2; index >= 0; index--) {
        const commit = commits[index];
        const checks = (commit.statusCheckRollup?.contexts.nodes ?? []).flatMap((node) => {
            if (!node) return [];
            const check: GitHubCheck = {
                name: node.name ?? undefined,
                status: node.status,
                conclusion: node.conclusion,
                context: node.context ?? undefined,
                state: node.state,
                workflowName: node.checkSuite?.workflowRun?.workflow?.name ?? undefined,
            };
            if (isIgnoredCheck([check.name, check.context, check.workflowName], ignoredChecks))
                return [];
            return [{ name: check.name ?? check.context ?? '?', state: checkState(check) }];
        });
        if (checks.length === 0) continue;
        const state = aggregateChecks(checks);
        if (state === 'pending' || state === 'queued') {
            isSettled = false;
            continue;
        }
        if (state !== 'success' && state !== 'failure') continue;
        return {
            selection: {
                oid: commit.oid,
                // GitHub sends an empty headline for an empty commit message; a short hash is the only name left.
                title: commit.messageHeadline?.trim()
                    ? commit.messageHeadline.trim()
                    : commit.oid.slice(0, 7),
                state,
                commitsBefore: commits.length - 1 - index,
            },
            isSettled,
        };
    }
    return { isSettled };
}

interface StoredRecord {
    fetchedAt: number;
    isSettled: boolean;
    previous: ProjectStatusPreviousChecks | undefined;
}

/**
 * The previous verdict for a pull request whose head checks are unfinished or failing, for the Status panel.
 *
 * Read only in that state, so a green pull request spends nothing. A settled answer is keyed by the head commit and the
 * ignored-check rules and kept until the head moves: earlier commits' verdicts do not change, so polling a long CI run
 * costs one GraphQL query and one REST compare in total. The files changed since that commit come from the REST compare
 * endpoint, which draws on a budget separate from GraphQL. A failed read is never cached.
 */
export class PreviousChecksStore {
    private readonly records = new Map<string, StoredRecord>();
    private readonly requests = new SingleFlight<string, StoredRecord>();

    constructor(
        private readonly telemetry: Pick<
            ExternalStatusCommandTelemetry,
            'observe' | 'recordParseFailure'
        >,
        private readonly runner: ExternalStatusRunner,
        private readonly options: { now?: () => number } = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async gh(cwd: string, arguments_: string[]): Promise<string> {
        return this.telemetry.observe({
            command: 'gh',
            arguments: arguments_,
            run: () => this.runner('gh', arguments_, cwd),
        });
    }

    private async changedFiles(
        cwd: string,
        slug: { owner: string; repo: string },
        base: string,
        head: string,
    ): Promise<ProjectStatusPreviousChecks['changedFiles']> {
        try {
            const output = await this.gh(cwd, [
                'api',
                '--hostname',
                'github.com',
                `repos/${slug.owner}/${slug.repo}/compare/${base}...${head}`,
                '--jq',
                '[.files[]? | {path: .filename, additions, deletions}]',
            ]);
            return parseExternalJson(output, compareSchema, 'GitHub commit comparison');
        } catch (error) {
            // The verdict alone is still worth showing; the row just omits what changed since.
            this.telemetry.recordParseFailure('gh', error);
            return undefined;
        }
    }

    private async read(
        cwd: string,
        slug: { owner: string; repo: string; number: number; url: string; headSha: string },
        ignoredChecks: readonly string[],
        isForced: boolean,
    ): Promise<ProjectStatusPreviousChecks | undefined> {
        const key = `${slug.owner}/${slug.repo}#${slug.number}@${slug.headSha}:${JSON.stringify(ignoredChecks)}`;
        const cached = this.records.get(key);
        if (
            cached &&
            !isForced &&
            (cached.isSettled || this.now() - cached.fetchedAt < UNSETTLED_TTL_MS)
        )
            return cached.previous;
        const record = await this.requests.run(key, async () => {
            const output = await this.gh(cwd, [
                'api',
                'graphql',
                '--hostname',
                'github.com',
                '--raw-field',
                `query=${PREVIOUS_CHECKS_QUERY}`,
                '--raw-field',
                `owner=${slug.owner}`,
                '--raw-field',
                `name=${slug.repo}`,
                // `--field` (not `--raw-field`) so `gh` sends the number as the `Int!` the query declares.
                '--field',
                `number=${slug.number}`,
            ]);
            const { selection, isSettled } = selectPreviousChecks(
                output,
                slug.headSha,
                ignoredChecks,
            );
            const changedFiles =
                selection && (await this.changedFiles(cwd, slug, selection.oid, slug.headSha));
            const previous: ProjectStatusPreviousChecks | undefined = selection && {
                title: selection.title,
                state: selection.state,
                commitsBefore: selection.commitsBefore,
                url: `${slug.url}/commits/${selection.oid}`,
                ...(changedFiles && { changedFiles }),
            };
            const stored = {
                fetchedAt: this.now(),
                // A missing comparison is retried with the next unsettled refresh instead of being kept for the head.
                isSettled: isSettled && (!previous || previous.changedFiles !== undefined),
                previous,
            };
            rememberBounded(this.records, key, stored, MAX_RECORDS);
            return stored;
        });
        return record.previous;
    }

    /**
     * Returns the pull request with `previousChecks` attached when its head checks are unfinished or failing. Any other
     * pull request, and a failed read, is returned unchanged: the head's checks are already shown, and the telemetry
     * has recorded the cause.
     */
    async attach(
        cwd: string,
        context: { owner?: string; repo?: string },
        pullRequest: PullRequest,
        ignoredChecks: readonly string[],
        isForced: boolean,
    ): Promise<PullRequest> {
        if (!pullRequest?.headSha || !context.owner || !context.repo) return pullRequest;
        if (pullRequest.lifecycle !== 'open' && pullRequest.lifecycle !== 'draft')
            return pullRequest;
        if (pullRequest.state === 'success' || pullRequest.state === 'neutral') return pullRequest;
        try {
            const previous = await this.read(
                cwd,
                {
                    owner: context.owner,
                    repo: context.repo,
                    number: pullRequest.number,
                    url: pullRequest.url,
                    headSha: pullRequest.headSha,
                },
                ignoredChecks,
                isForced,
            );
            return previous ? { ...pullRequest, previousChecks: previous } : pullRequest;
        } catch (error) {
            this.telemetry.recordParseFailure('gh', error);
            return pullRequest;
        }
    }
}
