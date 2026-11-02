import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    readAntigravityConversation,
    readAntigravityConversationHead,
    readAntigravityConversationUsage,
} from '../conversation-database';
import { encodeMessage } from './fixtures/conversation-database';

/**
 * Times every Antigravity reader on a synthetic conversation at the 50,000-step read cap (#3408). Opt-in through `bun
 * run benchmark:antigravity-read`, since building the database alone takes seconds.
 */
const STEPS = 50_000;
const TOOL_PAYLOAD_BYTES = 4096;
const MESSAGE_CHARS = 2000;
const RUNS = 11;

function writeLargeConversation(path: string): void {
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
        database.prepare("INSERT INTO trajectory_meta VALUES ('t', 't', 4, 17)").run();
        const step = database.prepare(
            'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)',
        );
        const generation = database.prepare(
            'INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)',
        );
        const text = 'x'.repeat(MESSAGE_CHARS);
        const toolPayload = new Uint8Array(TOOL_PAYLOAD_BYTES).fill(7);
        database.transaction(() => {
            let generationIndex = 0;
            for (let index = 0; index < STEPS; index++) {
                const metadata: Parameters<typeof encodeMessage>[0] = [
                    [1, [[1, 1_800_000_000 + index]]],
                ];
                // A turn every 20 steps: a prompt, a reply, and 18 tool steps between them.
                const slot = index % 20;
                const type = slot === 0 ? 14 : slot === 19 ? 15 : 21;
                const payload =
                    type === 14
                        ? encodeMessage([[19, [[1, text]]]])
                        : type === 15
                          ? encodeMessage([[20, [[1, text]]]])
                          : toolPayload;
                step.run(index, type, encodeMessage(metadata), payload);
                if (slot % 2 === 1) {
                    const data = encodeMessage([
                        [
                            1,
                            [
                                [
                                    4,
                                    [
                                        [2, 1000],
                                        [3, 200],
                                    ],
                                ],
                                [19, 'gemini-3-flash'],
                            ],
                        ],
                        [2, Uint8Array.from([index % 128])],
                    ]);
                    generation.run(generationIndex++, data, data.length);
                }
            }
        })();
    } finally {
        database.close();
    }
}

function median(run: () => unknown): number {
    const times: number[] = [];
    for (let attempt = 0; attempt < RUNS; attempt++) {
        const start = performance.now();
        run();
        times.push(performance.now() - start);
    }
    return times.toSorted((a, b) => a - b)[Math.floor(RUNS / 2)] ?? 0;
}

describe.runIf(env.CAXRI_ANTIGRAVITY_READ_BENCHMARK === '1')('Antigravity read benchmark', () => {
    let directory = '';
    let path = '';
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-antigravity-benchmark-'));
        path = join(directory, '00000000-0000-4000-8000-000000000000.db');
        writeLargeConversation(path);
    }, 120_000);
    afterAll(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it(`reads a ${STEPS}-step conversation`, () => {
        const full = median(() => readAntigravityConversation(path));
        const usage = median(() => readAntigravityConversationUsage(path));
        const head = median(() => readAntigravityConversationHead(path));
        console.log(
            JSON.stringify(
                {
                    steps: STEPS,
                    runs: RUNS,
                    medianMs: {
                        full: Math.round(full),
                        usage: Math.round(usage),
                        head: Math.round(head),
                    },
                },
                null,
                2,
            ),
        );
        expect(readAntigravityConversationHead(path)?.firstPrompt).toBe('x'.repeat(MESSAGE_CHARS));
    }, 300_000);
});
