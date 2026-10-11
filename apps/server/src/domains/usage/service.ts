import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import type { UsageReport, UsageReportParameters } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { mapWithConcurrency } from '@caxri/system';

import type { AgentEnvironment } from '../agents';
import type { AgentSessionUsageRow, CaxriDatabase, ExternalAgentUsageRow } from '../db';
import type { ExternalStatusRunner } from '../external-status';
import { SingleFlight } from '../single-flight';
import type { DiscoveredTranscript } from './external';
import { discoverTranscripts, readTranscriptCwd } from './external';
import { ModelPricing } from './pricing';
import {
    fetchPullRequestOutcomes,
    isRefreshDue,
    MAX_PULL_REQUESTS_PER_PASS,
} from './pull-requests';
import { parseUsageRecord } from './record';
import type { OutsideUsageEntry, UsageLedgerEntry, UsageReportInput } from './report';
import { buildUsageReport } from './report';
import type { UsageTranscriptFiles } from './scanner';
import { scanUsage, UsageTranscriptLocator } from './scanner';

/**
 * Transcripts parsed concurrently during one ledger sync.
 */
const SCAN_CONCURRENCY = 4;
/**
 * How long an `all` report waits for the outside-Caxri scan before answering with what is already cached. A first scan
 * of years of transcripts takes about a minute; later ones only stat files and finish well inside this budget.
 */
const OUTSIDE_SCAN_WAIT_MS = 1_000;

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

export interface DescribedTranscript {
    transcript: DiscoveredTranscript;
    files: UsageTranscriptFiles | undefined;
}

/**
 * Stats every outside transcript so the scan can order them newest first. A long history holds thousands of them, and
 * each describe walks the filesystem for side files, so the walks share the parse step's concurrency budget instead of
 * all starting at once.
 */
export function describeOutsideTranscripts(
    queue: readonly DiscoveredTranscript[],
    describe: UsageTranscriptLocator['describe'],
): Promise<DescribedTranscript[]> {
    return mapWithConcurrency(queue, SCAN_CONCURRENCY, async (transcript) => ({
        transcript,
        files: await describe(transcript.provider, transcript.main),
    }));
}

/**
 * Owns the usage ledger: records Agent Session bindings, keeps each content-free usage aggregate in step with its
 * transcript files, resolves pull request outcomes in the background, and builds reports on demand. Nothing runs until
 * a Client asks for a report, so an unused Usage page costs nothing.
 */
/**
 * Transcripts a report says are still being read. Discovery runs before the queue is counted, so a running scan reports
 * at least one: otherwise the page would read as finished and stop polling quickly while discovery is still walking a
 * large history.
 */
export function reportedPendingScans(isScanning: boolean, counted: number): number {
    return isScanning ? Math.max(1, counted) : 0;
}

