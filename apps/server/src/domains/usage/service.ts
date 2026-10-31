import { homedir } from 'node:os';

import type {
    AgentProvider,
    AgentUsageReadout,
    UsageLimit,
    UsageNotice,
    UsageReport,
    UsageReportParameters,
} from '@caxri/protocol';
import { agentProviderIds, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { mapWithConcurrency, SingleFlight } from '@caxri/system';

import type { AgentEnvironment, DiscoveredTranscript } from '../agents';
import {
    discoverTranscripts,
    readAntigravityConversationSummary,
    readTranscriptCwd,
} from '../agents';
import type { AgentSessionUsageRow, CaxriDatabase, ExternalAgentUsageRow } from '../db';
import type { ExternalStatusRunner } from '../external-status';
import { UsageKeyIndex } from './key-index';
import { LiveAgentUsage } from './live-usage';
import { PlanLimitRefresh } from './plan-limit-refresh';
import { ModelPricing } from './pricing';
import {
    fetchPullRequestOutcomes,
    isRefreshDue,
    MAX_PULL_REQUESTS_PER_PASS,
} from './pull-requests';
import type { UsageRecord } from './record';
import { parseUsageRecord } from './record';
import type { OutsideUsageEntry, UsageLedgerEntry, UsageReportInput } from './report';
import { buildUsageReport } from './report';
import type { ClaudeTranscriptMisses, UsageScanOptions, UsageTranscriptFiles } from './scanner';
import { compressedFailureCounter, scanUsage, UsageTranscriptLocator } from './scanner';
import { UsageNoticeDismissals } from './usage-notice-dismissals';
import { waitBriefly } from './wait-briefly';

/**
 * Transcripts parsed concurrently during one ledger sync.
 */
const SCAN_CONCURRENCY = 4;
const PROVIDER_IDS = new Set<string>(agentProviderIds);
/**
 * Passes one sync makes: the second rescans the transcripts the first found to be copies of a source it indexed later.
 */
const MAX_SYNC_PASSES = 2;

export interface UsageServiceOptions {
    database: CaxriDatabase;
    environment: AgentEnvironment;
    logger: StructuredLogger;
    runner: ExternalStatusRunner;
    userDataPath: string;
    fetch?: typeof fetch;
    now?: () => number;
    /**
     * Plan rate limits from an Agent Chat's running process, for a provider that writes none into its transcript
     * (Claude Code). Undefined without a running Chat or a plan.
     */
    readPlanLimits?: (terminalId: string) => Promise<Omit<UsageLimit, 'provider'> | undefined>;
    /**
     * Each provider's newest plan-limit reading, from any source; see `LiveAgentUsage`.
     */
    onLimit?: (limit: UsageLimit) => void;
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

function ledgerReference(row: Pick<AgentSessionUsageRow, 'provider' | 'agentSessionId'>): string {
    return `ledger:${row.provider}:${row.agentSessionId}`;
}

function outsideReference(row: Pick<ExternalAgentUsageRow, 'provider' | 'transcriptId'>): string {
    return `outside:${row.provider}:${row.transcriptId}`;
}

/**
 * Transcripts a report says are still being read. Discovery runs before the queue is counted, so a running scan reports
 * at least one: otherwise the page would read as finished and stop polling quickly while discovery is still walking a
 * large history.
 */
export function reportedPendingScans(isScanning: boolean, counted: number): number {
    return isScanning ? Math.max(1, counted) : 0;
}

/**
 * Owns the usage ledger: records Agent Session bindings, keeps each content-free usage aggregate in step with its
 * transcript files, resolves pull request outcomes in the background, and builds reports on demand. Nothing runs until
 * a Client asks for a report, so an unused Usage page costs nothing.
 */
export class UsageService {
    private readonly pricing: ModelPricing;
    private readonly syncs = new SingleFlight<'ledger' | 'outside', void>();
    private pullRequestPass?: Promise<void>;
    /**
     * Transcripts the running outside-Caxri scan has not reached yet.
     */
    private outsidePendingScans = 0;
    /**
     * Ledger rows the running ledger scan has not reached yet.
     */
    private ledgerPendingScans = 0;
    private hasSyncedLedger = false;
    private readonly claudeMisses: ClaudeTranscriptMisses = new Map();
    private keyIndex?: UsageKeyIndex;
    /**
     * Rows invalidated by {@link UsageKeyIndex.store} that the running sync still has to rescan.
     */
    private readonly staleLedgerRows = new Set<string>();
    private readonly staleOutsideRows = new Set<string>();
    private readonly live: LiveAgentUsage;
    private readonly planLimits: PlanLimitRefresh;
    private readonly noticeDismissals: UsageNoticeDismissals;

    constructor(private readonly options: UsageServiceOptions) {
        this.pricing = new ModelPricing({
            userDataPath: options.userDataPath,
            fetch: options.fetch,
            now: options.now,
        });
        this.live = new LiveAgentUsage(
            options.database,
            options.environment,
            (model) => this.pricing.priceOf(model),
            () => this.now(),
            options.onLimit,
        );
        this.planLimits = new PlanLimitRefresh(options.readPlanLimits, this.live, () => this.now());
        this.noticeDismissals = new UsageNoticeDismissals({
            database: options.database,
            logger: options.logger,
            now: () => this.now(),
            limits: () => this.live.limits(),
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
     * The digests of every stored aggregate, built once from the database and kept current as scans store new ones.
     * Outside rows for a conversation the ledger hosts are left out: the report counts that conversation from the
     * ledger.
     */
    private usageKeys(): UsageKeyIndex {
        if (this.keyIndex) return this.keyIndex;
        const index = new UsageKeyIndex();
        const { agentSessionUsage } = this.options.database;
        const ledger = agentSessionUsage.list();
        const hosted = new Set(ledger.map((row) => `${row.provider}:${row.agentSessionId}`));
        for (const row of ledger)
            index.store(ledgerReference(row), parseUsageRecord(row.usageJson));
        for (const row of agentSessionUsage.listExternal())
            if (!hosted.has(`${row.provider}:${row.agentSessionId}`))
                index.store(outsideReference(row), parseUsageRecord(row.usageJson));
        this.keyIndex = index;
        return index;
    }

    /**
     * Stores the index's answer for a freshly saved aggregate: every transcript that counted a unit this one owns is
     * marked for a rescan.
     */
    private indexScan(reference: string, record: UsageRecord, scannedSince: number): void {
        const { agentSessionUsage } = this.options.database;
        for (const stale of this.usageKeys().store(reference, record, scannedSince)) {
            const [kind, provider, ...rest] = stale.split(':');
            if (!PROVIDER_IDS.has(provider)) continue;
            const id = rest.join(':');
            if (kind === 'ledger') {
                agentSessionUsage.invalidateScan(provider as AgentProvider, id);
                this.staleLedgerRows.add(stale);
            } else {
                agentSessionUsage.invalidateExternalScan(provider as AgentProvider, id);
                this.staleOutsideRows.add(stale);
            }
        }
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
        const locator = new UsageTranscriptLocator(environment, this.claudeMisses, () =>
            this.now(),
        );
        const outcomes: Record<ScanOutcome, number> = {
            scanned: 0,
            unchanged: 0,
            unavailable: 0,
            failed: 0,
        };
        let rescans = 0;
        let queue = [...rows];
        this.ledgerPendingScans = queue.length;
        try {
            for (let pass = 0; pass < MAX_SYNC_PASSES && queue.length > 0; pass++) {
                this.staleLedgerRows.clear();
                const worker = async () => {
                    for (let row = queue.shift(); row; row = queue.shift()) {
                        // eslint-disable-next-line no-await-in-loop -- each worker parses one transcript at a time
                        outcomes[await this.syncRow(row, locator)] += 1;
                        this.ledgerPendingScans = Math.max(0, this.ledgerPendingScans - 1);
                    }
                };
                // eslint-disable-next-line no-await-in-loop -- the next pass rescans what this one invalidated
                await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
                queue = database.agentSessionUsage
                    .list()
                    .filter((row) => this.staleLedgerRows.has(ledgerReference(row)));
                rescans += queue.length;
                this.ledgerPendingScans = queue.length;
            }
        } finally {
            this.ledgerPendingScans = 0;
        }
        const isFirst = !this.hasSyncedLedger;
        this.hasSyncedLedger = true;
        logger.write(outcomes.failed > 0 ? 'warn' : 'debug', logEventCatalog.usage.scan, {
            durationMs: performance.now() - startedAt,
            fields: {
                rows: rows.length,
                ...outcomes,
                rescans,
                isFirst,
                skippedSearches: locator.skippedSearches,
            },
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
            const reference = ledgerReference(row);
            const scannedSince = this.usageKeys().version;
            const record = await scanUsage(row.provider, files, {
                isCountedElsewhere: this.usageKeys().countedElsewhere(reference, files.bornAt),
            });
            this.options.database.agentSessionUsage.saveScan(row.provider, row.agentSessionId, {
                sourceFingerprint: files.fingerprint,
                scannedAt: this.now(),
                usageJson: JSON.stringify(record),
            });
            this.indexScan(reference, record, scannedSince);
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
        const listCached = () =>
            new Map(
                database.agentSessionUsage
                    .listExternal()
                    .map((row) => [`${row.provider}:${row.transcriptId}`, row]),
            );
        let cached = listCached();
        const discovered = await discoverTranscripts(environment, { includeCompressed: true });
        const queue = discovered.filter(
            (transcript) => !hosted.has(`${transcript.provider}:${transcript.agentSessionId}`),
        );
        const cachedRow = (transcript: DiscoveredTranscript) =>
            cached.get(`${transcript.provider}:${transcript.transcriptId}`);
        /**
         * Only transcripts that will actually be parsed count as pending. A resync finds nearly every file unchanged in
         * a couple of seconds, and counting those flashed "Reading 8,000 more transcripts" on every refresh. Until the
         * files are described, a transcript without a stored aggregate is the best estimate.
         */
        this.outsidePendingScans = queue.filter((transcript) => !cachedRow(transcript)).length;
        const shouldScan = ({
            transcript,
            files,
        }: {
            transcript: DiscoveredTranscript;
            files?: UsageTranscriptFiles;
        }) => files !== undefined && files.fingerprint !== cachedRow(transcript)?.sourceFingerprint;
        const locator = new UsageTranscriptLocator(environment, this.claudeMisses, () =>
            this.now(),
        );
        const outcomes: Record<ScanOutcome, number> = {
            scanned: 0,
            unchanged: 0,
            unavailable: 0,
            failed: 0,
        };
        const { counts: unreadableCompressed, onFailure } = compressedFailureCounter();
        const described = await describeOutsideTranscripts(queue, (provider, main) =>
            locator.describe(provider, main),
        );
        const mtime = (fingerprint: string | undefined) =>
            Number(fingerprint?.split('|', 2)[1]?.split(':', 2)[1] ?? 0);
        const sorted = described.toSorted(
            (a, b) => mtime(b.files?.fingerprint) - mtime(a.files?.fingerprint),
        );
        let work = [...sorted];
        let rescans = 0;
        this.outsidePendingScans = work.filter(shouldScan).length;
        try {
            for (let pass = 0; pass < MAX_SYNC_PASSES && work.length > 0; pass++) {
                this.staleOutsideRows.clear();
                const worker = async () => {
                    for (let item = work.shift(); item; item = work.shift()) {
                        const previous = cachedRow(item.transcript);
                        const isPending = shouldScan(item);
                        // eslint-disable-next-line no-await-in-loop -- each worker parses one transcript at a time
                        const outcome = await this.syncOutsideTranscript(
                            item.transcript,
                            item.files,
                            previous,
                            onFailure,
                        );
                        outcomes[outcome] += 1;
                        if (isPending)
                            this.outsidePendingScans = Math.max(0, this.outsidePendingScans - 1);
                    }
                };
                // eslint-disable-next-line no-await-in-loop -- the next pass rescans what this one invalidated
                await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
                cached = listCached();
                work = sorted.filter(({ transcript }) =>
                    this.staleOutsideRows.has(outsideReference(transcript)),
                );
                rescans += work.length;
                this.outsidePendingScans = work.filter(shouldScan).length;
            }
        } finally {
            this.outsidePendingScans = 0;
        }
        logger.write(outcomes.failed > 0 ? 'warn' : 'debug', logEventCatalog.usage.externalScan, {
            durationMs: performance.now() - startedAt,
            fields: {
                discovered: discovered.length,
                hosted: discovered.length - queue.length,
                ...outcomes,
                ...unreadableCompressed,
                rescans,
                skippedSearches: locator.skippedSearches,
            },
        });
    }

    private async syncOutsideTranscript(
        transcript: DiscoveredTranscript,
        files: UsageTranscriptFiles | undefined,
        previous: ExternalAgentUsageRow | undefined,
        onFailure?: UsageScanOptions['onFailure'],
    ): Promise<ScanOutcome> {
        try {
            if (!files) return 'unavailable';
            if (files.fingerprint === previous?.sourceFingerprint) return 'unchanged';
            const reference = outsideReference(transcript);
            const scannedSince = this.usageKeys().version;
            const record = await scanUsage(transcript.provider, files, {
                isContinuation: transcript.isContinuation,
                isCountedElsewhere: this.usageKeys().countedElsewhere(reference, files.bornAt),
                ...(onFailure && { onFailure }),
            });
            this.options.database.agentSessionUsage.saveExternalScan({
                provider: transcript.provider,
                transcriptId: transcript.transcriptId,
                agentSessionId: transcript.agentSessionId,
                path: transcript.main.path,
                cwd:
                    transcript.cwd ??
                    previous?.cwd ??
                    (transcript.provider === 'antigravity'
                        ? readAntigravityConversationSummary(
                              this.options.environment,
                              transcript.agentSessionId,
                          )?.cwd
                        : await readTranscriptCwd(transcript.main)) ??
                    null,
                sourceFingerprint: files.fingerprint,
                scannedAt: this.now(),
                usageJson: JSON.stringify(record),
            });
            this.indexScan(reference, record, scannedSince);
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
        await waitBriefly(this.syncs.run('outside', () => this.syncOutside()));
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

    /**
     * Running usage of the conversation bound to one Agent Terminal, for the status bar.
     */
    async readTerminal(terminalId: string): Promise<AgentUsageReadout | null> {
        await this.loadPricing();
        const readout = await this.live.read(terminalId);
        if (!readout) return readout;
        this.planLimits.request(readout.provider, terminalId);
        return readout.limit
            ? { ...readout, limit: this.noticeDismissals.attach(readout.limit) }
            : readout;
    }

    /**
     * Hides one of the provider's plan notices on every Client; answers `usage.dismissNotice`.
     */
    dismissNotice(provider: AgentProvider, notice: UsageNotice): null {
        this.noticeDismissals.dismiss(notice, provider);
        return null;
    }

    /**
     * Newest plan rate-limit reading per provider, for a client that shows the plan with no Agent Terminal in view (a
     * paired phone's Agent usage screen). Reads the ledger a Usage report reads, without building the report or
     * starting its pull-request pass, and folds in what live conversations reported since.
     */
    async readLimits(): Promise<UsageLimit[]> {
        await waitBriefly(this.syncs.run('ledger', () => this.syncLedger()));
        const ledger: UsageLimit[] = [];
        for (const row of this.options.database.agentSessionUsage.list()) {
            const rateLimits = parseUsageRecord(row.usageJson)?.rateLimits;
            if (rateLimits) ledger.push({ provider: row.provider, ...rateLimits });
        }
        this.live.observeLimits(ledger);
        return this.live.limits().map((limit) => this.noticeDismissals.attach(limit));
    }

    /**
     * Running usage of one subagent of the conversation bound to an Agent Terminal, for its task tab.
     */
    async readTerminalTask(terminalId: string, taskId: string): Promise<AgentUsageReadout | null> {
        await this.loadPricing();
        return this.live.readTask(terminalId, taskId);
    }

    /**
     * Answers within about a second: a ledger scan still running after that (a first open over hundreds of transcripts)
     * continues in the background, and the report says how many rows it has not read yet.
     */
    async report(parameters: UsageReportParameters): Promise<UsageReport> {
        await Promise.all([
            this.loadPricing(),
            waitBriefly(this.syncs.run('ledger', () => this.syncLedger())),
        ]);
        const { database } = this.options;
        const entries: UsageLedgerEntry[] = database.agentSessionUsage
            .list()
            .map((row) => ({ row, record: parseUsageRecord(row.usageJson) }));
        const outside = parameters.scope === 'all' ? await this.loadOutside() : undefined;
        const pullRequests = database.agentSessionUsage.listPullRequestOutcomes();
        this.schedulePullRequestPass([...entries, ...(outside?.entries ?? [])]);
        const report = buildUsageReport({
            params: parameters,
            now: this.now(),
            entries,
            outside,
            sessions: database.listSessions(),
            projects: database.listProjects(),
            pullRequests,
            priceOf: (model) => this.pricing.priceOf(model),
            pricing: { source: this.pricing.source, updatedAt: this.pricing.updatedAt },
            pendingScans: reportedPendingScans(this.syncs.has('ledger'), this.ledgerPendingScans),
            boundAgentSessions: (sessionId) =>
                database
                    .listTerminals(sessionId)
                    .flatMap(({ provider, agentSessionId }) =>
                        provider && agentSessionId ? [`${provider}:${agentSessionId}`] : [],
                    ),
        });
        // Plan limits are account-wide: the status bar's live reading should never trail what this page just saw.
        this.live.observeLimits(report.limits);
        return {
            ...report,
            limits: report.limits.map((limit) => this.noticeDismissals.attach(limit)),
        };
    }
}
