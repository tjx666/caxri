/**
 * Thread goals for the fake Codex app-server (`fake-codex-app-server.ts`). `thread/goal/set`, `get`, and `clear` keep
 * the goal on the thread, and each request's parameters are appended to `goal-requests.jsonl` so tests can assert what
 * Caxri asked for. Like Codex, an active goal starts a turn on its own when the thread is idle, on `set` and after each
 * goal turn: the turn streams a short reply and completes the goal, unless the objective contains `hold`, which keeps
 * the turn streaming until `turn/interrupt` stops it. A `set` whose objective contains `reject` fails, as Codex refuses
 * an objective it cannot accept.
 */
import fs from 'node:fs';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';
import { stateFile } from './fake-codex-threads.ts';

type Json = Record<string, unknown>;

function recordGoalRequest(method: string, parameters: Json) {
    fs.appendFileSync(
        stateFile('goal-requests.jsonl'),
        `${JSON.stringify({ method, ...parameters })}\n`,
    );
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyGoal(io: FakeCodexIo, turnId: string | null, goal: Json) {
    io.send({
        method: 'thread/goal/updated',
        params: { threadId: io.currentThread().id, turnId, goal },
    });
}

async function pursueGoal(io: FakeCodexIo, turn: FakeTurn) {
    const thread = io.currentThread();
    const objective = typeof thread.goal?.objective === 'string' ? thread.goal.objective : '';
    if (objective.includes('hold')) {
        while (!turn.interrupted) {
            // eslint-disable-next-line no-await-in-loop -- streams until the user stops the turn
            await io.streamMessage(turn, 'Still pursuing the goal. ', 0);
            // eslint-disable-next-line no-await-in-loop -- see above
            await delay(20);
        }
        io.finishTurn(turn);
        return;
    }
    await io.streamMessage(turn, `Working toward: ${objective}`, 0);
    if (thread.goal?.status === 'active') {
        thread.goal = {
            ...thread.goal,
            status: 'complete',
            timeUsedSeconds: Number(thread.goal.timeUsedSeconds ?? 0) + 1,
            updatedAt: Math.floor(Date.now() / 1000),
        };
        notifyGoal(io, turn.id, thread.goal);
    }
    io.finishTurn(turn);
    continueIfIdle(io);
}

/**
 * Starts the next turn for an active goal once the thread is idle, as Codex does after every turn and on `set`.
 */
function continueIfIdle(io: FakeCodexIo) {
    if (io.currentThread().goal?.status !== 'active' || io.hasActiveTurn()) return;
    // eslint-disable-next-line no-void -- the goal's turn streams its own notifications
    void pursueGoal(io, io.beginTurn());
}

export function didHandleGoalRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
    parameters: Json,
): boolean {
    switch (method) {
        case 'thread/goal/get': {
            io.send({ id, result: { goal: io.currentThread().goal ?? null } });
            return true;
        }
        case 'thread/goal/set': {
            recordGoalRequest(method, parameters);
            if (
                typeof parameters.objective === 'string' &&
                parameters.objective.includes('reject')
            ) {
                io.send({ id, error: { code: -32600, message: 'objective rejected' } });
                return true;
            }
            const thread = io.currentThread();
            const now = Math.floor(Date.now() / 1000);
            const goal: Json = {
                threadId: thread.id,
                objective: '',
                status: 'active',
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: now,
                ...thread.goal,
                ...(typeof parameters.objective === 'string' && {
                    objective: parameters.objective,
                }),
                ...(typeof parameters.status === 'string' && { status: parameters.status }),
                updatedAt: now,
            };
            thread.goal = goal;
            io.send({ id, result: { goal } });
            notifyGoal(io, null, goal);
            continueIfIdle(io);
            io.save();
            return true;
        }
        case 'thread/goal/clear': {
            recordGoalRequest(method, parameters);
            const thread = io.currentThread();
            const isCleared = thread.goal !== undefined;
            delete thread.goal;
            io.send({ id, result: { cleared: isCleared } });
            if (isCleared)
                io.send({ method: 'thread/goal/cleared', params: { threadId: thread.id } });
            io.save();
            return true;
        }
        default: {
            return false;
        }
    }
}
