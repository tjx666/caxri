import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { readBoundedRegularFileText } from '@caxri/system';
import Database from 'better-sqlite3';

import type { AgentEnvironment } from './contract';
import { compactInlineMediaPayloads } from './inline-media';
import { claudeTranscriptRoot } from './providers/claude/paths';
import { resolveCodexStateDirectories } from './providers/codex/paths';
import type { SqliteColumn } from './providers/codex/state-databases';
import { findCodexStateDatabases } from './providers/codex/state-databases';
import { extractAgentTitleMessage } from './title-generation';

/**
 * Bounded transcript reads and per-provider parsing for `external-conversations.ts`. Every reader here sees only a
 * bounded head (and for Claude a bounded tail) of one transcript, and nothing here logs content, titles, or paths.
 */

export type ExternalConversationProvider = 'claude' | 'codex' | 'grok';

export interface ConversationCandidate {
    provider: ExternalConversationProvider;
    providerSessionId: string;
    /**
     * The transcript whose mtime is `updatedAt`: Claude `<id>.jsonl`, Codex rollout, Grok `updates.jsonl`.
     */
    path: string;
    updatedAt: number;
}

export interface ParsedConversation {
    cwd: string;
    title?: string;
    /**
     * Started by an application through the Claude Agent SDK, such as Caxri's own Agent Chat, rather than typed into a
     * terminal. Such a conversation is the user's only when a Caxri Session holds it: Session search shows it then, and
     * the outside-conversation list never does, since another application's SDK runs are usually scripted.
     */
    isHosted?: boolean;
}
const TITLE_MAX_CHARACTERS = 120;
/**
 * Every field this module needs sits at the start of a transcript. A Codex rollout opens with a ~20 KiB `session_meta`
 * record and injected AGENTS.md / environment blocks, which put the first real prompt past 100 KiB in practice, so the
 * head budget is larger than one chunk. Reading stops as soon as the needed fields are found.
 */
const HEAD_CHUNK_BYTES = 64 * 1024;
const HEAD_BUDGET_BYTES = 256 * 1024;
/**
 * A record the head budget cuts off is read to its end with inline media collapsed while it buffers, because the first
 * prompt often carries a pasted screenshot that alone outweighs the budget. Without media such a record stays small;
 * these caps only bound a pathological line.
 */
const STRADDLING_RECORD_MAX_BYTES = 64 * 1024 * 1024;
const STRADDLING_RECORD_MAX_CHARS = 256 * 1024;
/**
 * Claude Code appends `ai-title` / `custom-title` records after later turns, so the newest title lives at the end.
 */
const TAIL_BYTES = 64 * 1024;
const GROK_SUMMARY_MAX_BYTES = 64 * 1024;
const GROK_CWD_MARKER_MAX_BYTES = 16 * 1024;
const CODEX_ID_QUERY_CHUNK = 500;

/**
 * Caxri's own delegated-task prompt (see `preparePointer` in `../agent-delegation/launch.ts`). A conversation opened by
 * it is a Caxri delegation child, never a conversation the user started elsewhere.
 */
const DELEGATION_POINTER_PATTERN =
    /^Read the delegated task from "(?:[^"\\]|\\.)*" and carry it out\. Delegation ID: \S+\.$/u;

/**
 * Codex `session_meta.payload.source` values that are not interactive top-level threads. An object source is a spawned
 * subagent (`{ subagent: ... }`); `exec` is a scripted one-shot `codex exec` run.
 */
const CODEX_SKIPPED_SOURCES = new Set(['exec']);
/**
 * Grok `summary.json` `session_kind` values that are not interactive top-level conversations. An interactive
 * conversation records `null`.
 */
const GROK_SKIPPED_KINDS = new Set(['headless', 'subagent', 'subagent_resume']);
/**
 * Any unexpected filesystem or parse fault skips one candidate instead of failing the whole listing.
 */
export async function settled<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
        return await work();
    } catch {
        return undefined;
    }
}

export function parseConversationCandidate(
    candidate: ConversationCandidate,
    codexNames: ReadonlyMap<string, string>,
): Promise<ParsedConversation | undefined> {
    switch (candidate.provider) {
        case 'claude':
            return parseClaudeConversation(candidate);
        case 'codex':
            return parseCodexConversation(candidate, codexNames.get(candidate.providerSessionId));
        case 'grok':
            return parseGrokConversation(candidate);
    }
}

// Bounded content reads

/**
 * Yields complete lines from `[start, end)` of a regular file without following a final symlink. A range that starts
 * mid-file drops its leading partial line. A trailing partial line is read on toward `lineLimit` (EOF for a head read)
 * to its newline, collapsing inline media as it buffers, and is dropped when it ends past the straddling-record caps.
 *
 * @yields {Record<string, unknown>} Each line that parses as a JSON object.
 */
