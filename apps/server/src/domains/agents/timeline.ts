import { Buffer } from 'node:buffer';
import type { FileHandle } from 'node:fs/promises';

import type { AgentProvider, AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';

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

interface TranscriptLine {
    offset: number;
    text: string;
}

interface CachedTranscript {
    end: number;
    fileIdentity: string;
    generation: string;
    lines: TranscriptLine[];
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
/* eslint-disable unicorn/consistent-class-member-order -- Public read API precedes private page projection. */
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
        const queue = this.#reads.get(terminalId) ?? { generation: 0, tail: Promise.resolve() };
        const previous = queue.tail;
        const release = Promise.withResolvers<void>();
        const generation = queue.generation;
        queue.tail = release.promise;
        this.#reads.set(terminalId, queue);
        await previous;
        try {
            if (queue.generation !== generation) return missingTimeline();
            const page = await this.#readCurrent(sessionId, terminalId, before, limit);
            return queue.generation === generation ? page : missingTimeline();
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
            if (
                !state ||
                hasOldTailChanged ||
                state.path !== path ||
                state.fileIdentity !== fileIdentity ||
                stats.size < state.end ||
                (stats.size === state.end && stats.mtimeMs !== state.modifiedAt)
            ) {
                const start = Math.max(0, stats.size - READ_WINDOW_BYTES);
                const read = await readWindow(handle, start, stats.size, start > 0);
                state = {
                    end: read.consumedEnd,
                    fileIdentity,
                    generation,
                    lines: read.lines,
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
                const start =
                    stats.size - state.end > READ_WINDOW_BYTES
                        ? stats.size - READ_WINDOW_BYTES
                        : state.end;
                const read = await readWindow(handle, start, stats.size, start > state.end);
                if (start > state.end) {
                    state.lines = read.lines;
                    state.start = start;
                } else state.lines.push(...read.lines);
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
            while (state.end - state.start > MAX_RETAINED_BYTES && state.lines.length > 0) {
                const discarded = state.lines.shift()!;
                state.start = state.lines[0]?.offset ?? discarded.offset;
            }
            if (
                beforePosition !== undefined &&
                state.start > 0 &&
                (beforePosition.offset < state.start ||
                    (state.lines.every((line) => line.offset >= beforePosition.offset) &&
                        !(
                            beforePosition.part > 0 &&
                            state.lines.some((line) => line.offset === beforePosition.offset)
                        )))
            )
                return await this.#olderPage(handle, state, provider, beforePosition, limit);
            return this.#page(state, provider, beforePosition, limit, isCursorExpired);
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
            const page = this.#page(
                { ...state, lines: read.lines, start },
                provider,
                before,
                limit,
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

    #page(
        state: CachedTranscript,
        provider: AgentProvider,
        before: { offset: number; part: number } | undefined,
        limit: number,
        isCursorExpired: boolean,
    ): MobileTimelineReadResult {
        const builder = new TimelineBuilder(state.generation);
        /**
         * Resolved once per page rather than per line: `read()` already proved this provider has a projector before any
         * transcript byte was opened, so a missing one here would be an internal inconsistency, not user input.
         */
        const project = agentProviders[provider].timelineProjector;
        if (!project) throw new Error(`Agent provider "${provider}" has no timeline projector`);
        for (const line of state.lines) {
            try {
                const record: unknown = JSON.parse(line.text);
                project(builder, record, line.offset);
            } catch {
                // A partial or future provider record is a capability miss, never a diagnostic payload.
            }
        }
        return boundedPage(builder.entries, before, limit, state.start, isCursorExpired);
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
