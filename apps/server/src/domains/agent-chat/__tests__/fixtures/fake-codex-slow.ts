/**
 * The `slow` scenario of the fake Codex app-server: a titled thought, a command still running while a long reply
 * streams (so live work is on screen and `turn/interrupt` can stop it), and two token usage reports that the composer
 * strip counts as the turn's steps and tokens.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';
import { CODEX_RECONNECTING } from './fake-codex-retry.ts';

/**
 * With `reconnect`, a dropped stream's retry notice arrives before the reply streams.
 */
export async function runSlow(io: FakeCodexIo, turn: FakeTurn, reconnect: boolean) {
    io.completeItem(turn, {
        type: 'reasoning',
        id: crypto.randomUUID(),
        summary: ['**Planning the reply**\n\nTake it slow.'],
        content: [],
    });
    const command = {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "rg -n slow src"',
        cwd: process.cwd(),
        aggregatedOutput: '',
    };
    io.startItem(turn, { ...command, status: 'inProgress' });
    for (const [total, input] of [
        [1200, 1150],
        [2500, 1250],
    ])
        io.notifyTurn(turn, 'thread/tokenUsage/updated', {
            turnId: turn.id,
            tokenUsage: {
                total: { totalTokens: total },
                last: {
                    totalTokens: input + 50,
                    inputTokens: input,
                    cachedInputTokens: 900,
                    outputTokens: 50,
                },
                modelContextWindow: 200_000,
            },
        });
    if (reconnect) io.notifyTurn(turn, 'error', { turnId: turn.id, ...CODEX_RECONNECTING });
    await io.streamMessage(turn, 'word '.repeat(200), 50);
    // An interrupted turn leaves the command dangling, which closing the turn settles.
    if (!turn.interrupted) io.completeItem(turn, { ...command, status: 'completed', exitCode: 0 });
}
