import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';

import type {
    AgentEnvironment,
    AgentTranscriptLocation,
    TranscriptScanCursor,
    TranscriptScanFailureReason,
} from '../agents';
import {
    agentProviders,
    antigravityConversationPath,
    antigravityConversationStamp,
    antigravityStateDirectory,
    isCompressedTranscriptPath,
    locateAgentTranscriptForIdentity,
    locateEarlierCodexRollouts,
    readAntigravityConversation,
    scanTranscriptLines,
} from '../agents';
import type { RateLimitObservation } from './accumulator';
import { UsageAccumulator } from './accumulator';
import type { ClaudeMessageUsage, UsageLineParser, UsageParserOptions } from './parsers';
import { usageKeyDigest, usageParserFor } from './parsers';
import type { UsageRecord } from './record';
import { USAGE_RECORD_VERSION } from './record';

/**
 * A Claude transcript directory lists one file per conversation of that working directory; past this many entries the
 * subagent and fallback lookups give up instead of stalling a report.
 */
const MAX_DIRECTORY_ENTRIES = 8_192;
/**
 * Upper bound on Claude subagent side files folded into one Agent Session.
 */
const MAX_SIDE_FILES = 256;
/**
 * How long a Claude conversation that no project directory holds is not searched for again, unless the projects
 * directory itself changes. A pruned transcript never returns; a conversation resumed under a new working directory
 * usually creates that directory, and is otherwise found within this window.
 */
const CLAUDE_MISS_TTL_MS = 3_600_000;

export interface UsageScanTarget {
    provider: AgentProvider;
    agentSessionId: string;
    cwd: string;
}

export interface UsageTranscriptFiles {
    main: AgentTranscriptLocation;
    /**
     * Earlier rollouts of a reverted Codex thread, oldest first; `main` continues them.
     */
    earlier: AgentTranscriptLocation[];
    /**
     * Claude subagent transcripts (`<conversation>/subagents/*.jsonl`): billed tokens without their own Agent Session.
     */
    side: AgentTranscriptLocation[];
    /**
     * Size and mtime of every file; equal fingerprints mean an unchanged aggregate.
     */
    fingerprint: string;
    /**
     * Creation time of the first main file, epoch milliseconds.
     */
    bornAt: number;
}

/**
 * Claude conversations the fallback search did not find, kept across syncs so a pruned transcript is not searched for
 * in every project directory on every report.
 */
export type ClaudeTranscriptMisses = Map<string, { baseMtimeMs: number; checkedAt: number }>;

async function listDirectory(directory: string): Promise<string[]> {
    const names: string[] = [];
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
        handle = await opendir(directory);
        for await (const entry of handle) {
            names.push(entry.name);
            if (names.length >= MAX_DIRECTORY_ENTRIES) break;
        }
    } catch {
        // A missing directory is an empty one.
    } finally {
        try {
            await handle?.close();
        } catch {
            // Async iteration already closes an exhausted handle.
        }
    }
    return names;
}

interface FileStamp {
    stamp: string;
    bornAt: number;
}

async function fileStamp(path: string): Promise<FileStamp | undefined> {
    try {
        const stats = await lstat(path);
        if (!stats.isFile()) return undefined;
        return {
            stamp: `${stats.size}:${Math.trunc(stats.mtimeMs)}`,
            // A filesystem without creation times reports 0; the modification time is the closest stand-in.
            bornAt: Math.trunc(stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs),
        };
    } catch {
        return undefined;
    }
}

/**
 * An Antigravity conversation is a SQLite database whose recent writes sit in its write-ahead log, so its stamp covers
 * both files.
 */
async function mainFileStamp(
    provider: AgentProvider,
    path: string,
): Promise<FileStamp | undefined> {
    if (provider !== 'antigravity') return fileStamp(path);
    const stamp = await antigravityConversationStamp(path);
    return stamp && { stamp: `${stamp.size}:${stamp.mtimeMs}`, bornAt: stamp.bornAt };
}

function antigravityLocation(
    environment: AgentEnvironment,
    agentSessionId: string,
): AgentTranscriptLocation {
    const path = antigravityConversationPath(environment, agentSessionId);
    return { baseRoot: antigravityStateDirectory(environment), root: dirname(path), path };
}

async function directoryMtime(path: string): Promise<number | undefined> {
    try {
        return (await lstat(path)).mtimeMs;
    } catch {
        return undefined;
    }
}

/**
 * Finds the files that hold one Agent Session's usage. A Claude transcript recorded under a working directory that no
 * longer matches (for example after a worktree was removed and the conversation resumed elsewhere) is looked up by its
 * conversation ID across every Claude project directory.
 */
