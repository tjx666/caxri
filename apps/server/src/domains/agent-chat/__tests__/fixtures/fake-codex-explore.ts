/**
 * Work-group scenario for the fake Codex app-server. It exposes active command transitions before the settled aggregate
 * and enough reads to exercise the expanded group's scroll boundary.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeItem, FakeTurn } from './fake-codex-io.ts';
import { completeMcpCalls } from './fake-codex-mcp-calls.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runExplore(io: FakeCodexIo, turn: FakeTurn, isGradual: boolean) {
    const run = async (command: string, output: string) => {
        const item: FakeItem = {
            type: 'commandExecution',
            id: crypto.randomUUID(),
            command: `/bin/zsh -lc "${command}"`,
            cwd: process.cwd(),
            status: 'completed',
            aggregatedOutput: output,
            exitCode: 0,
            durationMs: 5,
        };
        if (isGradual && !command.startsWith('sed ')) {
            io.startItem(turn, { ...item, status: 'inProgress' });
            // Well past the 1s a running call waits before it names itself in the summary (`agentChatWorkSummaryItems`),
            // so the running label stays on screen long enough to read.
            await delay(2500);
        }
        io.completeItem(turn, item);
    };

    await io.streamMessage(turn, 'Looking around the project.', 0);
    await run('cat src/app.ts', 'export const answer: number = 42;\n');
    if (isGradual) await delay(200);
    await run('git status --short', ' M src/app.ts\n');
    for (let start = 1; start <= 81; start += 10) {
        // eslint-disable-next-line no-await-in-loop -- preserve the provider's sequential tool order.
        await run(`sed -n '${start},${start + 9}p' src/app.ts`, '');
        // eslint-disable-next-line no-await-in-loop -- paced tool events expose first-paint grouping.
        if (isGradual) await delay(200);
    }
    completeMcpCalls(io, turn);
    await io.streamMessage(turn, 'Explored the project.', 0);
}
