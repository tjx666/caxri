/**
 * `review/start` for the fake Codex app-server (`fake-codex-app-server.ts`). Each request's parameters are appended to
 * `review-requests.jsonl` so tests can assert what Caxri asked for. Like Codex, an inline review is a turn of the
 * thread that enters review mode, runs, and exits it with the review's conclusion as the `exitedReviewMode` item's
 * `review` text, with no agent message of its own. A `commit` target whose SHA is not hexadecimal fails as Codex fails
 * on an unknown revision, and custom instructions containing `slow` keep the review running for {@link SLOW_REVIEW_MS}.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import type { FakeCodexIo } from './fake-codex-io.ts';
import { stateFile } from './fake-codex-threads.ts';

const REVIEW_START_DELAY_MS = 50;
const REVIEW_MS = 200;
const SLOW_REVIEW_MS = 6000;

const REVIEW_CONCLUSION = [
    '## Review findings',
    '',
    '- **High** `src/session.ts:12`: `user` can be `undefined` here, so `user.name` throws for a signed-out visitor.',
    '- **Low** `src/session.ts:30`: the retry loop never backs off.',
    '',
    'Overall the change needs a null check before it ships.',
].join('\n');

function targetHint(target: Record<string, unknown>): string {
    switch (target.type) {
        case 'baseBranch': {
            return `changes against '${String(target.branch)}'`;
        }
        case 'commit': {
            return `commit ${String(target.sha).slice(0, 7)}`;
        }
        case 'custom': {
            return String(target.instructions);
        }
        default: {
            return 'current changes';
        }
    }
}

export function didHandleReviewRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
    parameters: Record<string, unknown>,
): boolean {
    if (method !== 'review/start') return false;
    fs.appendFileSync(stateFile('review-requests.jsonl'), `${JSON.stringify(parameters)}\n`);
    const target = (parameters.target ?? {}) as Record<string, unknown>;
    if (target.type === 'commit' && !/^[\da-f]{4,40}$/iu.test(String(target.sha))) {
        io.send({
            id,
            error: { code: -32600, message: `unknown revision '${String(target.sha)}'` },
        });
        return true;
    }
    const turn = io.beginTurn();
    io.send({
        id,
        result: {
            turn: { id: turn.id, items: [], status: 'inProgress' },
            reviewThreadId: io.currentThread().id,
        },
    });
    const entered = {
        type: 'enteredReviewMode',
        id: crypto.randomUUID(),
        review: targetHint(target),
    };
    setTimeout(() => {
        io.startItem(turn, entered);
        io.completeItem(turn, entered);
        const isSlow = target.type === 'custom' && String(target.instructions).includes('slow');
        setTimeout(
            () => {
                const exited = {
                    type: 'exitedReviewMode',
                    id: crypto.randomUUID(),
                    review: REVIEW_CONCLUSION,
                };
                io.startItem(turn, exited);
                io.completeItem(turn, exited);
                io.finishTurn(turn);
            },
            isSlow ? SLOW_REVIEW_MS : REVIEW_MS,
        );
    }, REVIEW_START_DELAY_MS);
    return true;
}
