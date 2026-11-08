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
    void io.streamMessage(turn, `Answered in this turn: ${text}`, 0);
}

/**
 * Answers the steer only in a titled thought and goes straight back to work with two commands, the way a model
 * sometimes replies to a steer in its thinking alone; a Client must show that thought instead of folding it into the
 * calls after it.
 */
export function thinkAboutSteeredMessage(io: FakeCodexIo, turn: FakeTurn) {
    io.completeItem(turn, {
        type: 'reasoning',
        id: crypto.randomUUID(),
        summary: [
            '**Answering the steer**\n\nYes, a WebView costs more memory and opens slower, so I will check the native option first.',
        ],
        content: [],
    });
    for (const command of ['git status --short', 'git log --oneline -1'])
        io.completeItem(turn, {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: `/bin/zsh -lc "${command}"`,
            cwd: process.cwd(),
            aggregatedOutput: '',
            status: 'completed',
            exitCode: 0,
        });
}
