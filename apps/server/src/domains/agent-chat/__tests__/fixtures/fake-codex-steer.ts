/**
 * A steered message the fake Codex app-server answers inside the running turn, the way Codex works on and replies to
 * each message steered into a turn before the turn ends.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * Runs the steer's own command, then streams its own reply while the turn's earlier work continues.
 */
export function answerSteeredMessage(io: FakeCodexIo, turn: FakeTurn, text: string) {
    io.completeItem(turn, {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "git status --short"',
        cwd: process.cwd(),
        aggregatedOutput: '',
        status: 'completed',
        exitCode: 0,
    });
    // eslint-disable-next-line no-void -- the reply streams while the turn's own work continues
    void io.streamMessage(turn, `Answered in this turn: ${text}`, 0);
}
