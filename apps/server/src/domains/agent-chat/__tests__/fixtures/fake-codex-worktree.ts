/**
 * The `newworktree` scenario of the fake Codex app-server (`fake-codex-app-server.ts`), for a Chat's worktree-creation
 * signals.
 */
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * The `newworktree` turn: a `git worktree add` wrapped the way Codex reports every command, started and then completed,
 * and a second one that exits non-zero although Codex reports it `completed`. Nothing runs on disk.
 */
export async function runWorktreeCommands(io: FakeCodexIo, turn: FakeTurn) {
    for (const [branch, exitCode] of [
        ['feature', 0],
        ['taken', 128],
    ] as const) {
        const command = {
            type: 'commandExecution',
            id: `call_${branch}`,
            command: `/bin/zsh -lc "git worktree add ../${branch} -b ${branch}"`,
            cwd: process.cwd(),
            status: 'inProgress',
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
        };
        io.startItem(turn, command);
        io.completeItem(turn, { ...command, status: 'completed', exitCode, durationMs: 40 });
    }
    await io.streamMessage(turn, 'Created the worktree.', 0);
}