export class UsageTranscriptLocator {
    private claudeDirectories?: Promise<string[]>;
    /**
     * Fallback searches skipped because the conversation was recently not found.
     */
    skippedSearches = 0;

    constructor(
        private readonly environment: AgentEnvironment,
        private readonly claudeMisses: ClaudeTranscriptMisses = new Map(),
        private readonly now: () => number = Date.now,
    ) {}

    private claudeBaseRoot(): string | undefined {
        return agentProviders.claude.transcriptBaseRoot?.(this.environment);
    }

    private async findClaudeTranscript(
        agentSessionId: string,
    ): Promise<AgentTranscriptLocation | undefined> {
        const baseRoot = this.claudeBaseRoot();
        if (!baseRoot) return;
        const baseMtimeMs = await directoryMtime(baseRoot);
        if (baseMtimeMs === undefined) return;
        const miss = this.claudeMisses.get(agentSessionId);
        if (miss?.baseMtimeMs === baseMtimeMs && this.now() - miss.checkedAt < CLAUDE_MISS_TTL_MS) {
            this.skippedSearches += 1;
            return;
        }
        this.claudeDirectories ??= listDirectory(baseRoot);
        const fileName = `${agentSessionId}.jsonl`;
        const directories = await this.claudeDirectories;
        for (const directory of directories) {
            const root = join(baseRoot, directory);
            const path = join(root, fileName);
            // eslint-disable-next-line no-await-in-loop -- stops at the first directory holding the conversation
            if (await fileStamp(path)) {
                this.claudeMisses.delete(agentSessionId);
                return { baseRoot, root, path };
            }
        }
        this.claudeMisses.set(agentSessionId, { baseMtimeMs, checkedAt: this.now() });
        return undefined;
    }

    private async claudeSideFiles(
        main: AgentTranscriptLocation,
    ): Promise<AgentTranscriptLocation[]> {
        const conversationRoot = join(main.root, basename(main.path, '.jsonl'));
        const root = join(conversationRoot, 'subagents');
        const names = await listDirectory(root);
        return names
            .filter((name) => name.endsWith('.jsonl'))
            .toSorted((a, b) => a.localeCompare(b))
            .slice(0, MAX_SIDE_FILES)
            .map((name) => ({
                anchorRoot: dirname(main.root),
                baseRoot: conversationRoot,
                root,
                path: join(root, name),
            }));
    }

    private async withSideFiles(
        provider: AgentProvider,
        main: AgentTranscriptLocation,
        mainStamp: FileStamp,
        earlier: AgentTranscriptLocation[] = [],
    ): Promise<UsageTranscriptFiles> {
        const side = provider === 'claude' ? await this.claudeSideFiles(main) : [];
        const [earlierStamps, sideStamps] = await Promise.all([
            Promise.all(earlier.map((file) => fileStamp(file.path))),
            Promise.all(side.map((file) => fileStamp(file.path))),
        ]);
        const present = earlier.filter((_, index) => earlierStamps[index] !== undefined);
        return {
            main,
            earlier: present,
            side,
            // The main file keeps the second position, which the outside-Caxri scan reads as the file's mtime.
            fingerprint: [
                `v${USAGE_RECORD_VERSION}`,
                mainStamp.stamp,
                ...earlierStamps.flatMap((stamp) => (stamp ? [stamp.stamp] : [])),
                ...sideStamps.map((stamp) => stamp?.stamp ?? '-'),
            ].join('|'),
            bornAt: (earlierStamps.find(Boolean) ?? mainStamp).bornAt,
        };
    }

    /**
     * Finds an Agent Session's files from its ledger binding. A reverted Codex thread's ledger row points at its
     * current rollout; the rollouts before the revert hold the thread's earlier turns and are read with it, so its
     * history keeps the hours it happened in instead of arriving as one lump with the first total after the revert.
     */
    async locate(target: UsageScanTarget): Promise<UsageTranscriptFiles | undefined> {
        let main =
            target.provider === 'antigravity'
                ? antigravityLocation(this.environment, target.agentSessionId)
                : await locateAgentTranscriptForIdentity(target, this.environment);
        let mainStamp = main && (await mainFileStamp(target.provider, main.path));
        if (!mainStamp && target.provider === 'claude') {
            main = await this.findClaudeTranscript(target.agentSessionId);
            mainStamp = main && (await fileStamp(main.path));
        }
        if (!main || !mainStamp) return;
        const earlier =
            target.provider === 'codex'
                ? await locateEarlierCodexRollouts(main, this.environment)
                : [];
        return this.withSideFiles(target.provider, main, mainStamp, earlier);
    }