async function* readJsonRecords(
    handle: FileHandle,
    start: number,
    end: number,
    lineLimit = end,
): AsyncGenerator<Record<string, unknown>> {
    const buffer = Buffer.alloc(HEAD_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let position = start;
    let pending = '';
    let isFragmentPending = start > 0;
    const parse = (line: string) => {
        try {
            const value: unknown = JSON.parse(line);
            return value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : undefined;
        } catch {
            return;
        }
    };
    while (position < end) {
        // Each read continues where the previous one stopped, so the reads are inherently sequential.
        // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
        const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(HEAD_CHUNK_BYTES, end - position),
            position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (isFragmentPending && lines.length > 0) {
            lines.shift();
            isFragmentPending = false;
        }
        for (const line of lines) {
            const record = parse(line);
            if (record) yield record;
        }
    }
    if (isFragmentPending || !pending) return;
    const straddleLimit = Math.min(lineLimit, end + STRADDLING_RECORD_MAX_BYTES);
    pending = compactInlineMediaPayloads(pending);
    while (position < straddleLimit && pending.length <= STRADDLING_RECORD_MAX_CHARS) {
        // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
        const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(HEAD_CHUNK_BYTES, straddleLimit - position),
            position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        pending = compactInlineMediaPayloads(
            pending + decoder.write(buffer.subarray(0, bytesRead)),
        );
        const newline = pending.indexOf('\n');
        if (newline !== -1) {
            const record = parse(pending.slice(0, newline));
            if (record) yield record;
            return;
        }
    }
    // A final line without a newline is complete only at EOF.
    if (position < lineLimit || pending.length > STRADDLING_RECORD_MAX_CHARS) return;
    const record = parse(pending + decoder.end());
    if (record) yield record;
}

/**
 * The head of a transcript: its first `HEAD_BUDGET_BYTES`, plus the rest of the record that budget cuts off.
 */
function readHeadRecords(handle: FileHandle, size: number) {
    return readJsonRecords(handle, 0, Math.min(size, HEAD_BUDGET_BYTES), size);
}

async function openTranscript(path: string) {
    let handle: FileHandle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch {
        return;
    }
    const metadata = await settled(() => handle.stat());
    if (metadata?.isFile()) return { handle, size: metadata.size };
    await settled(() => handle.close());
    return;
}

/**
 * Accumulates the first visible user message. Grok writes one turn as a run of `user_message_chunk` records, which are
 * joined until another message breaks the run.
 */
class FirstPromptCollector {
    private text = '';
    private isClosed = false;
    private isChunkRun = false;

    accept(record: unknown): void {
        if (this.isClosed) return;
        const message = extractAgentTitleMessage(record);
        if (!message) return;
        if (message.role !== 'user') {
            if (this.text) this.isClosed = true;
            return;
        }
        if (!this.text) {
            this.text = message.text;
            this.isChunkRun = message.isChunk;
            this.isClosed = !message.isChunk;
        } else if (this.isChunkRun && message.isChunk) {
            this.text += message.text;
        } else {
            this.isClosed = true;
        }
    }

    get isComplete(): boolean {
        return this.isClosed;
    }

    get prompt(): string | undefined {
        return this.text.trim() || undefined;
    }
}

function displayTitle(text: string | undefined): string | undefined {
    const line = text?.replaceAll(/\s+/gu, ' ').trim();
    if (!line) return;
    const characters = [...line];
    return characters.length <= TITLE_MAX_CHARACTERS
        ? line
        : `${characters
              .slice(0, TITLE_MAX_CHARACTERS - 1)
              .join('')
              .trimEnd()}…`;
}

/**
 * Applies the rules shared by every provider: the delegated-task pointer marks a Caxri child, and a conversation with
 * neither a provider title nor a user prompt is empty.
 */
function finishConversation(
    cwd: string | undefined,
    providerTitle: string | undefined,
    prompt: string | undefined,
): ParsedConversation | undefined {
    if (!cwd || !isAbsolute(cwd)) return;
    if (prompt && DELEGATION_POINTER_PATTERN.test(prompt.trim())) return;
    const title = displayTitle(providerTitle) ?? displayTitle(prompt);
    if (!title && !prompt) return;
    return title ? { cwd, title } : { cwd };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = record?.[key];
    return typeof value === 'string' ? value : undefined;
}

function objectField(
    record: Record<string, unknown> | undefined,
    key: string,
): Record<string, unknown> | undefined {
    const value = record?.[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

// Claude Code

interface ClaudeTitles {
    aiTitle?: string;
    customTitle?: string;
    summary?: string;
}

/**
 * Mirrors the title records `providers/claude/index.ts` scans: `custom-title` (`/rename`) outranks the latest
 * `ai-title`. Older Claude Code versions instead wrote a leading `summary` record.
 */
function scanClaudeTitle(record: Record<string, unknown>, titles: ClaudeTitles): void {
    const type = record.type;
    const value =
        type === 'custom-title'
            ? stringField(record, 'customTitle')
            : type === 'ai-title'
              ? stringField(record, 'aiTitle')
              : type === 'summary'
                ? stringField(record, 'summary')
                : undefined;
    const title = value?.trim();
    if (!title) return;
    if (type === 'custom-title') titles.customTitle = title;
    else if (type === 'ai-title') titles.aiTitle = title;
    else titles.summary ??= title;
}

/**
 * `claude --resume` looks the transcript up under the project directory derived from the current cwd, so the recorded
 * cwd whose derivation matches the containing directory is preferred over a later one the session moved into.
 */
async function parseClaudeConversation(
    candidate: ConversationCandidate,
): Promise<ParsedConversation | undefined> {
    const opened = await openTranscript(candidate.path);
    if (!opened) return;
    const configDirectory = dirname(dirname(dirname(candidate.path)));
    const projectRoot = dirname(candidate.path);
    const titles: ClaudeTitles = {};
    const prompt = new FirstPromptCollector();
    let firstCwd: string | undefined;
    let resumableCwd: string | undefined;
    let firstEntrypoint: string | undefined;
    let hasStoppedEarly = false;
    try {
        const headEnd = Math.min(opened.size, HEAD_BUDGET_BYTES);
        for await (const record of readHeadRecords(opened.handle, opened.size)) {
            scanClaudeTitle(record, titles);
            /**
             * The first entry point names how the conversation started. A `--print` run (`sdk-cli`) is a scripted
             * one-shot. A later `sdk-cli` record does not reclassify a conversation: Caxri runs `/rename` through
             * `claude -p --resume`, which appends one to an Agent Chat transcript.
             */
            firstEntrypoint ??= stringField(record, 'entrypoint');
            if (firstEntrypoint === 'sdk-cli') return;
            if (record.type === 'user' && record.isSidechain === true && !prompt.prompt) return;
            const cwd = stringField(record, 'cwd');
            if (cwd && isAbsolute(cwd)) {
                firstCwd ??= cwd;
                if (!resumableCwd && claudeTranscriptRoot(configDirectory, cwd) === projectRoot)
                    resumableCwd = cwd;
            }
            prompt.accept(record);
            if (resumableCwd && firstEntrypoint !== undefined && prompt.isComplete) {
                hasStoppedEarly = true;
                break;
            }
        }
        /**
         * Title records follow the first turn, so whatever the head scan did not reach is covered by a bounded tail
         * read. Overlap with the head is harmless: a later title record overrides an earlier one.
         */
        if (hasStoppedEarly || opened.size > headEnd) {
            const tailStart = Math.max(hasStoppedEarly ? 0 : headEnd, opened.size - TAIL_BYTES);
            for await (const record of readJsonRecords(opened.handle, tailStart, opened.size))
                scanClaudeTitle(record, titles);
        }
    } finally {
        await opened.handle.close();
    }
    const conversation = finishConversation(
        resumableCwd ?? firstCwd,
        titles.customTitle ?? titles.aiTitle ?? titles.summary,
        prompt.prompt,
    );
    return conversation && firstEntrypoint?.startsWith('sdk')
        ? { ...conversation, isHosted: true }
        : conversation;
}

// Codex

async function parseCodexConversation(
    candidate: ConversationCandidate,
    threadName: string | undefined,
): Promise<ParsedConversation | undefined> {
    const opened = await openTranscript(candidate.path);
    if (!opened) return;
    const prompt = new FirstPromptCollector();
    let cwd: string | undefined;
    let hasMeta = false;
    try {
        for await (const record of readHeadRecords(opened.handle, opened.size)) {
            if (!hasMeta && record.type === 'session_meta') {
                hasMeta = true;
                const payload = objectField(record, 'payload');
                const id = stringField(payload, 'id');
                // The rollout name and its own metadata must agree on the thread being resumed.
                if (id?.toLowerCase() !== candidate.providerSessionId.toLowerCase()) return;
                const source = payload?.source;
                if (source !== undefined && typeof source !== 'string') return;
                if (source && CODEX_SKIPPED_SOURCES.has(source)) return;
                cwd = stringField(payload, 'cwd');
                continue;
            }
            prompt.accept(record);
            if (hasMeta && prompt.isComplete) break;
        }
    } finally {
        await opened.handle.close();
    }
    if (!hasMeta) return;
    return finishConversation(cwd, threadName, prompt.prompt);
}

export interface CodexThreadIndex {
    /**
     * Displayed thread names (`threads.name`), keyed by thread id.
     */
    names: Map<string, string>;
    /**
     * Thread ids whose `threads.source` marks a spawned subagent (a JSON object) or a `codex exec` run.
     */
    skipped: Set<string>;
}

interface CodexThreadRow {
    id: unknown;
    name: unknown;
    source: unknown;
}

/**
 * The first database that has a thread's row wins, matching `findCodexStateDatabases` priority order.
 */
function collectThreadRows(
    rows: readonly CodexThreadRow[],
    index: CodexThreadIndex,
    seen: Set<string>,
) {
    for (const row of rows) {
        if (typeof row.id !== 'string' || seen.has(row.id)) continue;
        seen.add(row.id);
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        if (name) index.names.set(row.id, name);
        const source = typeof row.source === 'string' ? row.source.trim() : '';
        if (source.startsWith('{') || CODEX_SKIPPED_SOURCES.has(source)) index.skipped.add(row.id);
    }
}

/**
 * Reads Codex's private state database (`threads`) for the displayed thread name and the thread source. The source lets
 * subagent and `exec` threads be dropped before any rollout is opened: they outnumber interactive threads on a busy
 * machine and would otherwise exhaust the content-read budget. Schema drift or an unreadable database degrades to the
 * rollout's own `session_meta` and first prompt.
 */
export async function readCodexThreadIndex(
    environment: AgentEnvironment,
    threadIds: readonly string[],
): Promise<CodexThreadIndex> {
    const index: CodexThreadIndex = { names: new Map(), skipped: new Set() };
    const seen = new Set<string>();
    let databasePaths: string[];
    try {
        databasePaths = await findCodexStateDatabases(resolveCodexStateDirectories(environment));
    } catch {
        return index;
    }
    for (const path of databasePaths) {
        let database: Database.Database | undefined;
        try {
            database = new Database(path, { fileMustExist: true, readonly: true });
            const columns = new Set(
                (database.prepare('PRAGMA table_info(threads)').all() as SqliteColumn[]).map(
                    (column) => column.name,
                ),
            );
            if (!columns.has('id')) continue;
            const name = columns.has('name') ? 'name' : 'NULL AS name';
            const source = columns.has('source') ? 'source' : 'NULL AS source';
            const pending = threadIds.filter((id) => !seen.has(id));
            for (let offset = 0; offset < pending.length; offset += CODEX_ID_QUERY_CHUNK) {
                const chunk = pending.slice(offset, offset + CODEX_ID_QUERY_CHUNK);
                const rows = database
                    .prepare(
                        `SELECT id, ${name}, ${source} FROM threads WHERE id IN (${chunk.map(() => '?').join(', ')})`,
                    )
                    .all(...chunk) as CodexThreadRow[];
                collectThreadRows(rows, index, seen);
            }
        } catch {
            // Codex owns this private schema; drift degrades to the rollout's own metadata.
        } finally {
            database?.close();
        }
    }
    return index;
}

// Grok Build

async function readJsonObject(path: string, maxBytes: number) {
    try {
        const value: unknown = JSON.parse(
            await readBoundedRegularFileText(path, maxBytes, { symlinks: 'nofollow' }),
        );
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return;
    }
}

/**
 * `summary.json` records `info.{id,cwd}`, `session_kind` (`null` for an interactive conversation), and Grok's own
 * `generated_title`. A conversation without a readable summary has not been flushed and is skipped.
 */
async function parseGrokConversation(
    candidate: ConversationCandidate,
): Promise<ParsedConversation | undefined> {
    const sessionRoot = dirname(candidate.path);
    const summary = await readJsonObject(join(sessionRoot, 'summary.json'), GROK_SUMMARY_MAX_BYTES);
    if (!summary) return;
    const kind = summary.session_kind;
    if (typeof kind === 'string' && GROK_SKIPPED_KINDS.has(kind)) return;
    const info = objectField(summary, 'info');
    const id = stringField(info, 'id');
    if (id !== undefined && id !== candidate.providerSessionId) return;
    let cwd = stringField(info, 'cwd');
    if (!cwd) {
        // Long cwd names are hashed into the directory name; Grok then records the cwd in a `.cwd` marker.
        try {
            cwd = (
                await readBoundedRegularFileText(
                    join(dirname(sessionRoot), '.cwd'),
                    GROK_CWD_MARKER_MAX_BYTES,
                    { symlinks: 'nofollow' },
                )
            ).trim();
        } catch {
            return;
        }
    }
    const opened = await openTranscript(candidate.path);
    if (!opened) return;
    const prompt = new FirstPromptCollector();
    try {
        const records = readHeadRecords(opened.handle, opened.size);
        for await (const record of records) {
            prompt.accept(record);
            if (prompt.isComplete) break;
        }
    } finally {
        await opened.handle.close();
    }
    return finishConversation(cwd, stringField(summary, 'generated_title'), prompt.prompt);
}
