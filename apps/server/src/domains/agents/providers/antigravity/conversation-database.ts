import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import type { AgentEnvironment } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';
import { antigravityStateDirectory } from './paths';
import type { WireField } from './protobuf-wire';
import {
    decodeWireFields,
    wireMessage,
    wireRepeatedVarint,
    wireString,
    wireTimestampMs,
    wireVarint,
} from './protobuf-wire';

/**
 * Antigravity stores each conversation as `conversations/<id>.db`, a SQLite database in WAL mode whose `steps` and
 * `gen_metadata` rows hold protobuf blobs. The field numbers below come from the `gemini_coder.Step`,
 * `exa.cortex_pb.CortexStepMetadata`, `CortexStepGeneratorMetadata`, and `exa.codeium_common_pb.ModelUsageStats`
 * descriptors embedded in `agy` 1.4.11, checked against real databases with a content-free structural probe (field
 * numbers and counters only). A layout change degrades to missing values, never a throw.
 */
const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;
/**
 * `CortexTrajectorySource.CORTEX_TRAJECTORY_SOURCE_SUBAGENT`: a conversation a parent conversation spawned.
 */
export const ANTIGRAVITY_SUBAGENT_SOURCE = 16;
/**
 * Bounds one read: a conversation past this many steps keeps its first ones. Far above a real conversation.
 */
const MAX_STEPS = 50_000;
const MAX_GENERATIONS = 50_000;
const MAX_MODEL_NAME_CHARS = 200;
/**
 * `agy` names every conversation with a UUID; the same directory holds no other databases today, but a name that is not
 * one is never read as a conversation.
 */
const CONVERSATION_FILE_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.db$/iu;

const Step = { metadata: 5, userInput: 19, plannerResponse: 20 } as const;
const StepMetadata = { createdAt: 1 } as const;
const UserInput = { query: 1, items: 3 } as const;
const TextOrScopeItem = { text: 1 } as const;
const PlannerResponse = { response: 1, modifiedResponse: 8 } as const;
const GeneratorMetadata = { chatModel: 1, stepIndices: 2 } as const;
const ChatModel = { usage: 4, responseModel: 19 } as const;
const ModelUsage = {
    input: 2,
    output: 3,
    cacheWrite: 4,
    cacheRead: 5,
    thinkingOutput: 9,
} as const;

interface AntigravityMessage {
    role: 'user' | 'assistant';
    text: string;
}

/**
 * One model call's billed tokens. `input` excludes cache reads, which Antigravity reports separately; `output` already
 * includes `reasoning` (`thinking_output_tokens`).
 */
interface AntigravityGeneration {
    index: number;
    at?: number;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
}

export interface AntigravityConversation {
    /**
     * `trajectory_meta.source`, a `CortexTrajectorySource` value.
     */
    source?: number;
    /**
     * Visible user prompts and Agent replies in order. Thinking, tool calls, tool output, and system steps are left
     * out.
     */
    messages: AntigravityMessage[];
    generations: AntigravityGeneration[];
    /**
     * Every step's creation time in step order, epoch milliseconds.
     */
    activity: number[];
}

export interface AntigravityConversationStamp {
    inode: number;
    /**
     * The database and its write-ahead log together: a running `agy` appends to the log, leaving the main file alone
     * until a checkpoint.
     */
    size: number;
    mtimeMs: number;
    bornAt: number;
}

export function antigravityConversationsDirectory(environment: AgentEnvironment): string {
    return join(antigravityStateDirectory(environment), 'conversations');
}

/**
 * The conversation id a database file name carries, or `undefined` for anything else in the directory.
 */
export function antigravityConversationId(fileName: string): string | undefined {
    return CONVERSATION_FILE_PATTERN.test(fileName) ? fileName.slice(0, -'.db'.length) : undefined;
}

/**
 * Identity of one conversation database, `undefined` when it is missing or not a regular file (a symlink is refused, as
 * the transcript reader refuses one).
 */
export async function antigravityConversationStamp(
    path: string,
): Promise<AntigravityConversationStamp | undefined> {
    try {
        const stats = await lstat(path);
        if (!stats.isFile()) return;
        const wal = await walStats(path);
        const walFile = wal?.isFile() ? wal : undefined;
        return {
            inode: stats.ino,
            size: stats.size + (walFile?.size ?? 0),
            mtimeMs: Math.trunc(Math.max(stats.mtimeMs, walFile?.mtimeMs ?? 0)),
            bornAt: Math.trunc(stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs),
        };
    } catch {
        return undefined;
    }
}

