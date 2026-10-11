/**
 * The fake Codex app-server's `thread/revert`, which "Edit from here" uses to drop the turns after an earlier message.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { FakeThread } from './fake-codex-io.ts';

type Json = Record<string, unknown>;

interface RevertTarget {
    isTurnActive: boolean;
    /**
     * Where the thread persists, rewritten without the dropped turns.
     */
    threadFile: string;
    stateDirectory: string;
}

/**
 * Drops the turn `beforeTurnId` and everything after it, then logs the call to `thread-reverts.jsonl` so tests can
 * check how many turns survived. Returns the JSON-RPC `result` or `error` member to answer with.
 */
export function revertThread(
    thread: FakeThread,
    beforeTurnId: unknown,
    { isTurnActive, threadFile, stateDirectory }: RevertTarget,
): Json {
    const index = thread.turns.findIndex((turn) => turn.id === beforeTurnId);
    if (index === -1 || isTurnActive)
        return { error: { code: -32600, message: 'cannot revert to that turn' } };
    // App-server writes a new rollout under the same thread id, even when no turn is left.
    thread.turns = thread.turns.slice(0, index);
    fs.writeFileSync(threadFile, JSON.stringify(thread));
    fs.appendFileSync(
        path.join(stateDirectory, 'thread-reverts.jsonl'),
        `${JSON.stringify({ threadId: thread.id, kept: index })}\n`,
    );
    return { result: { thread: { id: thread.id, turns: [] }, turnsBackwardsCursor: null } };
}
