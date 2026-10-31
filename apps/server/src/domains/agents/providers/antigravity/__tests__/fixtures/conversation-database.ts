import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { antigravityConversationPath, antigravityStateDirectory } from '../../paths';

/**
 * Writes synthetic Antigravity state with the schema and protobuf field numbers `agy` 1.4.11 uses (see
 * `conversation-database.ts`), so tests never read a real conversation.
 */

type Field = readonly [number, number | string | Uint8Array | readonly Field[]];

function varint(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
        bytes.push((rest % 0x80) | 0x80);
        rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
    return bytes;
}

export function encodeMessage(fields: readonly Field[]): Uint8Array {
    const bytes: number[] = [];
    for (const [number, value] of fields) {
        if (typeof value === 'number') {
            bytes.push(...varint(number * 8), ...varint(value));
            continue;
        }
        const payload =
            typeof value === 'string'
                ? new TextEncoder().encode(value)
                : value instanceof Uint8Array
                  ? value
                  : encodeMessage(value);
        bytes.push(...varint(number * 8 + 2), ...varint(payload.length), ...payload);
    }
    return Uint8Array.from(bytes);
}

interface SyntheticTurn {
    prompt: string;
    reply?: string;
    /**
     * Seconds since the epoch the user's step was created; the reply follows a second later.
     */
    at: number;
    model?: string;
    usage?: { input: number; output: number; cacheRead?: number; reasoning?: number };
}

export interface SyntheticConversation {
    id: string;
    cwd?: string;
    title?: string;
    /**
     * `CortexTrajectorySource`; 17 is the CLI, 16 a subagent.
     */
    source?: number;
    turns: SyntheticTurn[];
}

const timestamp = (seconds: number): Field[] => [[1, seconds]];

export async function writeAntigravityConversation(
    home: string,
    conversation: SyntheticConversation,
): Promise<string> {
    const environment = { homeDirectory: home, variables: {} };
    const path = antigravityConversationPath(environment, conversation.id);
    await mkdir(join(antigravityStateDirectory(environment), 'conversations'), { recursive: true });
    const database = new Database(path);
    try {
        database.pragma('journal_mode = WAL');
        database.exec(`
            CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer,
                source integer, PRIMARY KEY (trajectory_id));
            CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0,
                has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob,
                permissions blob, task_details blob, render_info blob, step_payload blob,
                step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
            CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
        `);
        database
            .prepare('INSERT INTO trajectory_meta VALUES (?, ?, 4, ?)')
            .run(conversation.id, conversation.id, conversation.source ?? 17);
        const step = database.prepare(
            'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)',
        );
        const generation = database.prepare(
            'INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)',
        );
        let index = 0;
        let generationIndex = 0;
        for (const turn of conversation.turns) {
            const userMetadata: Field[] = [[1, timestamp(turn.at)]];
            step.run(
                index,
                14,
                encodeMessage(userMetadata),
                encodeMessage([
                    [1, 14],
                    [5, userMetadata],
                    [19, [[1, turn.prompt]]],
                ]),
            );
            index++;
            if (turn.reply === undefined) continue;
            const replyMetadata: Field[] = [[1, timestamp(turn.at + 1)]];
            step.run(
                index,
                15,
                encodeMessage(replyMetadata),
                encodeMessage([
                    [1, 15],
                    [5, replyMetadata],
                    [
                        20,
                        [
                            [1, turn.reply],
                            [3, 'synthetic thinking that is never indexed'],
                        ],
                    ],
                ]),
            );
            if (turn.usage) {
                const data = encodeMessage([
                    [
                        1,
                        [
                            [
                                4,
                                [
                                    [1, 1318],
                                    [2, turn.usage.input],
                                    [3, turn.usage.output],
                                    [5, turn.usage.cacheRead ?? 0],
                                    [9, turn.usage.reasoning ?? 0],
                                ],
                            ],
                            [19, turn.model ?? 'gemini-3-flash'],
                        ],
                    ],
                    [2, Uint8Array.from(varint(index))],
                ]);
                generation.run(generationIndex++, data, data.length);
            }
            index++;
        }
    } finally {
        database.close();
    }
    await writeAntigravitySummary(home, conversation);
    return path;
}

async function writeAntigravitySummary(home: string, conversation: SyntheticConversation) {
    const environment = { homeDirectory: home, variables: {} };
    const directory = antigravityStateDirectory(environment);
    await mkdir(directory, { recursive: true });
    const database = new Database(join(directory, 'conversation_summaries.db'));
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text,
            title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
            workspace_uris text NOT NULL, PRIMARY KEY (conversation_id))`);
        database
            .prepare(
                'INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, preview, workspace_uris) VALUES (?, ?, ?, ?)',
            )
            .run(
                conversation.id,
                conversation.title ?? '',
                conversation.turns[0]?.prompt ?? '',
                JSON.stringify(conversation.cwd ? [pathToFileURL(conversation.cwd).href] : []),
            );
    } finally {
        database.close();
    }
}