async function walStats(path: string): Promise<Stats | undefined> {
    try {
        return await lstat(`${path}-wal`);
    } catch {
        // No write-ahead log until `agy` writes after a checkpoint.
        return;
    }
}

function withDatabase<T>(path: string, read: (database: Database.Database) => T): T | undefined {
    let database: Database.Database | undefined;
    try {
        database = new Database(path, { fileMustExist: true, readonly: true });
        return read(database);
    } catch {
        // A schema Antigravity changed, a lock, or a corrupt file all read as no conversation.
        return undefined;
    } finally {
        database?.close();
    }
}

function blob(value: unknown): Uint8Array | undefined {
    return value instanceof Uint8Array ? value : undefined;
}

function userText(input: readonly WireField[]): string {
    const query = wireString(input, UserInput.query);
    if (query.trim()) return query;
    return input
        .filter((field) => field.number === UserInput.items && field.bytes)
        .map((field) => wireString(decodeWireFields(field.bytes), TextOrScopeItem.text))
        .filter(Boolean)
        .join('\n');
}

function plannerText(response: readonly WireField[]): string {
    const modified = wireString(response, PlannerResponse.modifiedResponse);
    return modified.trim() ? modified : wireString(response, PlannerResponse.response);
}

function count(usage: readonly WireField[], number: number): number {
    return wireVarint(usage, number);
}

interface StepTimes {
    activity: number[];
    byIndex: Map<number, number>;
}

function readStepTime(times: StepTimes, index: number, metadataBlob: unknown): void {
    const metadata = decodeWireFields(blob(metadataBlob));
    const at = wireTimestampMs(wireMessage(metadata, StepMetadata.createdAt));
    if (at === undefined) return;
    times.activity.push(at);
    times.byIndex.set(index, at);
}

function readSource(database: Database.Database): number | undefined {
    const meta = database.prepare('SELECT source FROM trajectory_meta LIMIT 1').get() as
        { source?: unknown } | undefined;
    return typeof meta?.source === 'number' ? meta.source : undefined;
}

function readGenerations(database: Database.Database, times: StepTimes): AntigravityGeneration[] {
    const rows = database
        .prepare(`SELECT idx, data FROM gen_metadata ORDER BY idx LIMIT ${MAX_GENERATIONS}`)
        .all() as Array<{ idx: number; data: unknown }>;
    const generations: AntigravityGeneration[] = [];
    for (const row of rows) {
        const fields = decodeWireFields(blob(row.data));
        const chatModel = wireMessage(fields, GeneratorMetadata.chatModel);
        const usage = chatModel && wireMessage(chatModel, ChatModel.usage);
        if (!usage) continue;
        const stepIndex = wireRepeatedVarint(fields, GeneratorMetadata.stepIndices).at(0);
        const at = stepIndex === undefined ? undefined : times.byIndex.get(stepIndex);
        generations.push({
            index: row.idx,
            ...(at !== undefined && { at }),
            model:
                wireString(chatModel, ChatModel.responseModel).slice(0, MAX_MODEL_NAME_CHARS) ||
                'unknown',
            input: count(usage, ModelUsage.input),
            output: count(usage, ModelUsage.output),
            cacheRead: count(usage, ModelUsage.cacheRead),
            cacheWrite: count(usage, ModelUsage.cacheWrite),
            reasoning: count(usage, ModelUsage.thinkingOutput),
        });
    }
    return generations;
}

function userStepText(payload: Uint8Array): string {
    const input = wireMessage(decodeWireFields(payload), Step.userInput);
    return input ? userText(input) : '';
}

/**
 * Reads one conversation database opened read-only. Returns `undefined` when it cannot be opened or holds no `steps`
 * table. Nothing here logs; callers keep the text out of diagnostics. Callers that need less than the visible messages
 * use `readAntigravityConversationUsage` or `readAntigravityConversationHead`, which skip the message payloads.
 */
