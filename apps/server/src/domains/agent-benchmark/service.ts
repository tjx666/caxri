import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type {
    AgentLaunchSettings,
    AgentProvider,
    BenchmarkAttempt,
    BenchmarkCatalog,
    BenchmarkRun,
    BenchmarkRunSummary,
    BenchmarkStartParameters,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentChatLaunchOptions, SpawnChatProcess } from '../agent-chat';
import type { AgentEnvironment } from '../agents';
import { readVersion } from '../agents';
import type { CaxriDatabase } from '../db';
import { BenchmarkRunsModel } from '../db';
import { ModelPricing } from '../usage';
import type { AttemptRunnerContext } from './attempt-runner';
import { isAttemptFinished, runAttempt, runJudge } from './attempt-runner';
import { BenchmarkCatalogProbe } from './catalog';
import { attemptBase, BenchmarkWorkspaces } from './workspace';

/**
 * Live progress (a step count) is published at most this often per run; transitions publish at once.
 */
const PROGRESS_PUBLISH_MS = 1_000;

export interface BenchmarkServiceOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    userDataPath: string;
    agentEnvironment: AgentEnvironment;
    /**
     * Overrides the provider process environment, so tests can point providers at fakes.
     */
    environment?: AgentChatLaunchOptions['environment'];
    resolveExecutable?: AgentChatLaunchOptions['resolveExecutable'];
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    clientVersion: string;
    spawnProcess?: SpawnChatProcess;
    fetch?: typeof fetch;
}

interface LiveRun {
    run: BenchmarkRun;
    controllers: Map<string, AbortController>;
    isCancelled: boolean;
    done: Promise<void>;
    publishTimer?: NodeJS.Timeout;
}

function closeInterruptedAttempts(run: BenchmarkRun): void {
    for (const attempt of run.attempts) {
        if (isAttemptFinished(attempt)) continue;
        attempt.status = 'failed';
        attempt.failureReason = 'serverRestarted';
        attempt.failureMessage = 'Caxri restarted while this run was in progress';
        attempt.finishedAt ??= Date.now();
    }
}

/**
 * Owns Benchmark runs: schedules each run's Attempts up to its concurrency, persists every transition, publishes
 * `benchmark.changed`, and closes what a previous Server left unfinished. See `docs/benchmark.md`.
 */
export class BenchmarkService {
    private readonly runs: BenchmarkRunsModel;
    private readonly live = new Map<string, LiveRun>();
    private readonly workspaces: BenchmarkWorkspaces;
    private readonly catalogProbe: BenchmarkCatalogProbe;
    private readonly pricing: ModelPricing;
    private isShuttingDown = false;

    constructor(private readonly options: BenchmarkServiceOptions) {
        this.runs = new BenchmarkRunsModel(options.database.database);
        const root = join(options.userDataPath, 'benchmarks');
        this.workspaces = new BenchmarkWorkspaces(join(root, 'runs'));
        this.pricing = new ModelPricing({
            userDataPath: options.userDataPath,
            fetch: options.fetch,
        });
        this.catalogProbe = new BenchmarkCatalogProbe({
            directory: join(root, 'probe'),
            dependencies: this.turnDependencies(),
            launchSettings: (provider) => options.launchSettings(provider),
            logger: options.logger,
        });
        this.closeInterruptedRuns();
    }

    private turnDependencies() {
        const { agentEnvironment, environment, resolveExecutable } = this.options;
        return {
            launch: { agentEnvironment, environment, resolveExecutable },
            clientVersion: this.options.clientVersion,
            spawnProcess: this.options.spawnProcess,
        };
    }

    /**
     * A provider process does not survive a Server restart, so an Attempt that was still running is closed as
     * `serverRestarted`; a fresh run of the same Entries is one click away in the history.
     */
    private closeInterruptedRuns(): void {
        const interrupted = this.runs.listRunning();
        for (const run of interrupted) {
            closeInterruptedAttempts(run);
            if (run.judge && ['pending', 'running'].includes(run.judge.status))
                run.judge = {
                    status: 'failed',
                    failureMessage: 'Caxri restarted before judging finished',
                };
            run.status = 'completed';
            run.finishedAt = Date.now();
            this.runs.save(run);
        }
        if (interrupted.length > 0)
            this.options.logger.write('warn', logEventCatalog.benchmark.interruptedRunsClosed, {
                fields: { runs: interrupted.length },
            });
    }

