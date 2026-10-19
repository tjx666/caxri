import type { ProjectStatusRepository } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import type { ExternalStatusCommandTelemetry, ExternalStatusRunner } from '../external-status';
import { parseExternalJson } from '../external-status';
import type { PullRequestMergeMethod as MergeMethod } from '../external-status/merge-method';
import {
    chooseMergeMethod,
    REPO_MERGE_SETTINGS_FIELDS,
    repoMergeSettingsSchema,
} from '../external-status/merge-method';
import { SingleFlight } from '../single-flight';

type PullRequest = ProjectStatusRepository['pullRequest'];

/**
 * Repository merge settings change rarely and only by an admin visiting GitHub's settings page, so a long TTL keeps
 * this to roughly one `gh repo view` per repository per quarter hour; an explicit user refresh bypasses it.
 */
const RECORD_TTL_MS = 15 * 60_000;
const MAX_RECORDS = 64;

/**
 * Which merge method `git.mergePullRequest` will use for a repository, read ahead of the click so the Status panel's
 * merge button and confirmation can name it. It shares {@link chooseMergeMethod} with the merge itself, so the preview
 * and the merge cannot pick differently from the same settings. A failed read is never cached and never surfaces as an
 * error row: the pull request simply goes out without a method and the panel falls back to stating the selection
 * order.
 */
export class MergeMethodStore {
    private readonly records = new Map<
        string,
        { fetchedAt: number; method: MergeMethod | undefined }
    >();
    private readonly requests = new SingleFlight<string, MergeMethod | undefined>();

    constructor(
        private readonly telemetry: Pick<
            ExternalStatusCommandTelemetry,
            'observe' | 'recordParseFailure'
        >,
        private readonly runner: ExternalStatusRunner,
        private readonly options: { now?: () => number; ttlMs?: number } = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async method(
        cwd: string,
        slug: string,
        maxAgeMs: number | undefined,
    ): Promise<MergeMethod | undefined> {
        const cached = this.records.get(slug);
        const ttl = maxAgeMs ?? this.options.ttlMs ?? RECORD_TTL_MS;
        if (cached && this.now() - cached.fetchedAt < ttl) return cached.method;
        return this.requests.run(slug, async () => {
            const arguments_ = ['repo', 'view', slug, '--json', REPO_MERGE_SETTINGS_FIELDS];
            const output = await this.telemetry.observe({
                command: 'gh',
                arguments: arguments_,
                run: () => this.runner('gh', arguments_, cwd),
            });
            const method = chooseMergeMethod(
                parseExternalJson(output, repoMergeSettingsSchema, 'GitHub repository settings'),
            );
            rememberBounded(this.records, slug, { fetchedAt: this.now(), method }, MAX_RECORDS);
            return method;
        });
    }

    /**
     * Returns the open pull request with the method a merge would use. Only an open pull request can be merged from the
     * panel, so any other lifecycle spends no query.
     */
    async attach(
        cwd: string,
        context: { owner?: string; repo?: string },
        pullRequest: PullRequest,
        isForced: boolean,
    ): Promise<PullRequest> {
        if (pullRequest?.lifecycle !== 'open' || !context.owner || !context.repo)
            return pullRequest;
        try {
            const method = await this.method(
                cwd,
                `${context.owner}/${context.repo}`,
                isForced ? 0 : undefined,
            );
            return method !== undefined ? { ...pullRequest, mergeMethod: method } : pullRequest;
        } catch (error) {
            this.telemetry.recordParseFailure('gh', error);
            return pullRequest;
        }
    }
}
