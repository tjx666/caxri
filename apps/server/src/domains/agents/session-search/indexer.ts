import { lstat } from 'node:fs/promises';

import { mapWithConcurrency } from '@caxri/system';

import type { AgentEnvironment } from '../contract';
import type { CodexThreadIndex, ParsedConversation } from '../external-conversation-parsers';
import {
    parseConversationCandidate,
    readCodexThreadIndex,
    settled,
} from '../external-conversation-parsers';
import { compactInlineMediaPayloads } from '../inline-media';
import type { DiscoveredTranscript } from '../transcript-discovery';
import { discoverTranscripts } from '../transcript-discovery';
import type { TranscriptScanCursor } from '../transcript-scan';
import { scanTranscriptLines } from '../transcript-scan';
import type { AgentTranscriptLocation } from '../transcript-security';
import type { VisibleTranscriptMessage } from '../visible-transcript-message';
import { extractVisibleTranscriptMessage } from '../visible-transcript-message';
import type {
    IndexedMessage,
    SessionSearchStore,
    StoredTranscript,
    TranscriptUpsert,
} from './store';

/**
 * Pasted screenshots are collapsed before parsing, the same ceiling the conversation reader uses.
 */
const MAX_RECORD_CHARS = 256 * 1024;
/**
 * One message keeps its head past this. A pasted log rarely holds what someone searches for, and it would otherwise
 * dominate the index.
 */
const MAX_MESSAGE_CHARS = 32 * 1024;
/**
 * Indexed text per transcript. Far above a real conversation's visible text, so it only bounds a pathological file.
 */
const MAX_TRANSCRIPT_CHARS = 8 * 1024 * 1024;
/**
 * A final record without a trailing newline is indexed once its file has not changed for this long: a writer that never
 * terminates its last line would otherwise hide that message forever.
 */
const SETTLED_TAIL_MS = 60_000;
const IDENTITY_CONCURRENCY = 16;

export interface IndexerProgress {
    isRunning: boolean;
    /**
     * Transcripts changed since the previous pass that this pass has not read yet.
     */
    pending: number;
}

/**
 * Content-free counts from one refresh pass, for the Server's diagnostic log.
 */
export interface IndexerPassReport {
    durationMs: number;
    discovered: number;
    changed: number;
    failed: number;
    removed: number;
}

interface FileIdentity {
    inode: number;
    size: number;
    mtimeMs: number;
}

interface ChangedTranscript {
    found: DiscoveredTranscript;
    identity: FileIdentity;
    stored?: StoredTranscript;
}

async function fileIdentity(path: string): Promise<FileIdentity | undefined> {
    try {
        const stats = await lstat(path);
        if (!stats.isFile()) return;
        return { inode: stats.ino, size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) };
    } catch {
        return undefined;
    }
}