    /**
     * Completes an already located main transcript with its side files and fingerprint. Returns `undefined` when the
     * main file is gone.
     */
    async describe(
        provider: AgentProvider,
        main: AgentTranscriptLocation,
    ): Promise<UsageTranscriptFiles | undefined> {
        const mainStamp = await mainFileStamp(provider, main.path);
        return mainStamp ? this.withSideFiles(provider, main, mainStamp) : undefined;
    }
}

type StreamReadOutcome = 'read' | 'reset';

interface UsageStream {
    location: AgentTranscriptLocation;
    cursor: TranscriptScanCursor;
    parser: UsageLineParser;
    /**
     * A side file's own share of the aggregate, set only for side files.
     */
    side?: UsageAccumulator;
    onFailure?: (reason: TranscriptScanFailureReason) => void;
}

/**
 * Files a side file's usage into the scan's aggregate and into that file's own share at once. Units the side file
 * repeats from its parent are merged before they get here, so the share holds only what the subagent itself billed.
 */
class SideUsageAccumulator extends UsageAccumulator {
    constructor(private readonly aggregate: UsageAccumulator) {
        super();
    }

    override addUsage(...parameters: Parameters<UsageAccumulator['addUsage']>): void {
        super.addUsage(...parameters);
        this.aggregate.addUsage(...parameters);
    }

    override endStream(): void {
        super.endStream();
        this.aggregate.endStream();
    }

    override addPullRequest(url: string): void {
        super.addPullRequest(url);
        this.aggregate.addPullRequest(url);
    }

    override observeRateLimits(observation: RateLimitObservation): void {
        super.observeRateLimits(observation);
        this.aggregate.observeRateLimits(observation);
    }
}

export type UsageScanOptions = Pick<UsageParserOptions, 'isContinuation' | 'isCountedElsewhere'> & {
    /**
     * Reports why reading a transcript stopped early (for example a corrupt `.jsonl.zst`), without its content.
     */
    onFailure?: (reason: TranscriptScanFailureReason) => void;
};

/**
 * Folds one Agent Session's transcript files into a {@link UsageRecord} and can resume where it stopped: each file keeps
 * its read cursor and parser state, so a later {@link advance} parses only appended records. A full scan is one
 * `advance`; a live consumer (for example a per-Session usage readout) keeps the instance and calls `advance` again
 * whenever the transcript grows.
 */
export class IncrementalUsageScan {
    private accumulator = new UsageAccumulator();
    private streams = new Map<string, UsageStream>();
    private claudeMessages = new Map<string, ClaudeMessageUsage>();

    constructor(
        readonly provider: AgentProvider,
        private readonly options: UsageScanOptions = {},
    ) {}

    /**
     * Earlier rollouts first, oldest first, then the main file and its side files. Only the first file of a chain
     * starts from zero; every later rollout opens with the thread's running total.
     */
    private parserOptions(
        files: UsageTranscriptFiles,
    ): Array<[AgentTranscriptLocation, UsageParserOptions]> {
        const chain = [...files.earlier, files.main];
        return [
            ...chain.map((location, index): [AgentTranscriptLocation, UsageParserOptions] => [
                location,
                {
                    isContinuation: index > 0 || this.options.isContinuation,
                    isCountedElsewhere: this.options.isCountedElsewhere,
                },
            ]),
            ...files.side.map((location): [AgentTranscriptLocation, UsageParserOptions] => [
                location,
                { isSideStream: true },
            ]),
        ];
    }

    /**
     * An Antigravity database has no byte cursor to resume from, so each advance re-reads the conversation into a fresh
     * aggregate. One model call (a `gen_metadata` row) is one billed unit.
     */
    private readAntigravity(files: UsageTranscriptFiles): void {
        const accumulator = new UsageAccumulator();
        accumulator.bornAt = files.bornAt;
        const conversation = readAntigravityConversation(files.main.path);
        const activity = conversation?.activity ?? [];
        for (const at of activity) accumulator.markActivity(at);
        accumulator.endStream();
        const conversationId = basename(files.main.path, '.db');
        const generations = conversation?.generations ?? [];
        for (const generation of generations) {
            const at = generation.at ?? activity.at(-1);
            if (at === undefined) continue;
            const digest = usageKeyDigest('antigravity', `${conversationId}:${generation.index}`);
            accumulator.addKey(digest);
            if (this.options.isCountedElsewhere?.(digest)) continue;
            accumulator.addUsage(
                at,
                generation.model,
                {
                    input: generation.input,
                    output: generation.output,
                    cacheRead: generation.cacheRead,
                    cacheWrite: generation.cacheWrite,
                    cacheWrite1h: 0,
                    reasoning: generation.reasoning,
                },
                {
                    contextTokens: generation.input + generation.cacheRead + generation.cacheWrite,
                },
            );
        }
        this.accumulator = accumulator;
    }

