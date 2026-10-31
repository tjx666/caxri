import { dirname, isAbsolute, join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';
import Database from 'better-sqlite3';

import type { AgentEnvironment } from './contract';
import {
    ANTIGRAVITY_SUBAGENT_SOURCE,
    readAntigravityConversation,
    readAntigravityConversationSummary,
} from './providers/antigravity/conversation-database';
import { isHostedClaudeEntrypoint } from './providers/claude/entrypoint';
import { claudeTranscriptRoot } from './providers/claude/paths';
import { resolveCodexStateDirectories } from './providers/codex/paths';
import type { SqliteColumn } from './providers/codex/state-databases';
import { findCodexStateDatabases } from './providers/codex/state-databases';
import { extractAgentTitleMessage } from './title-generation';
import type { HeadReadOutcome } from './transcript-head-reader';
import {
    HEAD_BUDGET_BYTES,
    openTranscript,
    readHeadRecords,
    readJsonRecords,
} from './transcript-head-reader';

/**
 * Per-provider transcript parsing for `external-conversations.ts` and the Session search index. Every parser sees only
 * a bounded head (and for Claude a bounded tail) of one transcript, and nothing here logs content, titles, or paths.
 */

export type ExternalConversationProvider = 'claude' | 'codex' | 'grok';

/**
 * Providers whose conversations the parsers classify. Antigravity is parsed for Session search only: the
 * outside-conversation list feeds Caxri Bot hand-over, which needs visible delegation that Antigravity lacks.
 */
type ConversationParserProvider = ExternalConversationProvider | 'antigravity';

export interface ConversationCandidate {
    provider: ConversationParserProvider;
    providerSessionId: string;
    /**
     * The transcript whose mtime is `updatedAt`: Claude `<id>.jsonl`, Codex rollout, Grok `updates.jsonl`, Antigravity
     * `conversations/<id>.db`.
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
    /**
     * The provider conversation ID this one was forked from (Claude `--fork-session`, Codex fork, Grok session fork).
     * Absent for a conversation that is not a fork, and for a fork whose transcript does not name its source.
     */
    forkedFromId?: string;
}

/**
 * Why a transcript is not a conversation the user had, or could not be read as one. Closed, so the index pass can count
 * each cause; `oversizedRecord` is a record past the head read's caps, the one cause that hides a real conversation.
 */
export const conversationExclusionReasons = [
    'unreadable',
    'scripted',
    'sidechain',
    'delegation',
    'mismatchedId',
    'missingMetadata',
    'missingFolder',
    'missingPrompt',
    'oversizedRecord',
] as const;
export type ConversationExclusionReason = (typeof conversationExclusionReasons)[number];

type ConversationParse = ParsedConversation | ConversationExclusionReason;
const TITLE_MAX_CHARACTERS = 120;
/**
 * Claude Code appends `ai-title` / `custom-title` records after later turns, so the newest title lives at the end.
 */
const TAIL_BYTES = 64 * 1024;
/**
 * How far past the head read a Claude transcript is scanned for its first visible user message when the head held none.
 * Attachments, injected context, and tool results recorded before that message have pushed it to about 4 MiB in real
 * transcripts; only a transcript still missing its prompt after the head pays for this read.
 */
const CLAUDE_PROMPT_SCAN_BYTES = 16 * 1024 * 1024;
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

export async function parseConversationCandidate(
    candidate: ConversationCandidate,
    codexNames: ReadonlyMap<string, string>,
): Promise<ParsedConversation | undefined> {
    const parsed = await classifyConversationCandidate(candidate, codexNames);
    return typeof parsed === 'string' ? undefined : parsed;
}

/**
 * Parses a candidate, or names why it is not a conversation. An unexpected fault reads as `unreadable`.
 */
export async function classifyConversationCandidate(
    candidate: ConversationCandidate,
    codexNames: ReadonlyMap<string, string>,
    environment?: AgentEnvironment,
): Promise<ConversationParse> {
    return (
        (await settled(() => parseCandidate(candidate, codexNames, environment))) ?? 'unreadable'
    );
}

function parseCandidate(
    candidate: ConversationCandidate,
    codexNames: ReadonlyMap<string, string>,
    environment: AgentEnvironment | undefined,
): Promise<ConversationParse> {
    switch (candidate.provider) {
        case 'claude':
            return parseClaudeConversation(candidate);
        case 'codex':
            return parseCodexConversation(candidate, codexNames.get(candidate.providerSessionId));
        case 'grok':
            return parseGrokConversation(candidate);
        case 'antigravity':
            return Promise.resolve(
                environment ? parseAntigravityConversation(candidate, environment) : 'unreadable',
            );
    }
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
 * neither a provider title nor a user prompt is empty. A missing field the head read may have skipped is blamed on it.
 */
function finishConversation(
    cwd: string | undefined,
    providerTitle: string | undefined,
    prompt: string | undefined,
    head?: HeadReadOutcome,
): ConversationParse {
    const missing = head?.hasDroppedRecord ? 'oversizedRecord' : undefined;
    if (!cwd || !isAbsolute(cwd)) return missing ?? 'missingFolder';
    if (prompt && DELEGATION_POINTER_PATTERN.test(prompt.trim())) return 'delegation';
    const title = displayTitle(providerTitle) ?? displayTitle(prompt);
    if (!title && !prompt) return missing ?? 'missingPrompt';
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
): Promise<ConversationParse> {
    const opened = await openTranscript(candidate.path);
    if (!opened) return 'unreadable';
    const head: HeadReadOutcome = { hasDroppedRecord: false };
    const configDirectory = dirname(dirname(dirname(candidate.path)));
    const projectRoot = dirname(candidate.path);
    const titles: ClaudeTitles = {};
    const prompt = new FirstPromptCollector();
    let firstCwd: string | undefined;
    let resumableCwd: string | undefined;
    let firstEntrypoint: string | undefined;
    let forkedFromId: string | undefined;
    let hasStoppedEarly = false;
    /**
     * Folds one record into the scan, returning an exclusion reason, `true` once every needed field is found, or
     * `false` to keep reading.
     */
    const accept = (record: Record<string, unknown>): ConversationExclusionReason | boolean => {
        scanClaudeTitle(record, titles);
        /**
         * The first entry point names how the conversation started. A `--print` run (`sdk-cli`) is a scripted one-shot.
         * A later record does not reclassify a conversation: Caxri runs `/rename` through `claude -p --resume`, which
         * appends one to an Agent Chat transcript (`caxri` now, `sdk-cli` in transcripts older builds wrote).
         */
        firstEntrypoint ??= stringField(record, 'entrypoint');
        // A fork copies its parent's records into the new file, each stamped with the conversation it came from.
        forkedFromId ??= claudeForkSource(record, candidate.providerSessionId);
        if (firstEntrypoint === 'sdk-cli') return 'scripted';
        if (record.type === 'user' && record.isSidechain === true && !prompt.prompt)
            return 'sidechain';
        const cwd = stringField(record, 'cwd');
        if (cwd && isAbsolute(cwd)) {
            firstCwd ??= cwd;
            if (!resumableCwd && claudeTranscriptRoot(configDirectory, cwd) === projectRoot)
                resumableCwd = cwd;
        }
        prompt.accept(record);
        return Boolean(resumableCwd && firstEntrypoint !== undefined && prompt.isComplete);
    };
    try {
        const headEnd = Math.min(opened.size, HEAD_BUDGET_BYTES);
        for await (const record of readHeadRecords(opened.handle, opened.size, head)) {
            const verdict = accept(record);
            if (typeof verdict === 'string') return verdict;
            if (verdict) {
                hasStoppedEarly = true;
                break;
            }
        }
        /**
         * A head with no visible user message keeps reading, within a bound, until one appears, so a conversation
         * opened by long attachments or injected context is still indexed under its prompt. Starting one byte early
         * makes the range's dropped leading fragment exactly the record the head read already finished (or the newline
         * ending the head), so no record is skipped or scanned twice.
         */
        let scannedEnd = headEnd;
        if (!hasStoppedEarly && !prompt.prompt && opened.size > headEnd) {
            scannedEnd = Math.min(opened.size, headEnd + CLAUDE_PROMPT_SCAN_BYTES);
            const records = readJsonRecords(opened.handle, headEnd - 1, scannedEnd);
            for await (const record of records) {
                const verdict = accept(record);
                if (typeof verdict === 'string') return verdict;
                if (prompt.isComplete) {
                    hasStoppedEarly = true;
                    break;
                }
            }
        }
        /**
         * Title records follow the first turn, so whatever the head scan did not reach is covered by a bounded tail
         * read. Overlap with the head is harmless: a later title record overrides an earlier one.
         */
        if (hasStoppedEarly || opened.size > scannedEnd) {
            const tailStart = Math.max(hasStoppedEarly ? 0 : scannedEnd, opened.size - TAIL_BYTES);
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
        head,
    );
    if (typeof conversation === 'string') return conversation;
    return {
        ...conversation,
        ...(isHostedClaudeEntrypoint(firstEntrypoint) && { isHosted: true }),
        ...(forkedFromId !== undefined && { forkedFromId }),
    };
}

/**
 * The conversation a Claude record was copied from: `forkedFrom.sessionId` on a record of a `--fork-session` file. A
 * record naming its own conversation is not a fork.
 */
function claudeForkSource(record: Record<string, unknown>, ownId: string): string | undefined {
    const source = stringField(objectField(record, 'forkedFrom'), 'sessionId');
    return source && source !== ownId ? source : undefined;
}

// Codex

async function parseCodexConversation(
    candidate: ConversationCandidate,
    threadName: string | undefined,
): Promise<ConversationParse> {
    const opened = await openTranscript(candidate.path);
    if (!opened) return 'unreadable';
    const head: HeadReadOutcome = { hasDroppedRecord: false };
    const prompt = new FirstPromptCollector();
    let cwd: string | undefined;
    let forkedFromId: string | undefined;
    let hasMeta = false;
    try {
        for await (const record of readHeadRecords(opened.handle, opened.size, head)) {
            if (!hasMeta && record.type === 'session_meta') {
                hasMeta = true;
                const payload = objectField(record, 'payload');
                const id = stringField(payload, 'id');
                // The rollout name and its own metadata must agree on the thread being resumed.
                if (id?.toLowerCase() !== candidate.providerSessionId.toLowerCase())
                    return 'mismatchedId';
                const source = payload?.source;
                if (source !== undefined && typeof source !== 'string') return 'scripted';
                if (source && CODEX_SKIPPED_SOURCES.has(source)) return 'scripted';
                cwd = stringField(payload, 'cwd');
                forkedFromId = stringField(payload, 'forked_from_id');
                continue;
            }
            prompt.accept(record);
            if (hasMeta && prompt.isComplete) break;
        }
    } finally {
        await opened.handle.close();
    }
    if (!hasMeta) return head.hasDroppedRecord ? 'oversizedRecord' : 'missingMetadata';
    return withForkSource(finishConversation(cwd, threadName, prompt.prompt, head), forkedFromId);
}

function withForkSource(conversation: ConversationParse, forkedFromId: string | undefined) {
    return typeof conversation === 'string' || forkedFromId === undefined
        ? conversation
        : { ...conversation, forkedFromId };
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
async function parseGrokConversation(candidate: ConversationCandidate): Promise<ConversationParse> {
    const sessionRoot = dirname(candidate.path);
    const summary = await readJsonObject(join(sessionRoot, 'summary.json'), GROK_SUMMARY_MAX_BYTES);
    if (!summary) return 'missingMetadata';
    const kind = summary.session_kind;
    if (typeof kind === 'string' && GROK_SKIPPED_KINDS.has(kind)) return 'scripted';
    const info = objectField(summary, 'info');
    const id = stringField(info, 'id');
    if (id !== undefined && id !== candidate.providerSessionId) return 'mismatchedId';
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
            return 'missingFolder';
        }
    }
    const opened = await openTranscript(candidate.path);
    if (!opened) return 'unreadable';
    const head: HeadReadOutcome = { hasDroppedRecord: false };
    const prompt = new FirstPromptCollector();
    try {
        const records = readHeadRecords(opened.handle, opened.size, head);
        for await (const record of records) {
            prompt.accept(record);
            if (prompt.isComplete) break;
        }
    } finally {
        await opened.handle.close();
    }
    return withForkSource(
        finishConversation(cwd, stringField(summary, 'generated_title'), prompt.prompt, head),
        stringField(summary, 'parent_session_id'),
    );
}

// Antigravity

/**
 * Antigravity keeps the folder and its generated title in `conversation_summaries.db` and the conversation itself in
 * `conversations/<id>.db`; see `providers/antigravity/conversation-database.ts`. A conversation a parent spawned as a
 * subagent is not one the user had.
 */
function parseAntigravityConversation(
    candidate: ConversationCandidate,
    environment: AgentEnvironment,
): ConversationParse {
    const conversation = readAntigravityConversation(candidate.path);
    if (!conversation) return 'unreadable';
    if (conversation.source === ANTIGRAVITY_SUBAGENT_SOURCE) return 'sidechain';
    const summary = readAntigravityConversationSummary(environment, candidate.providerSessionId);
    if (!summary) return 'missingMetadata';
    const prompt = conversation.messages.find((message) => message.role === 'user')?.text;
    return finishConversation(summary.cwd, summary.title, prompt);
}
