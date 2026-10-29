import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

import type { AgentProvider, AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';
import { MOBILE_MESSAGE_READ_MAX_BYTES } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { AgentEnvironment } from './contract';
import { agentProviders } from './providers';
import { TimelineBuilder } from './timeline-model';
import { locateAgentTranscript } from './transcript';
import { openSafeAgentTranscript } from './transcript-security';

const READ_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_CACHED_TRANSCRIPTS = 16;
/**
 * Characters one message keeps when it is read in full: one more than `MOBILE_MESSAGE_READ_MAX_BYTES`, so a message
 * over the bound is seen to exceed it instead of passing as a prefix.
 */
const FULL_MESSAGE_CHARS = MOBILE_MESSAGE_READ_MAX_BYTES + 1;

interface TranscriptLine {
    offset: number;
    text: string;
}

interface CachedTranscript {
    /**
     * The projection of every line from `start` to `end`, fed only the appended lines on each read. It replaces the raw
     * line text this cache used to keep and re-parse on every read: `agent.excerpts` reads each Session's newest page
     * about once a minute, and re-parsing up to 16 MiB of JSONL per Session for 40 items dominated Server Core CPU
     * while the raw lines held tens of megabytes of transcript text in memory.
     */
    builder: TimelineBuilder;
    end: number;
    fileIdentity: string;
    /**
     * Offset of the first line the projection read, or `undefined` when it read none.
     */
    firstLineOffset: number | undefined;
    generation: string;
    modifiedAt: number;
    path: string;
    start: number;
    tailSignature: string;
}

interface TimelineReadQueue {
    generation: number;
    tail: Promise<void>;
}

const missingTimeline = (): MobileTimelineReadResult => ({
    status: 'missing',
    items: [],
    truncated: false,
    cursorExpired: false,
});

async function tailSignature(handle: FileHandle, end: number): Promise<string> {
    if (end <= 0) return '';
    const length = Math.min(64, end);
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, end - length);
    return buffer.subarray(0, result.bytesRead).toString('hex');
}

function parseCursor(
    value: string,
): { generation: string; offset: number; part: number } | undefined {
    const match = /^([\da-z.-]+):([\da-z]+):([\da-z]+)$/u.exec(value);
    if (!match) return;
    const offset = Number.parseInt(match[2], 36);
    const part = Number.parseInt(match[3], 36);
    return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(part) && part >= 0
        ? { generation: match[1], offset, part }
        : undefined;
}

