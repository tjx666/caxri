import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

/**
 * Claude Code's `EnterWorktree` moves the Agent's directory and relocates the session transcript to the new directory's
 * provider folder (the fake CLI does the same). A Chat that kept resuming from its launch root could no longer find its
 * conversation (issue caxri#1848).
 */
async function worktreeDirectory(): Promise<string> {
    const created = await mkdtemp(join(tmpdir(), 'caxri-enter-worktree-'));
    const root = await realpath(created);
    const directory = join(root, 'worktree');
    await mkdir(directory);
    return directory;
}

describe('Claude Chat after EnterWorktree', () => {
    it('reports the entered worktree and resumes the moved conversation from it', async () => {
        const worktree = await worktreeDirectory();
        let applyAgentCwd: (agentCwd: string | undefined) => void = () => {};
        const { database, service, terminal, signals, spawnProcess, until } = await fixture({
            provider: 'claude',
            observeLifecycleSignal: (signal) => {
                if (signal.agentCwd) applyAgentCwd(signal.agentCwd);
            },
        });
        // Stands in for the Workbench Root service, which proves the claim against Git before recording it.
        applyAgentCwd = (agentCwd) => {
            database.setTerminalAgentCwd(terminal.id, 'claude', agentCwd);
        };

        await service.send(terminal.id, { text: `enter worktree ${worktree}` });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(signals.filter((signal) => signal.agentCwd)).toEqual([
            expect.objectContaining({ phase: 'shellToolFinished', agentCwd: worktree }),
        ]);
        expect(database.getTerminal(terminal.id)?.agentCwd).toBe(worktree);

        await service.restart(terminal.id);

        const resumed = service.read(terminal.id);
        expect(resumed.status).toBe('ready');
        expect(resumed.items.some((item) => item.type === 'userMessage')).toBe(true);
        expect(spawnProcess.mock.calls[1][2].cwd).toBe(worktree);
        await service.send(terminal.id, { text: 'still here' });
        const next = await until(
            (snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId,
        );
        expect(next.items.at(-1)).toMatchObject({
            text: 'Hello from fake Claude. You said: still here',
        });
    });

    it('cannot resume once the transcript moved if the worktree is never recorded', async () => {
        const worktree = await worktreeDirectory();
        const { service, terminal, until } = await fixture({ provider: 'claude' });

        await service.send(terminal.id, { text: `enter worktree ${worktree}` });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        await service.restart(terminal.id);

        expect(service.read(terminal.id).failure?.reason).toBe('resume_failed');
    });
});