function isUnchanged(stored: StoredTranscript | undefined, identity: FileIdentity): boolean {
    return (
        stored !== undefined &&
        stored.inode === identity.inode &&
        stored.size === identity.size &&
        stored.mtimeMs === identity.mtimeMs
    );
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Turns transcript lines into indexed messages through the visible-message boundary shared with title generation and
 * the conversation reader: tool calls, tool output, sidechains, and injected instructions never reach the index. A run
 * of Grok stream chunks is joined into one message.
 */
class MessageCollector {
    private messages: IndexedMessage[] = [];

    private chunk: IndexedMessage | undefined;

    constructor(private remainingChars: number) {}

    private add(message: VisibleTranscriptMessage): void {
        if (message.isChunk && this.chunk?.role === message.role) {
            if (this.chunk.text.length < MAX_MESSAGE_CHARS) this.chunk.text += message.text;
            return;
        }
        this.closeChunk();
        if (message.isChunk) this.chunk = { role: message.role, text: message.text };
        else this.push(message.role, message.text);
    }

    private closeChunk(): void {
        if (!this.chunk) return;
        this.push(this.chunk.role, this.chunk.text);
        this.chunk = undefined;
    }

    private push(role: IndexedMessage['role'], raw: string): void {
        const text = raw.trim().slice(0, MAX_MESSAGE_CHARS);
        if (!text || text.length > this.remainingChars) return;
        this.remainingChars -= text.length;
        this.messages.push({ role, text });
    }

    accept(line: string): void {
        if (!line.trim()) return;
        const recordLine = line.length > MAX_RECORD_CHARS ? compactInlineMediaPayloads(line) : line;
        let record: unknown;
        try {
            record = JSON.parse(recordLine);
        } catch {
            this.closeChunk();
            return;
        }
        const message = extractVisibleTranscriptMessage(record);
        if (message) this.add(message);
        else this.closeChunk();
    }

    reset(remainingChars: number): void {
        this.messages = [];
        this.chunk = undefined;
        this.remainingChars = remainingChars;
    }

    drain(): IndexedMessage[] {
        this.closeChunk();
        const drained = this.messages;
        this.messages = [];
        return drained;
    }
}

function indexedLength(messages: readonly IndexedMessage[]): number {
    return messages.reduce((total, message) => total + message.text.length, 0);
}

/**
 * Brings the index up to date with the providers' transcript directories: new and grown files are read from their saved
 * cursor, rewritten or replaced files from the start, and vanished files are dropped. Files are read newest first, so
 * recent conversations become searchable before years of history finish.
 */
export class SessionSearchIndexer {
    private running: Promise<IndexerPassReport> | undefined;

    private pending = 0;

    constructor(
        private readonly store: SessionSearchStore,
        private readonly environment: AgentEnvironment,
        private readonly now: () => number = Date.now,
    ) {}

    private async parse(
        transcript: Pick<StoredTranscript, 'agentSessionId' | 'path' | 'provider'>,
        identity: FileIdentity,
        codex: CodexThreadIndex | undefined,
    ): Promise<ParsedConversation | undefined> {
        const parsed = await settled(() =>
            parseConversationCandidate(
                {
                    provider: transcript.provider,
                    providerSessionId: transcript.agentSessionId,
                    path: transcript.path,
                    updatedAt: identity.mtimeMs,
                },
                codex?.names ?? new Map(),
            ),
        );
        return parsed ?? undefined;
    }

    private async runPassOnce(): Promise<IndexerPassReport> {
        try {
            return await this.runPass();
        } finally {
            this.running = undefined;
            this.pending = 0;
        }
    }

    private async runPass(): Promise<IndexerPassReport> {
        const started = this.now();
        const discovered = await discoverTranscripts(this.environment);
        const stored = new Map(this.store.transcripts().map((row) => [row.path, row]));
        const seen = new Set(discovered.map((found) => found.main.path));
        const changed: ChangedTranscript[] = [];
        await mapWithConcurrency(discovered, IDENTITY_CONCURRENCY, async (found) => {
            const identity = await fileIdentity(found.main.path);
            const row = stored.get(found.main.path);
            if (identity && !isUnchanged(row, identity))
                changed.push({ found, identity, stored: row });
        });
        let removed = 0;
        for (const row of stored.values()) {
            // A discovery budget or a transient directory error must not drop a file that still exists.
            // eslint-disable-next-line no-await-in-loop -- rows are few; each needs its own existence check
            if (seen.has(row.path) || (await fileIdentity(row.path))) continue;
            this.store.deleteTranscript(row.id);
            removed += 1;
        }
        changed.sort((left, right) => right.identity.mtimeMs - left.identity.mtimeMs);
        this.pending = changed.length;
        const codex = await readCodexThreadIndex(
            this.environment,
            changed.flatMap(({ found }) =>
                found.provider === 'codex' ? [found.agentSessionId] : [],
            ),
        );
        let failed = 0;
        for (const entry of changed) {
            try {
                // eslint-disable-next-line no-await-in-loop -- one file at a time bounds memory and open handles
                await this.indexTranscript(entry, codex);
            } catch {
                failed += 1;
            }
            this.pending -= 1;
            // eslint-disable-next-line no-await-in-loop -- lets queued queries run between files
            await yieldToEventLoop();
        }
        await this.refreshCodexNames();
        return {
            durationMs: this.now() - started,
            discovered: discovered.length,
            changed: changed.length,
            failed,
            removed,
        };
    }

    /**
     * A Codex rename updates its private thread table without touching the rollout, so names are re-read every pass.
     */
    private async refreshCodexNames(): Promise<void> {
        const rows = this.store.conversations(['codex']).filter((row) => !row.isContinuation);
        if (rows.length === 0) return;
        const { names } = await readCodexThreadIndex(
            this.environment,
            rows.map((row) => row.agentSessionId),
        );
        for (const row of rows) {
            const name = names.get(row.agentSessionId);
            if (name && name !== row.title) this.store.updateTitle(row.id, name);
        }
    }

    private async indexTranscript(
        { found, identity, stored }: ChangedTranscript,
        codex: CodexThreadIndex,
    ): Promise<void> {
        const isSameFile =
            stored !== undefined &&
            stored.inode === identity.inode &&
            identity.size >= stored.scanOffset;
        if (stored && !isSameFile) this.store.clearMessages(stored.id);
        const base: TranscriptUpsert = {
            path: found.main.path,
            provider: found.provider,
            agentSessionId: found.agentSessionId,
            ...(found.main.anchorRoot !== undefined && { anchorRoot: found.main.anchorRoot }),
            baseRoot: found.main.baseRoot,
            root: found.main.root,
            isContinuation: found.isContinuation,
            ...identity,
            scanOffset: isSameFile ? stored.scanOffset : 0,
            isSkippingLine: isSameFile ? stored.isSkippingLine : false,
            state: 'excluded',
            indexedChars: isSameFile ? stored.indexedChars : 0,
        };
        const parsed =
            found.provider === 'codex' && codex.skipped.has(found.agentSessionId)
                ? undefined
                : await this.parse(
                      {
                          provider: found.provider,
                          agentSessionId: found.agentSessionId,
                          path: found.main.path,
                      },
                      identity,
                      codex,
                  );
        if (!parsed) {
            if (stored) this.store.clearMessages(stored.id);
            this.store.saveTranscript({
                ...base,
                scanOffset: 0,
                isSkippingLine: false,
                indexedChars: 0,
            });
            return;
        }
        const conversation: TranscriptUpsert = {
            ...base,
            state: 'conversation',
            cwd: parsed.cwd,
            ...(parsed.title !== undefined && { title: parsed.title }),
        };
        /**
         * Until the scan finishes the row keeps a size that can never match, so a pass interrupted by a Worker shutdown
         * reads the rest of the file next time instead of trusting a half-indexed one.
         */
        const id = this.store.saveTranscript({ ...conversation, size: -1 });
        const final = await this.scanContent({ ...conversation, id }, identity);
        this.store.saveTranscript(final);
    }

    private async scanContent(
        transcript: TranscriptUpsert & { id: number },
        identity: FileIdentity,
    ): Promise<TranscriptUpsert & { id: number }> {
        const location: AgentTranscriptLocation = {
            ...(transcript.anchorRoot !== undefined && { anchorRoot: transcript.anchorRoot }),
            baseRoot: transcript.baseRoot,
            root: transcript.root,
            path: transcript.path,
        };
        const cursor: TranscriptScanCursor = {
            offset: transcript.scanOffset,
            skippingOversizedLine: transcript.isSkippingLine,
        };
        let { indexedChars } = transcript;
        const collector = new MessageCollector(MAX_TRANSCRIPT_CHARS - indexedChars);
        const checkpoint = (messages: readonly IndexedMessage[]) => {
            indexedChars += indexedLength(messages);
            this.store.appendMessages(
                {
                    ...transcript,
                    size: -1,
                    scanOffset: cursor.offset,
                    isSkippingLine: cursor.skippingOversizedLine === true,
                    indexedChars,
                },
                messages,
            );
        };
        for (;;) {
            const before = cursor.offset;
            // eslint-disable-next-line no-await-in-loop -- each 4 MiB pass resumes at the cursor the previous one advanced
            const size = await scanTranscriptLines(
                location,
                cursor,
                (line) => collector.accept(line),
                {
                    completeLinesOnly: true,
                    onReset: () => {
                        // The provider rewrote the file shorter than what was read: start over from byte zero.
                        this.store.clearMessages(transcript.id);
                        indexedChars = 0;
                        collector.reset(MAX_TRANSCRIPT_CHARS);
                    },
                },
            );
            checkpoint(collector.drain());
            if (size === undefined || cursor.offset <= before || cursor.offset >= size) break;
            // eslint-disable-next-line no-await-in-loop -- lets queued queries run between passes over one large file
            await yieldToEventLoop();
        }
        if (cursor.offset < identity.size && this.now() - identity.mtimeMs > SETTLED_TAIL_MS)
            await this.indexSettledTail(location, cursor, collector, checkpoint);
        return {
            ...transcript,
            scanOffset: cursor.offset,
            isSkippingLine: cursor.skippingOversizedLine === true,
            indexedChars,
        };
    }

    private async indexSettledTail(
        location: AgentTranscriptLocation,
        cursor: TranscriptScanCursor,
        collector: MessageCollector,
        checkpoint: (messages: readonly IndexedMessage[]) => void,
    ): Promise<void> {
        const probe: TranscriptScanCursor = { ...cursor };
        const lines: string[] = [];
        const size = await scanTranscriptLines(location, probe, (line) => lines.push(line));
        // Anything other than exactly the one unterminated line means the file moved on; the next pass reads it.
        if (size === undefined || probe.offset !== cursor.offset || lines.length !== 1) return;
        try {
            JSON.parse(lines[0]);
        } catch {
            return;
        }
        collector.accept(lines[0]);
        cursor.offset = size;
        checkpoint(collector.drain());
    }

    progress(): IndexerProgress {
        return { isRunning: this.running !== undefined, pending: this.pending };
    }

    /**
     * Runs one pass, or joins the pass already running.
     */
    refresh(): Promise<IndexerPassReport> {
        this.running ??= this.runPassOnce();
        return this.running;
    }

    /**
     * Re-reads a conversation's folder and title from its transcript now, rather than trusting the index: the file may
     * have been removed or changed since the last pass.
     */
    async inspect(
        provider: StoredTranscript['provider'],
        agentSessionId: string,
    ): Promise<{ cwd: string; title?: string; updatedAt: number } | undefined> {
        const main = this.store
            .conversationTranscripts(provider, agentSessionId)
            .toSorted((left, right) => Number(left.isContinuation) - Number(right.isContinuation))
            .at(0);
        if (!main) return;
        const identity = await fileIdentity(main.path);
        if (!identity) return;
        const codex =
            provider === 'codex'
                ? await readCodexThreadIndex(this.environment, [agentSessionId])
                : undefined;
        if (codex?.skipped.has(agentSessionId)) return;
        const parsed = await this.parse(
            { provider, agentSessionId, path: main.path },
            identity,
            codex,
        );
        return parsed && { ...parsed, updatedAt: identity.mtimeMs };
    }
}
