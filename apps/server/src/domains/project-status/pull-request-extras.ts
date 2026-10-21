import type { ProjectStatusRepository } from '@caxri/protocol';

import type { ExternalStatusCommandTelemetry, ExternalStatusRunner } from '../external-status';
import { MergeMethodStore } from './merge-method';
import { PreviousChecksStore } from './previous-checks';
import { ReviewThreadStore } from './review-threads';

type PullRequest = ProjectStatusRepository['pullRequest'];

/**
 * The extra GitHub reads layered onto an already-fetched pull request: its unresolved review threads and Codex summary,
 * the previous commit's check verdict while the head's checks are unfinished or failing, then the merge method a merge
 * would use. Each store degrades to the bare pull request on failure.
 */
export class PullRequestExtras {
    private readonly reviewThreads: ReviewThreadStore;
    private readonly mergeMethods: MergeMethodStore;
    private readonly previousChecks: PreviousChecksStore;

    constructor(
        telemetry: Pick<ExternalStatusCommandTelemetry, 'observe' | 'recordParseFailure'>,
        runner: ExternalStatusRunner,
        now: () => number,
    ) {
        this.reviewThreads = new ReviewThreadStore(telemetry, runner);
        this.mergeMethods = new MergeMethodStore(telemetry, runner, { now });
        this.previousChecks = new PreviousChecksStore(telemetry, runner, { now });
    }

    /**
     * Returns the pull request with its review threads, the previous check verdict when the head's checks are not
     * green, and, when open, the merge method a merge would use. The previous verdict is read beside the threads rather
     * than after them, so neither GitHub round trip waits on the other.
     */
    async attach(
        cwd: string,
        context: { owner?: string; repo?: string },
        pullRequest: PullRequest,
        options: { ignoredChecks: readonly string[]; isForced: boolean },
    ): Promise<PullRequest> {
        const { ignoredChecks, isForced } = options;
        const [threaded, previous] = await Promise.all([
            this.reviewThreads.attach(cwd, context, pullRequest, isForced),
            this.previousChecks.attach(cwd, context, pullRequest, ignoredChecks, isForced),
        ]);
        const combined =
            threaded && previous?.previousChecks
                ? { ...threaded, previousChecks: previous.previousChecks }
                : threaded;
        return this.mergeMethods.attach(cwd, context, combined, isForced);
    }
}