async function readWindow(
    handle: FileHandle,
    start: number,
    end: number,
    shouldSkipInitialPartial: boolean,
): Promise<{ lines: TranscriptLine[]; consumedEnd: number }> {
    const buffer = Buffer.allocUnsafe(end - start);
    let read = 0;
    while (read < buffer.length) {
        // eslint-disable-next-line no-await-in-loop -- the next file offset depends on the previous read
        const result = await handle.read(buffer, read, buffer.length - read, start + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
    }
    const bytes = buffer.subarray(0, read);
    const first = shouldSkipInitialPartial ? bytes.indexOf(0x0a) + 1 : 0;
    if (shouldSkipInitialPartial && first === 0) return { lines: [], consumedEnd: start + read };
    const last = bytes.lastIndexOf(0x0a);
    if (last < first)
        return {
            lines: [],
            consumedEnd: read >= READ_WINDOW_BYTES ? start + read : start,
        };
    const lines: TranscriptLine[] = [];
    let lineStart = first;
    for (let index = first; index <= last; index++) {
        if (bytes[index] !== 0x0a) continue;
        if (index - lineStart <= MAX_LINE_BYTES)
            lines.push({
                offset: start + lineStart,
                text: bytes.subarray(lineStart, index).toString('utf8'),
            });
        lineStart = index + 1;
    }
    return { lines, consumedEnd: start + last + 1 };
}

function projectLines(
    builder: TimelineBuilder,
    provider: AgentProvider,
    lines: readonly TranscriptLine[],
): TimelineBuilder {
    /**
     * Resolved once per batch rather than per line: `read()` already proved this provider has a projector before any
     * transcript byte was opened, so a missing one here would be an internal inconsistency, not user input.
     */
    const project = agentProviders[provider].timelineProjector;
    if (!project) throw new Error(`Agent provider "${provider}" has no timeline projector`);
    for (const line of lines) {
        try {
            const record: unknown = JSON.parse(line.text);
            project(builder, record, line.offset);
        } catch {
            // A partial or future provider record is a capability miss, never a diagnostic payload.
        }
    }
    return builder;
}

function boundedPage(
    entries: ReadonlyArray<{ item: AgentTimelineItem; offset: number; part: number }>,
    before: { offset: number; part: number } | undefined,
    limit: number,
    start: number,
    isCursorExpired: boolean,
): MobileTimelineReadResult {
    const candidates = entries.filter(
        (entry) =>
            before === undefined ||
            entry.offset < before.offset ||
            (entry.offset === before.offset && entry.part < before.part),
    );
    const selected: typeof candidates = [];
    let bytes = 512;
    for (let index = candidates.length - 1; index >= 0 && selected.length < limit; index--) {
        const entry = candidates[index];
        const cost = Buffer.byteLength(JSON.stringify(entry.item), 'utf8') + 1;
        if (bytes + cost > MAX_RESULT_BYTES) break;
        bytes += cost;
        selected.unshift(entry);
    }
    const oldest = selected.at(0);
    const older =
        oldest !== undefined &&
        (candidates.some(
            (entry) =>
                entry.offset < oldest.offset ||
                (entry.offset === oldest.offset && entry.part < oldest.part),
        ) ||
            start > 0);
    return {
        status: 'available',
        items: selected.map((entry) => entry.item),
        ...(older && { olderCursor: oldest.item.id }),
        truncated: start > 0,
        cursorExpired: isCursorExpired,
    };
}

/**
 * A bounded, rebuildable projection. It reads only appended bytes on repeated visits and retains a finite window for
 * older pages. The cursor carries file identity plus byte offset, so a replaced rollout never inherits stale history.
 */
/* eslint-disable unicorn/consistent-class-member-order -- Public read API precedes private read helpers. */
export class AgentTimelineService {
    readonly #cache = new Map<string, CachedTranscript>();
    readonly #revisions = new Map<string, number>();
    readonly #reads = new Map<string, TimelineReadQueue>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly environment: AgentEnvironment,
    ) {}

    forgetTerminal(terminalId: string): void {
        const reads = this.#reads.get(terminalId);
        if (reads) reads.generation += 1;
        this.#cache.delete(terminalId);
        this.#revisions.delete(terminalId);
    }

    async read(
        sessionId: string,
        terminalId: string,
        before: string | undefined,
        limit: number,
    ): Promise<MobileTimelineReadResult> {
        return this.#serialized(terminalId, missingTimeline(), () =>
            this.#readCurrent(sessionId, terminalId, before, limit),
        );
    }

    /**
     * The whole text of one timeline message, which the page keeps only the first 4,096 characters of. The id's byte
     * offset locates the message's first record; the records from there on are projected again with a larger message
     * limit, so a reply the Agent streamed over several records is joined as the timeline joins it. Resolves
     * `undefined` when the id belongs to a transcript that was rewritten since, or names no message.
     */
    async readMessage(
        sessionId: string,
        terminalId: string,
        itemId: string,
    ): Promise<string | undefined> {
        return this.#serialized(terminalId, undefined, () =>
            this.#readMessageText(sessionId, terminalId, itemId),
        );
    }

    async #serialized<T>(terminalId: string, forgotten: T, run: () => Promise<T>): Promise<T> {
        const queue = this.#reads.get(terminalId) ?? { generation: 0, tail: Promise.resolve() };
        const previous = queue.tail;
        const release = Promise.withResolvers<void>();
        const generation = queue.generation;
        queue.tail = release.promise;
        this.#reads.set(terminalId, queue);
        await previous;
        try {
            if (queue.generation !== generation) return forgotten;
            const result = await run();
            return queue.generation === generation ? result : forgotten;
        } finally {
            /**
             * A forgotten Terminal cannot regain cached history from an older in-flight read.
             */
            if (queue.generation !== generation) {
                this.#cache.delete(terminalId);
                this.#revisions.delete(terminalId);
            }
            release.resolve();
            if (queue.tail === release.promise) this.#reads.delete(terminalId);
        }
    }

    async #readMessageText(
        sessionId: string,
        terminalId: string,
        itemId: string,
    ): Promise<string | undefined> {
        const requested = parseCursor(itemId);
        if (!requested) return;
        // The newest page brings the cache, and so the current generation, up to date with the file.
        const page = await this.#readCurrent(sessionId, terminalId, undefined, 1);
        const state = this.#cache.get(terminalId);
        if (page.status !== 'available' || state?.generation !== requested.generation) return;
        const terminal = this.database.getTerminal(terminalId);
        const provider = terminal?.provider;
        if (!provider) return;
        const location = await locateAgentTranscript(this.database, terminalId, this.environment);
        const opened = location && (await openSafeAgentTranscript(location));
        if (!opened) return;
        try {
            const { path, stats } = opened;
            if (path !== state.path || requested.offset >= stats.size) return;
            const read = await readWindow(
                opened.handle,
                requested.offset,
                Math.min(stats.size, requested.offset + READ_WINDOW_BYTES),
                false,
            );
            const builder = projectLines(
                new TimelineBuilder(state.generation, FULL_MESSAGE_CHARS),
                provider,
                read.lines,
            );
            const item = builder.entries.find((entry) => entry.item.id === itemId)?.item;
            return item?.type === 'userMessage' || item?.type === 'agentMessage'
                ? item.text
                : undefined;
        } finally {
            await opened.handle.close();
        }
    }

    /**
     * Serialize file identity, revision, and append updates across independently connected readers.
     */
    async #readCurrent(
        sessionId: string,
        terminalId: string,
        before: string | undefined,
        limit: number,
    ): Promise<MobileTimelineReadResult> {
        const terminal = this.database.getTerminal(terminalId);
        if (terminal?.sessionId !== sessionId || !terminal.provider) return missingTimeline();
        const provider = terminal.provider;
        if (!agentProviders[provider].timelineProjector)
            return { status: 'unsupported', items: [], truncated: false, cursorExpired: false };
        const location = await locateAgentTranscript(this.database, terminalId, this.environment);
        const opened = location && (await openSafeAgentTranscript(location));
        if (!opened) return missingTimeline();
        try {
            const { handle, path, stats } = opened;
            const fileIdentity = `${stats.dev.toString(36)}.${stats.ino.toString(36)}.${Math.floor(stats.birthtimeMs).toString(36)}`;
            let state = this.#cache.get(terminalId);
            const hasOldTailChanged = Boolean(
                state &&
                stats.size >= state.end &&
                (await tailSignature(handle, state.end)) !== state.tailSignature,
            );
            const isRewritten =
                state?.fileIdentity === fileIdentity &&
                (hasOldTailChanged ||
                    stats.size < state.end ||
                    (stats.size === state.end && stats.mtimeMs !== state.modifiedAt));
            if (isRewritten)
                this.#revisions.set(terminalId, (this.#revisions.get(terminalId) ?? 0) + 1);
            const generation = `${fileIdentity}.${(this.#revisions.get(terminalId) ?? 0).toString(36)}`;
            const isStale =
                !state ||
                hasOldTailChanged ||
                state.path !== path ||
                state.fileIdentity !== fileIdentity ||
                stats.size < state.end ||
                (stats.size === state.end && stats.mtimeMs !== state.modifiedAt);
            /**
             * Appending more than one read window, or growing the projection past its retained span, starts a new
             * projection from the newest window, as a first read does. Older pages then come from the file.
             */
            if (
                !state ||
                isStale ||
                stats.size - state.end > READ_WINDOW_BYTES ||
                stats.size - state.start > MAX_RETAINED_BYTES
            ) {
                const start = Math.max(0, stats.size - READ_WINDOW_BYTES);
                const read = await readWindow(handle, start, stats.size, start > 0);
                state = {
                    builder: projectLines(new TimelineBuilder(generation), provider, read.lines),
                    end: read.consumedEnd,
                    fileIdentity,
                    firstLineOffset: read.lines[0]?.offset,
                    generation,
                    modifiedAt: stats.mtimeMs,
                    path,
                    start,
                    tailSignature: await tailSignature(handle, read.consumedEnd),
                };
                this.#cache.delete(terminalId);
                this.#cache.set(terminalId, state);
                if (this.#cache.size > MAX_CACHED_TRANSCRIPTS)
                    this.#cache.delete(this.#cache.keys().next().value!);
            } else if (stats.size > state.end) {
                const read = await readWindow(handle, state.end, stats.size, false);
                projectLines(state.builder, provider, read.lines);
                state.firstLineOffset ??= read.lines[0]?.offset;
                state.end = read.consumedEnd;
                state.modifiedAt = stats.mtimeMs;
                state.tailSignature = await tailSignature(handle, state.end);
            }
            const requested = before ? parseCursor(before) : undefined;
            const isCursorExpired = Boolean(
                before &&
                (!requested ||
                    requested.generation !== generation ||
                    requested.offset > stats.size),
            );
            const beforePosition = isCursorExpired ? undefined : requested;
            /**
             * A cursor before the first projected line reads the file. A cursor at that line's later part stays here,
             * because the projection holds the line's earlier siblings.
             */
            if (
                beforePosition !== undefined &&
                state.start > 0 &&
                (beforePosition.offset < state.start ||
                    state.firstLineOffset === undefined ||
                    beforePosition.offset < state.firstLineOffset ||
                    (beforePosition.offset === state.firstLineOffset && beforePosition.part === 0))
            )
                return await this.#olderPage(handle, state, provider, beforePosition, limit);
            return boundedPage(
                state.builder.entries,
                beforePosition,
                limit,
                state.start,
                isCursorExpired,
            );
        } finally {
            await opened.handle.close();
        }
    }

    async #olderPage(
        handle: FileHandle,
        state: CachedTranscript,
        provider: AgentProvider,
        before: { offset: number; part: number },
        limit: number,
    ): Promise<MobileTimelineReadResult> {
        /**
         * A cursor inside a multi-entry record must retain its earlier siblings after cache eviction.
         */
        let end =
            before.part > 0
                ? Math.min(state.end, before.offset + MAX_LINE_BYTES + 1)
                : before.offset;
        for (let pass = 0; pass < 4; pass++) {
            const start = Math.max(0, end - READ_WINDOW_BYTES);
            // eslint-disable-next-line no-await-in-loop -- each bounded older window begins where the previous one ended
            const read = await readWindow(handle, start, end, start > 0);
            const page = boundedPage(
                projectLines(new TimelineBuilder(state.generation), provider, read.lines).entries,
                before,
                limit,
                start,
                false,
            );
            if (start === 0 || page.items.length > 0) return page;
            end = read.lines[0]?.offset ?? start;
            if (end <= 0) break;
        }
        return {
            status: 'available',
            items: [],
            olderCursor: `${state.generation}:${end.toString(36)}:0`,
            truncated: true,
            cursorExpired: false,
        };
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
