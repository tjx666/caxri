import { lstat, opendir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';

import type { AgentEnvironment, AgentTranscriptLocation, TranscriptScanCursor } from '../agents';
import { agentProviders, locateAgentTranscriptForIdentity, scanTranscriptLines } from '../agents';
import { UsageAccumulator } from './accumulator';
import type { UsageLineParser } from './parsers';
import { usageParserFor } from './parsers';
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

export interface UsageScanTarget {
    provider: AgentProvider;
    agentSessionId: string;
    cwd: string;
}

export interface UsageTranscriptFiles {
    main: AgentTranscriptLocation;
    /**
     * Claude subagent transcripts (`<conversation>/subagents/*.jsonl`): billed tokens without their own Agent Session.
     */
    side: AgentTranscriptLocation[];
    /**
     * Size and mtime of every file; equal fingerprints mean an unchanged aggregate.
     */
    fingerprint: string;
}

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

async function fileStamp(path: string): Promise<string | undefined> {
    try {
        const stats = await lstat(path);
        return stats.isFile() ? `${stats.size}:${Math.trunc(stats.mtimeMs)}` : undefined;
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

    constructor(private readonly environment: AgentEnvironment) {}

    private claudeBaseRoot(): string | undefined {
        return agentProviders.claude.transcriptBaseRoot?.(this.environment);
    }

    private async findClaudeTranscript(
        agentSessionId: string,
    ): Promise<AgentTranscriptLocation | undefined> {
        const baseRoot = this.claudeBaseRoot();
        if (!baseRoot) return;
        this.claudeDirectories ??= listDirectory(baseRoot);
        const fileName = `${agentSessionId}.jsonl`;
        const directories = await this.claudeDirectories;
        for (const directory of directories) {
            const root = join(baseRoot, directory);
            const path = join(root, fileName);
            // eslint-disable-next-line no-await-in-loop -- stops at the first directory holding the conversation
            if (await fileStamp(path)) return { baseRoot, root, path };
        }
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

    async locate(target: UsageScanTarget): Promise<UsageTranscriptFiles | undefined> {
        let main = await locateAgentTranscriptForIdentity(target, this.environment);
        let mainStamp = main && (await fileStamp(main.path));
        if (!mainStamp && target.provider === 'claude') {
            main = await this.findClaudeTranscript(target.agentSessionId);
            mainStamp = main && (await fileStamp(main.path));
        }
        if (!main || !mainStamp) return;
        const side = target.provider === 'claude' ? await this.claudeSideFiles(main) : [];
        const stamps = await Promise.all(side.map((file) => fileStamp(file.path)));
        return {
            main,
            side,
            fingerprint: [
                `v${USAGE_RECORD_VERSION}`,
                mainStamp,
                ...stamps.map((stamp) => stamp ?? '-'),
            ].join('|'),
        };
    }
}

type StreamReadOutcome = 'read' | 'reset';

interface UsageStream {
    location: AgentTranscriptLocation;
    cursor: TranscriptScanCursor;
    parser: UsageLineParser;
}

/**
 * Folds one Agent Session's transcript files into a {@link UsageRecord} and can resume where it stopped: each file keeps
 * its read cursor and parser state, so a later {@link advance} parses only appended records. A full scan is one
 * `advance`; a live consumer (for example a per-Session usage readout) keeps the instance and calls `advance` again
 * whenever the transcript grows.
 */
export class IncrementalUsageScan {
    private accumulator = new UsageAccumulator();
    private streams = new Map<string, UsageStream>();

    constructor(private readonly provider: AgentProvider) {}

    private async readAppended(files: UsageTranscriptFiles): Promise<StreamReadOutcome> {
        for (const [index, location] of [files.main, ...files.side].entries()) {
            let stream = this.streams.get(location.path);
            if (!stream) {
                stream = {
                    location,
                    cursor: { offset: 0 },
                    parser: usageParserFor(this.provider, this.accumulator, {
                        isSideStream: index > 0,
                    }),
                };
                this.streams.set(location.path, stream);
            }
            // eslint-disable-next-line no-await-in-loop -- files are folded one at a time to bound memory
            if ((await readCompleteLines(stream)) === 'reset') return 'reset';
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
        }
    }

    toRecord(): UsageRecord {
        return this.accumulator.toRecord();
    }
}

/**
 * Feeds the complete lines after the stream's cursor to its parser through the shared symlink- and hardlink-safe
 * transcript reader, yielding between bounded passes so a large transcript never monopolizes Server Core. Each pass of
 * `scanTranscriptLines` ends by delivering the unconsumed remainder (a record still being written, or the part cut off
 * by the pass budget) without moving the cursor past it; that remainder is skipped here and read whole on a later pass.
 * Reports `reset` when the file shrank below the cursor.
 */
async function readCompleteLines(stream: UsageStream): Promise<StreamReadOutcome> {
    const { cursor, location, parser } = stream;
    /**
     * Set from the reader's callback; an object so the check after the `await` is not narrowed away.
     */
    const reset = { isReset: false };
    for (;;) {
        const before = cursor.offset;
        let pending: string | undefined;
        // eslint-disable-next-line no-await-in-loop -- each pass resumes at the cursor advanced by the previous pass
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
            },
        );
        if (reset.isReset) return 'reset';
        // Past an oversized record the reader delivers no remainder, so the last line it delivered was complete.
        if (pending && cursor.skippingOversizedLine) parser.line(pending);
        if (size === undefined || cursor.offset >= size || cursor.offset <= before) return 'read';
        // eslint-disable-next-line no-await-in-loop -- yield between passes
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

export async function scanUsage(
    provider: AgentProvider,
    files: UsageTranscriptFiles,
): Promise<UsageRecord> {
    const scan = new IncrementalUsageScan(provider);
    await scan.advance(files);
    return scan.toRecord();
}
