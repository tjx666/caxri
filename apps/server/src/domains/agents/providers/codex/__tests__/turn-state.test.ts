import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { readCodexTurnState } from '../turn-state';

const THREAD_ID = '01931f2e-7b0a-7abc-8def-0123456789ab';
/**
 * Unix seconds of the orphaned turn; the resumed process starts an hour later.
 */
const TURN_STARTED_AT = 1_790_000_000;
const RESUMED_AT = (TURN_STARTED_AT + 3600) * 1000;

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

async function turnHistory(
    rows: Array<[turnId: string, ordinal: number, status: string, startedAt: number]>,
) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-turn-state-'));
    temporaryDirectories.push(directory);
    const database = new Database(join(directory, 'thread_history_1.sqlite'));
    database.exec(
        'CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER)',
    );
    const insert = database.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)');
    for (const [turnId, ordinal, status, startedAt] of rows)
        insert.run(THREAD_ID, turnId, ordinal, status, startedAt);
    database.close();
    return [directory];
}

describe('readCodexTurnState', () => {
    /**
     * A Codex process killed mid-turn never records `turn_aborted`; resuming the thread left the Session Working
     * forever.
     */
    it('settles a latest turn left in progress by an earlier Agent process', async () => {
        const directories = await turnHistory([
            ['turn-done', 1, 'completed', TURN_STARTED_AT - 60],
            ['turn-orphaned', 2, 'inProgress', TURN_STARTED_AT],
        ]);

        await expect(
            readCodexTurnState({ agentSessionId: THREAD_ID, startedAt: RESUMED_AT }, directories),
        ).resolves.toEqual({
            activitySource: 'latestTurn',
            activityTurnId: 'turn-orphaned',
            status: 'completed',
        });
    });

    it('keeps a turn the current Agent process started running', async () => {
        const directories = await turnHistory([
            ['turn-orphaned', 1, 'inProgress', TURN_STARTED_AT],
            // Whole-second precision: this turn reads up to a second before the process start.
            ['turn-current', 2, 'inProgress', RESUMED_AT / 1000 - 1],
        ]);

        await expect(
            readCodexTurnState({ agentSessionId: THREAD_ID, startedAt: RESUMED_AT }, directories),
        ).resolves.toMatchObject({ activityTurnId: 'turn-current', status: 'running' });
    });

    it('trusts an exact hook turn and an unknown process start', async () => {
        const directories = await turnHistory([
            ['turn-orphaned', 1, 'inProgress', TURN_STARTED_AT],
        ]);

        await expect(
            readCodexTurnState(
                { agentSessionId: THREAD_ID, agentTurnId: 'turn-orphaned', startedAt: RESUMED_AT },
                directories,
            ),
        ).resolves.toMatchObject({ activitySource: 'exactTurn', status: 'running' });
        await expect(
            readCodexTurnState({ agentSessionId: THREAD_ID }, directories),
        ).resolves.toMatchObject({ activitySource: 'latestTurn', status: 'running' });
    });
});
