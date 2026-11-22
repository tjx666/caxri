import { homedir } from 'node:os';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../../db';
import type { ExternalStatusRunner } from '../../external-status';
import {
    fetchPullRequestOutcomes,
    isRefreshDue,
    MAX_PULL_REQUESTS_PER_PASS,
} from '../pull-requests';
import type { OutsideUsageEntry, UsageLedgerEntry } from '../report';

/**
 * Resolves the outcomes of the pull requests the usage ledger mentions in the background, so a report never waits on
 * `gh`. At most one pass runs; the next report picks up whatever it stored.
 */
export class PullRequestPass {
    private running?: Promise<void>;

    constructor(
        private readonly options: {
            database: Pick<CaxriDatabase, 'agentSessionUsage'>;
            logger: StructuredLogger;
            runner: ExternalStatusRunner;
            now: () => number;
        },
    ) {}

    private async run(urls: readonly string[]): Promise<void> {
        const { database, logger, runner } = this.options;
        const startedAt = performance.now();
        try {
            const counts = await fetchPullRequestOutcomes(
                urls.slice(0, MAX_PULL_REQUESTS_PER_PASS),
                runner,
                homedir(),
                (row) => database.agentSessionUsage.savePullRequestOutcome(row),
                () => this.options.now(),
            );
            logger.write('debug', logEventCatalog.usage.pullRequests, {
                durationMs: performance.now() - startedAt,
                fields: { pending: urls.length, ...counts },
            });
        } catch {
            // Only the outcome store can throw here; the next report retries every URL still pending.
            logger.write('warn', logEventCatalog.usage.pullRequests, {
                durationMs: performance.now() - startedAt,
                fields: { pending: urls.length, reason: 'store-failed' },
            });
        } finally {
            this.running = undefined;
        }
    }

    /**
     * Starts a pass over the pull requests the entries mention whose outcome is due for a refresh; a no-op while one
     * runs or when none is due.
     */
    schedule(entries: ReadonlyArray<UsageLedgerEntry | OutsideUsageEntry>): void {
        if (this.running) return;
        const { database } = this.options;
        const now = this.options.now();
        const known = new Map(
            database.agentSessionUsage.listPullRequestOutcomes().map((row) => [row.url, row]),
        );
        const urls = [
            ...new Set(entries.flatMap(({ record }) => record?.pullRequests ?? [])),
        ].filter((url) => isRefreshDue(known.get(url), now));
        if (urls.length === 0) return;
        this.running = this.run(urls);
    }
}