    private async execute(live: LiveRun, projectRoot: string | undefined): Promise<void> {
        const { run } = live;
        const context: AttemptRunnerContext = {
            turn: this.turnDependencies(),
            workspaces: this.workspaces,
            agentEnvironment: this.options.agentEnvironment,
            pricing: this.pricing,
            logger: this.options.logger,
            launchSettings: (provider) => this.options.launchSettings(provider),
            cliVersion: (provider) =>
                readVersion(provider, this.options.launchSettings(provider).executable),
            ...(projectRoot && { projectRoot }),
        };
        const queue = [...run.attempts];
        const worker = async (): Promise<void> => {
            for (let attempt = queue.shift(); attempt; attempt = queue.shift()) {
                // A queued Attempt the user stopped is already `cancelled`; starting it would spend tokens on a
                // result the board no longer counts.
                if (live.isCancelled || attempt.status !== 'queued') continue;
                const controller = new AbortController();
                live.controllers.set(attempt.id, controller);
                // eslint-disable-next-line no-await-in-loop -- each worker runs its Attempts one after another
                await runAttempt(context, run, attempt, controller.signal, this.observer(live));
                live.controllers.delete(attempt.id);
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(run.settings.concurrency, queue.length) }, () =>
                worker(),
            ),
        );
        for (const attempt of run.attempts)
            if (!isAttemptFinished(attempt)) {
                attempt.status = 'cancelled';
                attempt.finishedAt = Date.now();
            }
        if (run.settings.judge && !live.isCancelled) {
            const controller = new AbortController();
            live.controllers.set('judge', controller);
            await runJudge(context, run, controller.signal, this.observer(live));
            live.controllers.delete('judge');
        } else if (run.judge?.status === 'pending') run.judge = { status: 'skipped' };
        run.status = live.isCancelled ? 'cancelled' : 'completed';
        run.finishedAt = Date.now();
        run.pricing = {
            source: this.pricing.source,
            ...(this.pricing.updatedAt !== undefined && { updatedAt: this.pricing.updatedAt }),
        };
        clearTimeout(live.publishTimer);
        this.runs.save(run);
        this.live.delete(run.id);
        this.options.logger.write('info', logEventCatalog.benchmark.runFinished, {
            fields: {
                runId: run.id,
                status: run.status,
                completed: run.attempts.filter((attempt) => attempt.status === 'completed').length,
                failed: run.attempts.filter((attempt) => attempt.status === 'failed').length,
                timedOut: run.attempts.filter((attempt) => attempt.status === 'timedOut').length,
                cancelled: run.attempts.filter((attempt) => attempt.status === 'cancelled').length,
                durationMs: run.finishedAt - run.createdAt,
            },
        });
        this.publish(run.id, 'transition');
    }

    private observer(live: LiveRun) {
        return {
            changed: (isTransition: boolean) => {
                if (isTransition) {
                    if (!this.isShuttingDown) this.runs.save(live.run);
                    clearTimeout(live.publishTimer);
                    live.publishTimer = undefined;
                    this.publish(live.run.id, 'transition');
                    return;
                }
                live.publishTimer ??= setTimeout(() => {
                    live.publishTimer = undefined;
                    this.publish(live.run.id, 'progress');
                }, PROGRESS_PUBLISH_MS);
            },
        };
    }

    /**
     * A `progress` event (live step counts) only refreshes the run's own view; the history list re-reads on a
     * `transition` only, so a long run does not re-parse every stored document once a second.
     */
    private publish(runId: string, kind: 'progress' | 'transition'): void {
        if (this.isShuttingDown) return;
        this.options.send({ event: 'benchmark.changed', payload: { runId, kind } });
    }

    catalog(shouldRefresh = false): Promise<BenchmarkCatalog> {
        return this.catalogProbe.read(shouldRefresh);
    }

    list(): { runs: BenchmarkRunSummary[] } {
        return {
            runs: this.runs
                .list()
                .map((stored) => summarize(this.live.get(stored.id)?.run ?? stored)),
        };
    }

    get(runId: string): BenchmarkRun {
        const run = this.live.get(runId)?.run ?? this.runs.get(runId);
        if (!run) throw new CaxriError('NOT_FOUND', 'Benchmark run not found');
        return run;
    }

    async attemptDiff(
        runId: string,
        attemptId: string,
    ): Promise<{ diff: string; truncated: boolean }> {
        const run = this.get(runId);
        const attempt = run.attempts.find((candidate) => candidate.id === attemptId);
        if (!attempt) throw new CaxriError('NOT_FOUND', 'Benchmark attempt not found');
        if (!isAttemptFinished(attempt))
            throw new CaxriError('CONFLICT', 'This run is still in progress');
        try {
            return await this.workspaces.diff(
                runId,
                attemptId,
                attemptBase(run),
                run.projectSubpath,
            );
        } catch {
            throw new CaxriError('UNAVAILABLE', 'The folder this run used is no longer available');
        }
    }

    /**
     * Number of Attempts whose provider process is running or about to, so quitting asks first and idle exit waits.
     */
    liveCount(): number {
        let count = 0;
        for (const { run } of this.live.values())
            count += run.attempts.filter((attempt) => !isAttemptFinished(attempt)).length;
        return count;
    }

    async start(parameters: BenchmarkStartParameters): Promise<{ runId: string }> {
        if (this.isShuttingDown) throw new CaxriError('UNAVAILABLE', 'Caxri is shutting down');
        const { workspace } = parameters.settings;
        let projectRoot: string | undefined;
        let projectTitle: string | undefined;
        let baseCommit: string | undefined;
        let projectSubpath: string | undefined;
        if (workspace.kind === 'project') {
            const project = this.options.database.getProject(workspace.projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            projectTitle = project.displayTitle.slice(0, 200);
            try {
                const located = await this.workspaces.locateProject(project.rootPath);
                baseCommit = located.head;
                // Attempts clone the whole repository; a Project that is a subfolder of it is entered afterwards.
                projectRoot = located.repoRoot;
                projectSubpath = located.subpath;
            } catch {
                throw new CaxriError(
                    'VALIDATION',
                    'This Project is not a Git repository with a commit, so its runs cannot start from one',
                );
            }
        }
        const runId = randomUUID();
        const attempts: BenchmarkAttempt[] = parameters.entries.flatMap((_entry, entryIndex) =>
            Array.from({ length: parameters.settings.repeats }, (_value, index) => ({
                id: randomUUID(),
                entryIndex,
                repeat: index + 1,
                status: 'queued' as const,
                steps: 0,
            })),
        );
        const run: BenchmarkRun = {
            id: runId,
            title: titleOf(parameters.prompt),
            prompt: parameters.prompt,
            entries: parameters.entries,
            settings: parameters.settings,
            status: 'running',
            createdAt: Date.now(),
            ...(baseCommit && { baseCommit }),
            ...(projectSubpath && { projectSubpath }),
            ...(projectTitle && { projectTitle }),
            ...(parameters.settings.judge && { judge: { status: 'pending' as const } }),
            attempts,
        };
        this.runs.save(run);
        const live: LiveRun = {
            run,
            controllers: new Map(),
            isCancelled: false,
            done: Promise.resolve(),
        };
        this.live.set(runId, live);
        live.done = this.execute(live, projectRoot);
        this.options.logger.write('info', logEventCatalog.benchmark.runStarted, {
            fields: {
                runId,
                entries: run.entries.length,
                attempts: attempts.length,
                workspace: workspace.kind,
                hasCheck: Boolean(run.settings.checkCommand),
                hasJudge: Boolean(run.settings.judge),
            },
        });
        this.publish(runId, 'transition');
        return { runId };
    }

    cancel(runId: string, attemptId?: string): null {
        const live = this.live.get(runId);
        if (!live) {
            if (!this.runs.get(runId)) throw new CaxriError('NOT_FOUND', 'Benchmark run not found');
            return null;
        }
        if (attemptId) {
            const attempt = live.run.attempts.find((candidate) => candidate.id === attemptId);
            if (!attempt) throw new CaxriError('NOT_FOUND', 'Benchmark attempt not found');
            const controller = live.controllers.get(attemptId);
            if (controller) controller.abort();
            else if (attempt.status === 'queued') {
                attempt.status = 'cancelled';
                attempt.finishedAt = Date.now();
                this.observer(live).changed(true);
            }
            return null;
        }
        live.isCancelled = true;
        for (const attempt of live.run.attempts)
            if (attempt.status === 'queued') {
                attempt.status = 'cancelled';
                attempt.finishedAt = Date.now();
            }
        for (const controller of live.controllers.values()) controller.abort();
        this.observer(live).changed(true);
        return null;
    }

    async delete(runId: string): Promise<null> {
        const live = this.live.get(runId);
        // The folder is removed by ID, so only an ID that names a run may reach the filesystem.
        if (!live && !this.runs.get(runId))
            throw new CaxriError('NOT_FOUND', 'Benchmark run not found');
        if (live) {
            this.cancel(runId);
            await live.done;
        }
        this.runs.delete(runId);
        await this.workspaces.removeRun(runId);
        this.publish(runId, 'transition');
        return null;
    }

    /**
     * Cancels every unfinished run and waits for its providers to exit, so no Agent outlives Server Core. A run the
     * process could not finish saving is closed as `serverRestarted` by the next Server.
     */
    async shutdown(): Promise<void> {
        this.isShuttingDown = true;
        const runs = this.live.values().toArray();
        for (const live of runs) {
            live.isCancelled = true;
            clearTimeout(live.publishTimer);
            for (const controller of live.controllers.values()) controller.abort();
        }
        await Promise.all(runs.map((live) => live.done));
    }
}

function titleOf(prompt: string): string {
    const line = prompt.trim().split('\n', 1)[0] ?? '';
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function summarize(run: BenchmarkRun): BenchmarkRunSummary {
    return {
        id: run.id,
        title: run.title,
        status: run.status,
        createdAt: run.createdAt,
        ...(run.finishedAt !== undefined && { finishedAt: run.finishedAt }),
        entries: run.entries,
        attempts: run.attempts.length,
        completedAttempts: run.attempts.filter((attempt) => attempt.status === 'completed').length,
    };
}