    private async readAppended(files: UsageTranscriptFiles): Promise<StreamReadOutcome> {
        if (this.provider === 'antigravity') {
            this.readAntigravity(files);
            return 'read';
        }
        this.accumulator.bornAt = files.bornAt;
        for (const [location, options] of this.parserOptions(files)) {
            let stream = this.streams.get(location.path);
            if (!stream) {
                const side = options.isSideStream
                    ? new SideUsageAccumulator(this.accumulator)
                    : undefined;
                stream = {
                    location,
                    cursor: { offset: 0 },
                    parser: usageParserFor(this.provider, side ?? this.accumulator, {
                        ...options,
                        claudeMessages: this.claudeMessages,
                    }),
                    ...(side && { side }),
                    ...(this.options.onFailure && { onFailure: this.options.onFailure }),
                };
                this.streams.set(location.path, stream);
            }
            // eslint-disable-next-line no-await-in-loop -- files are folded one at a time to bound memory
            if ((await readCompleteLines(stream)) === 'reset') return 'reset';
            stream.parser.flush?.();
        }
        return 'read';
    }

    /**
     * Reads every complete record appended since the previous call. Files new to this scan (a subagent started since)
     * are read from their start. A file the provider rewrote shorter invalidates everything derived so far, so the
     * whole scan restarts from byte zero instead of counting the surviving records twice.
     */
    async advance(files: UsageTranscriptFiles): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- a reset rereads every file once
            if ((await this.readAppended(files)) === 'read') return;
            this.accumulator = new UsageAccumulator();
            this.streams = new Map();
            this.claudeMessages = new Map();
        }
    }

    toRecord(): UsageRecord {
        return this.accumulator.toRecord();
    }

    /**
     * The share of {@link toRecord} one side file (a Claude subagent) billed, or `undefined` when this scan has not read
     * that file.
     */
    sideRecord(path: string): UsageRecord | undefined {
        return this.streams.get(path)?.side?.toRecord();
    }
}

interface ReadPass {
    /**
     * File size the pass saw, or `undefined` when the file could not be opened safely.
     */
    size: number | undefined;
    isReset: boolean;
}

/**
 * One bounded pass of `scanTranscriptLines`. Each pass ends by delivering the unconsumed remainder (a record still
 * being written, or the part cut off by the pass budget) without moving the cursor past it; that remainder is held back
 * here and read whole on a later pass.
 */
async function readPass(stream: UsageStream): Promise<ReadPass> {
    const { cursor, location, parser } = stream;
    /**
     * Set from the reader's callback; an object so the checks after the `await` are not narrowed away.
     */
    const reset = { isReset: false };
    let pending: string | undefined;
    const size = await scanTranscriptLines(
        location,
        cursor,
        (line) => {
            if (pending) parser.line(pending);
            pending = line;
        },
        {
            onReset: () => {
                reset.isReset = true;
            },
            ...(stream.onFailure && { onFailure: stream.onFailure }),
        },
    );
    // Past an oversized record, and at the end of a compressed transcript (never appended to), the reader delivers no
    // remainder, so the last line it delivered was complete.
    if (
        pending &&
        (cursor.skippingOversizedLine || isCompressedTranscriptPath(location.path)) &&
        !reset.isReset
    )
        parser.line(pending);
    return { size, isReset: reset.isReset };
}

/**
 * Feeds the complete lines after the stream's cursor to its parser through the shared symlink- and hardlink-safe
 * transcript reader, yielding between bounded passes so a large transcript never monopolizes Server Core. Reports
 * `reset` when the file shrank below the cursor.
 */
async function readCompleteLines(stream: UsageStream): Promise<StreamReadOutcome> {
    const { cursor } = stream;
    for (;;) {
        const before = cursor.offset;
        // eslint-disable-next-line no-await-in-loop -- each pass resumes at the cursor advanced by the previous pass
        const pass = await readPass(stream);
        if (pass.isReset) return 'reset';
        if (pass.size === undefined || cursor.offset >= pass.size || cursor.offset <= before)
            return 'read';
        // eslint-disable-next-line no-await-in-loop -- yield between passes
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

export async function scanUsage(
    provider: AgentProvider,
    files: UsageTranscriptFiles,
    options?: UsageScanOptions,
): Promise<UsageRecord> {
    const scan = new IncrementalUsageScan(provider, options);
    await scan.advance(files);
    return scan.toRecord();
}

/**
 * Counts the closed reasons a compressed transcript could not be fully read, for the `usage.external_scan` event.
 */
export function compressedFailureCounter() {
    const counts = { decompressFailed: 0, decompressLimit: 0 };
    const onFailure = (reason: TranscriptScanFailureReason) => {
        if (reason === 'decompressFailed' || reason === 'decompressLimit') counts[reason] += 1;
    };
    return { counts, onFailure };
}
