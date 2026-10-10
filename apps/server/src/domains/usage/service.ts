import { homedir } from 'node:os';

import type { UsageReport, UsageReportParameters } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentEnvironment } from '../agents';
import type { AgentSessionUsageRow, CaxriDatabase } from '../db';
import type { ExternalStatusRunner } from '../external-status';
import { SingleFlight } from '../single-flight';
import { ModelPricing } from './pricing';
import {
    fetchPullRequestOutcomes,
    isRefreshDue,
    MAX_PULL_REQUESTS_PER_PASS,
} from './pull-requests';
import { parseUsageRecord } from './record';
import type { UsageLedgerEntry } from './report';
import { buildUsageReport } from './report';
import { scanUsage, UsageTranscriptLocator } from './scanner';

/**
 * Transcripts parsed concurrently during one ledger sync.
 */
const SCAN_CONCURRENCY = 4;

export interface UsageServiceOptions {
    database: CaxriDatabase;
    environment: AgentEnvironment;
    logger: StructuredLogger;
    runner: ExternalStatusRunner;
    userDataPath: string;
    fetch?: typeof fetch;
    now?: () => number;
}

type ScanOutcome = 'scanned' | 'unchanged' | 'unavailable' | 'failed';

/**
 * Owns the usage ledger: records Agent Session bindings, keeps each content-free usage aggregate in step with its
 * transcript files, resolves pull request outcomes in the background, and builds reports on demand. Nothing runs until
 * a Client asks for a report, so an unused Usage page costs nothing.
 */
export class UsageService {
    private readonly pricing: ModelPricing;
    private readonly syncs = new SingleFlight<'ledger', void>();
    private pullRequestPass?: Promise<void>;

    constructor(private readonly options: UsageServiceOptions) {
        this.pricing = new ModelPricing({
            userDataPath: options.userDataPath,
            fetch: options.fetch,
            now: options.now,
        });
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async loadPricing(): Promise<void> {
        const startedAt = performance.now();
        const previous = this.pricing.updatedAt;
        await this.pricing.ensureFresh();
        if (this.pricing.updatedAt !== previous)
            this.options.logger.write('info', logEventCatalog.usage.pricing, {
                durationMs: performance.now() - startedAt,
                fields: { source: this.pricing.source },
            });
    }

    /**
     * Copies current bindings into the ledger (covering any binding recorded before the ledger existed), then rescans
     * exactly the rows whose transcript fingerprint changed. A transcript the provider already pruned keeps its last
     * aggregate.
     */
    private async syncLedger(): Promise<void> {
        const startedAt = performance.now();
        const { database, environment, logger } = this.options;
        database.agentSessionUsage.recordBindings(undefined, this.now());
        const rows = database.agentSessionUsage.list();
        const locator = new UsageTranscriptLocator(environment);
        const outcomes: Record<ScanOutcome, number> = {
            scanned: 0,
            unchanged: 0,
            unavailable: 0,
            failed: 0,
        };
        const queue = [...rows];
        const worker = async () => {
            for (let row = queue.shift(); row; row = queue.shift()) {
                // eslint-disable-next-line no-await-in-loop -- each worker parses one transcript at a time
                outcomes[await this.syncRow(row, locator)] += 1;
            }
        };
        await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
        logger.write(outcomes.failed > 0 ? 'warn' : 'debug', logEventCatalog.usage.scan, {
            durationMs: performance.now() - startedAt,
            fields: { rows: rows.length, ...outcomes },
        });
    }

    private async syncRow(
        row: AgentSessionUsageRow,
        locator: UsageTranscriptLocator,
    ): Promise<ScanOutcome> {
        try {
            const files = await locator.locate(row);
            if (!files) return 'unavailable';
            if (files.fingerprint === row.sourceFingerprint && row.usageJson) return 'unchanged';
            const record = await scanUsage(row.provider, files);
            this.options.database.agentSessionUsage.saveScan(row.provider, row.agentSessionId, {
                sourceFingerprint: files.fingerprint,
                scannedAt: this.now(),
                usageJson: JSON.stringify(record),
            });
            return 'scanned';
        } catch {
            return 'failed';
        }
    }

    /**
     * Starts at most one background pass; the next report picks up whatever it stored.
     */
    private schedulePullRequestPass(entries: readonly UsageLedgerEntry[]): void {
        if (this.pullRequestPass) return;
        const { database } = this.options;
        const now = this.now();
        const known = new Map(
            database.agentSessionUsage.listPullRequestOutcomes().map((row) => [row.url, row]),
        );
        const urls = [
            ...new Set(entries.flatMap(({ record }) => record?.pullRequests ?? [])),
        ].filter((url) => isRefreshDue(known.get(url), now));
        if (urls.length === 0) return;
        this.pullRequestPass = this.runPullRequestPass(urls);
    }

    private async runPullRequestPass(urls: readonly string[]): Promise<void> {
        const { database, logger, runner } = this.options;
        const startedAt = performance.now();
        try {
            const counts = await fetchPullRequestOutcomes(
                urls.slice(0, MAX_PULL_REQUESTS_PER_PASS),
                runner,
                homedir(),
                (row) => database.agentSessionUsage.savePullRequestOutcome(row),
                () => this.now(),
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
            this.pullRequestPass = undefined;
        }
    }

    async report(parameters: UsageReportParameters): Promise<UsageReport> {
        await Promise.all([this.loadPricing(), this.syncs.run('ledger', () => this.syncLedger())]);
        const { database } = this.options;
        const entries: UsageLedgerEntry[] = database.agentSessionUsage
            .list()
            .map((row) => ({ row, record: parseUsageRecord(row.usageJson) }));
        const pullRequests = database.agentSessionUsage.listPullRequestOutcomes();
        this.schedulePullRequestPass(entries);
        return buildUsageReport({
            params: parameters,
            now: this.now(),
            entries,
            sessions: database.listSessions(),
            projects: database.listProjects(),
            pullRequests,
            priceOf: (model) => this.pricing.priceOf(model),
            pricing: { source: this.pricing.source, updatedAt: this.pricing.updatedAt },
        });
    }
}