export function readAntigravityConversation(path: string): AntigravityConversation | undefined {
    return withDatabase(path, (database) => {
        const source = readSource(database);
        const steps = database
            .prepare(
                `SELECT idx, step_type, metadata,
                    CASE WHEN step_type IN (${STEP_TYPE_USER_INPUT}, ${STEP_TYPE_PLANNER_RESPONSE})
                        THEN step_payload END AS payload
                FROM steps ORDER BY idx LIMIT ${MAX_STEPS}`,
            )
            .all() as Array<{
            idx: number;
            step_type: number;
            metadata: unknown;
            payload: unknown;
        }>;
        const messages: AntigravityMessage[] = [];
        const times: StepTimes = { activity: [], byIndex: new Map() };
        for (const step of steps) {
            readStepTime(times, step.idx, step.metadata);
            const payload = blob(step.payload);
            if (!payload) continue;
            if (step.step_type === STEP_TYPE_USER_INPUT) {
                const text = userStepText(payload);
                if (text.trim()) messages.push({ role: 'user', text });
            } else {
                const response = wireMessage(decodeWireFields(payload), Step.plannerResponse);
                const text = response ? plannerText(response) : '';
                if (text.trim()) messages.push({ role: 'assistant', text });
            }
        }
        return {
            ...(source !== undefined && { source }),
            messages,
            generations: readGenerations(database, times),
            activity: times.activity,
        };
    });
}

/**
 * The step times and per-call usage the Usage scanner bills, without selecting any `step_payload`: on a long
 * conversation the payloads are most of the bytes, and none of them carry usage.
 */
export function readAntigravityConversationUsage(
    path: string,
): Pick<AntigravityConversation, 'activity' | 'generations'> | undefined {
    return withDatabase(path, (database) => {
        const steps = database
            .prepare(`SELECT idx, metadata FROM steps ORDER BY idx LIMIT ${MAX_STEPS}`)
            .all() as Array<{ idx: number; metadata: unknown }>;
        const times: StepTimes = { activity: [], byIndex: new Map() };
        for (const step of steps) readStepTime(times, step.idx, step.metadata);
        return { activity: times.activity, generations: readGenerations(database, times) };
    });
}

export interface AntigravityConversationHead {
    source?: number;
    /**
     * The first non-empty user prompt, which names an external conversation that has no generated title.
     */
    firstPrompt?: string;
}

/**
 * What external-conversation discovery needs: the source and the first prompt. Stops at the first prompt with text
 * instead of decoding every step.
 */
export function readAntigravityConversationHead(
    path: string,
): AntigravityConversationHead | undefined {
    return withDatabase(path, (database) => {
        const source = readSource(database);
        const prompts = database
            .prepare(
                `SELECT step_payload FROM steps WHERE step_type = ${STEP_TYPE_USER_INPUT}
                ORDER BY idx LIMIT ${MAX_STEPS}`,
            )
            .iterate() as IterableIterator<{ step_payload: unknown }>;
        let firstPrompt: string | undefined;
        for (const row of prompts) {
            const payload = blob(row.step_payload);
            const text = payload ? userStepText(payload) : '';
            if (!text.trim()) continue;
            firstPrompt = text;
            break;
        }
        return {
            ...(source !== undefined && { source }),
            ...(firstPrompt !== undefined && { firstPrompt }),
        };
    });
}

export interface AntigravityConversationSummary {
    /**
     * The conversation's first workspace folder, absolute.
     */
    cwd?: string;
    /**
     * The title Antigravity generated; empty until it generates one.
     */
    title?: string;
}

function firstWorkspaceFolder(source: unknown): string | undefined {
    if (typeof source !== 'string') return;
    let uris: unknown;
    try {
        uris = JSON.parse(source);
    } catch {
        return;
    }
    if (!Array.isArray(uris)) return;
    for (const uri of uris) {
        if (typeof uri !== 'string' || !uri.startsWith('file://')) continue;
        try {
            return fileURLToPath(uri);
        } catch {
            // A malformed URI names no folder.
        }
    }
    return undefined;
}

/**
 * Reads a conversation's folder and generated title from `conversation_summaries.db`. Like the metadata probe in
 * `state.ts`, it never selects `preview`, the raw first prompt.
 */
export function readAntigravityConversationSummary(
    environment: AgentEnvironment,
    conversationId: string,
): AntigravityConversationSummary | undefined {
    if (!isOpaqueAgentSessionId(conversationId)) return;
    const row = withDatabase(
        join(antigravityStateDirectory(environment), 'conversation_summaries.db'),
        (database) =>
            database
                .prepare(
                    'SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?',
                )
                .get(conversationId) as { title?: unknown; workspace_uris?: unknown } | undefined,
    );
    if (!row) return;
    const cwd = firstWorkspaceFolder(row.workspace_uris);
    return {
        ...(cwd && { cwd }),
        ...(typeof row.title === 'string' && row.title.trim() && { title: row.title }),
    };
}
