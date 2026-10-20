/**
 * Side questions for the fake Codex app-server (`fake-codex-app-server.ts`). An ephemeral `thread/fork` opens a side
 * thread; a `turn/start` on it streams one reply, quoting the question and how many earlier side exchanges it carried,
 * on that thread's own notifications while the Chat's thread keeps whatever it was doing. A question containing
 * `side-fail` ends the side turn as failed and one containing `side-empty` ends it without a reply. Every fork, side
 * turn, and `thread/unsubscribe` is appended to `side-threads.jsonl` so tests can assert what Caxri asked for. Like
 * Codex, a fork refuses a turn still in progress: it needs a `lastTurnId` while the Chat is mid-turn.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import type { FakeCodexIo } from './fake-codex-io.ts';
import { stateFile } from './fake-codex-threads.ts';

type Json = Record<string, unknown>;

const sideThreads = new Set<string>();

function record(entry: Json) {
    fs.appendFileSync(stateFile('side-threads.jsonl'), `${JSON.stringify(entry)}\n`);
}

function notifySide(io: FakeCodexIo, threadId: string, method: string, parameters: Json) {
    io.send({ method, params: { threadId, ...parameters } });
}

export function didHandleSideRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
    parameters: Json,
): boolean {
    if (method === 'thread/fork' && parameters.ephemeral === true) {
        if (io.hasActiveTurn() && typeof parameters.lastTurnId !== 'string') {
            io.send({
                id,
                error: { code: -32600, message: 'cannot fork a thread with a turn in progress' },
            });
            return true;
        }
        const threadId = `side-${crypto.randomUUID()}`;
        sideThreads.add(threadId);
        record({
            event: 'fork',
            threadId,
            sourceThreadId: parameters.threadId,
            lastTurnId: parameters.lastTurnId ?? null,
            sandbox: parameters.sandbox,
            approvalPolicy: parameters.approvalPolicy,
            developerInstructions: parameters.developerInstructions,
        });
        io.send({ id, result: { thread: { id: threadId, turns: [] } } });
        return true;
    }
    const threadId = typeof parameters.threadId === 'string' ? parameters.threadId : '';
    if (!sideThreads.has(threadId)) return false;
    if (method === 'thread/unsubscribe') {
        record({ event: 'unsubscribe', threadId });
        io.send({ id, result: { status: 'unsubscribed' } });
        return true;
    }
    if (method !== 'turn/start') return false;
    const text = ((parameters.input ?? []) as Array<{ text?: string }>)
        .map((entry) => entry.text ?? '')
        .join('\n');
    record({ event: 'turn', threadId, text });
    const turn = { id: crypto.randomUUID(), items: [], status: 'inProgress' };
    io.send({ id, result: { turn } });
    notifySide(io, threadId, 'turn/started', { turn });
    setTimeout(() => {
        const isFailure = text.includes('side-fail');
        if (!isFailure && !text.includes('side-empty')) {
            const earlier = text.startsWith('Earlier in this side thread:')
                ? text.split('\n\nQ: ').length - 1
                : 0;
            const asked = text.split('New side question: ').at(-1);
            const reply = `Side answer to "${asked}" after ${earlier} earlier`;
            const item = { type: 'agentMessage', id: crypto.randomUUID(), text: reply };
            notifySide(io, threadId, 'item/started', {
                turnId: turn.id,
                item: { ...item, text: '' },
            });
            notifySide(io, threadId, 'item/completed', { turnId: turn.id, item });
        }
        notifySide(io, threadId, 'turn/completed', {
            turn: { ...turn, status: isFailure ? 'failed' : 'completed' },
        });
    }, 20);
    return true;
}
