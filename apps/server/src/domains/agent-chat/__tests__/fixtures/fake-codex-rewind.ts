/**
 * The fake Codex app-server's `thread/revert`, which "Edit from here" uses to drop the turns after an earlier message,
 * `thread/fork`, which "Fork from here" uses to copy the turns before one into a new thread, and the
 * `thread/unsubscribe` that releases the fork.
 */
import crypto from 'node:crypto';
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

/**
 * Writes a new thread holding the turns before `beforeTurnId`, and logs the call to `thread-forks.jsonl`. Unlike a
 * revert, a running turn does not block a fork of earlier turns. `threadPath` maps a thread id to its stored file.
 */
export function forkThread(
    thread: FakeThread,
    beforeTurnId: unknown,
    { stateDirectory, threadPath }: { stateDirectory: string; threadPath: (id: string) => string },
): Json {
    const index = thread.turns.findIndex((turn) => turn.id === beforeTurnId);
    if (index === -1) return { error: { code: -32600, message: 'no such turn to fork before' } };
    const forked: FakeThread = {
        ...thread,
        id: crypto.randomUUID(),
        turns: thread.turns.slice(0, index),
    };
    fs.writeFileSync(threadPath(forked.id), JSON.stringify(forked));
    fs.appendFileSync(
        path.join(stateDirectory, 'thread-forks.jsonl'),
        `${JSON.stringify({ threadId: thread.id, forkedId: forked.id, kept: index })}\n`,
    );
    return { result: { thread: { id: forked.id, turns: [] } } };
}

/**
 * Answers `thread/unsubscribe`, or fails it when the test created `unsubscribe-fails` in the state directory.
 */
export function unsubscribeThread(stateDirectory: string): Json {
    return fs.existsSync(path.join(stateDirectory, 'unsubscribe-fails'))
        ? { error: { code: -32600, message: 'thread is not loaded' } }
        : { result: { status: 'unsubscribed' } };
}
