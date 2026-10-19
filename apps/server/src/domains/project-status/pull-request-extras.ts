import type { ProjectStatusRepository } from '@caxri/protocol';

import type { ExternalStatusCommandTelemetry, ExternalStatusRunner } from '../external-status';
import { MergeMethodStore } from './merge-method';
import { ReviewThreadStore } from './review-threads';

type PullRequest = ProjectStatusRepository['pullRequest'];

/**
 * The extra GitHub reads layered onto an already-fetched pull request: its unresolved review threads and Codex summary,
 * then the merge method a merge would use. Each store degrades to the bare pull request on failure.
 */
export class PullRequestExtras {
    private readonly reviewThreads: ReviewThreadStore;
    private readonly mergeMethods: MergeMethodStore;

    constructor(
        telemetry: Pick<ExternalStatusCommandTelemetry, 'observe' | 'recordParseFailure'>,
        runner: ExternalStatusRunner,
        now: () => number,
    ) {
        this.reviewThreads = new ReviewThreadStore(telemetry, runner);
        this.mergeMethods = new MergeMethodStore(telemetry, runner, { now });
    }

    /**
     * Returns the pull request with its review threads and, when open, the merge method a merge would use.
     */
    async attach(
        cwd: string,
        context: { owner?: string; repo?: string },
        pullRequest: PullRequest,
        isForced: boolean,
    ): Promise<PullRequest> {
        const threaded = await this.reviewThreads.attach(cwd, context, pullRequest, isForced);
        return this.mergeMethods.attach(cwd, context, threaded, isForced);
    }
}