export class UsageService {
    private readonly pricing: ModelPricing;
    private readonly syncs = new SingleFlight<'ledger' | 'outside', void>();
    private pullRequestPass?: Promise<void>;
    /**
     * Transcripts the running outside-Caxri scan has not reached yet.
     */
    private outsidePendingScans = 0;

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
     * Brings the cache of transcripts outside the ledger up to date, newest file first so recent days are accurate
     * soonest. Every finished file is stored immediately, so a report built mid-scan already includes it.
     */
    private async syncOutside(): Promise<void> {
        const startedAt = performance.now();
        const { database, environment, logger } = this.options;
        const hosted = new Set(
            database.agentSessionUsage.list().map((row) => `${row.provider}:${row.agentSessionId}`),
        );
        const cached = new Map(
            database.agentSessionUsage
                .listExternal()
                .map((row) => [`${row.provider}:${row.transcriptId}`, row]),
        );
        const discovered = await discoverTranscripts(environment);
        const queue = discovered.filter(
            (transcript) => !hosted.has(`${transcript.provider}:${transcript.agentSessionId}`),
        );
        this.outsidePendingScans = queue.length;
        const locator = new UsageTranscriptLocator(environment);
        const outcomes: Record<ScanOutcome, number> = {
            scanned: 0,
            unchanged: 0,
            unavailable: 0,
            failed: 0,
        };
        const described = await describeOutsideTranscripts(queue, (provider, main) =>
            locator.describe(provider, main),
        );
        const mtime = (fingerprint: string | undefined) =>
            Number(fingerprint?.split('|', 2)[1]?.split(':', 2)[1] ?? 0);
        const work = described.toSorted(
            (a, b) => mtime(b.files?.fingerprint) - mtime(a.files?.fingerprint),
        );
        const worker = async () => {
            for (let item = work.shift(); item; item = work.shift()) {
                const previous = cached.get(
                    `${item.transcript.provider}:${item.transcript.transcriptId}`,
                );
                // eslint-disable-next-line no-await-in-loop -- each worker parses one transcript at a time
                outcomes[await this.syncOutsideTranscript(item.transcript, item.files, previous)] +=
                    1;
                this.outsidePendingScans = Math.max(0, this.outsidePendingScans - 1);
            }
        };
        try {
            await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
        } finally {
            this.outsidePendingScans = 0;
        }
        logger.write(outcomes.failed > 0 ? 'warn' : 'debug', logEventCatalog.usage.externalScan, {
            durationMs: performance.now() - startedAt,
            fields: {
                discovered: discovered.length,
                hosted: discovered.length - queue.length,
                ...outcomes,
            },
        });
    }

    private async syncOutsideTranscript(
        transcript: DiscoveredTranscript,
        files: UsageTranscriptFiles | undefined,
        previous: ExternalAgentUsageRow | undefined,
    ): Promise<ScanOutcome> {
        try {
            if (!files) return 'unavailable';
            if (files.fingerprint === previous?.sourceFingerprint) return 'unchanged';
            const record = await scanUsage(transcript.provider, files, {
                isContinuation: transcript.isContinuation,
            });
            this.options.database.agentSessionUsage.saveExternalScan({
                provider: transcript.provider,
                transcriptId: transcript.transcriptId,
                agentSessionId: transcript.agentSessionId,
                path: transcript.main.path,
                cwd:
                    transcript.cwd ??
                    previous?.cwd ??
                    (await readTranscriptCwd(transcript.main)) ??
                    null,
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
     * Waits briefly for the outside-Caxri scan; a first scan keeps running in the background and the report says how
     * many transcripts it has not read yet.
     */
    private async loadOutside(): Promise<NonNullable<UsageReportInput['outside']>> {
        const abort = new AbortController();
        const settle = async (task: Promise<unknown>) => {
            try {
                await task;
            } catch {
                // A failed scan or the cancelled timer only ends the wait; the next report retries the scan.
            }
        };
        await Promise.race([
            settle(this.syncs.run('outside', () => this.syncOutside())),
            settle(delay(OUTSIDE_SCAN_WAIT_MS, undefined, { signal: abort.signal })),
        ]);
        abort.abort();
        const entries: OutsideUsageEntry[] = this.options.database.agentSessionUsage
            .listExternal()
            .map((row) => ({ row, record: parseUsageRecord(row.usageJson) }));
        return {
            entries,
            pendingScans: reportedPendingScans(this.syncs.has('outside'), this.outsidePendingScans),
        };
    }

    /**
     * Starts at most one background pass; the next report picks up whatever it stored.
     */
    private schedulePullRequestPass(
        entries: ReadonlyArray<UsageLedgerEntry | OutsideUsageEntry>,
    ): void {
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
        const outside = parameters.scope === 'all' ? await this.loadOutside() : undefined;
        const pullRequests = database.agentSessionUsage.listPullRequestOutcomes();
        this.schedulePullRequestPass([...entries, ...(outside?.entries ?? [])]);
        return buildUsageReport({
            params: parameters,
            now: this.now(),
            entries,
            outside,
            sessions: database.listSessions(),
            projects: database.listProjects(),
            pullRequests,
            priceOf: (model) => this.pricing.priceOf(model),
            pricing: { source: this.pricing.source, updatedAt: this.pricing.updatedAt },
        });
    }
}
