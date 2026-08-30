import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

describe('Agent child-process state persistence', () => {
    it('tracks the outer Shell and Agent child process independently', async () => {
        const directory = await temporaryDirectory('caxri-db-terminal-process-states-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const shell = database.createSession(project.id, 'shell').terminal!;
        const agent = database.createSession(project.id, 'codex').terminal!;

        expect(shell).toMatchObject({
            lastProcessState: 'starting',
            lastAgentProcessState: undefined,
        });
        expect(agent).toMatchObject({
            lastProcessState: 'starting',
            lastAgentProcessState: 'starting',
        });

        database.updateTerminalState(agent.id, 'running');
        database.updateAgentProcessState(agent.id, 'running');
        expect(database.getTerminal(agent.id)).toMatchObject({
            lastProcessState: 'running',
            lastAgentProcessState: 'running',
        });

        database.updateAgentProcessState(agent.id, 'stopped');
        expect(database.getTerminal(agent.id)).toMatchObject({
            lastProcessState: 'running',
            lastAgentProcessState: 'stopped',
        });
        database.updateAgentProcessState(agent.id, 'dead');
        expect(database.getTerminal(agent.id)).toMatchObject({
            lastProcessState: 'running',
            lastAgentProcessState: 'dead',
        });
        database.close();
    });

    it('starts Agent state when promoting a live Shell', async () => {
        const directory = await temporaryDirectory('caxri-db-promoted-process-state-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');

        database.updateTerminalState(created.terminal!.id, 'running');
        expect(database.promoteShellToAgent(created.terminal!.id, 'codex')).toBe(true);

        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            lastProcessState: 'running',
            lastAgentProcessState: 'running',
        });
        database.close();
    });

    it.each([
        ['unclean', 'interrupted'],
        ['orderly', 'interrupted'],
        ['terminate', 'stopped'],
    ] as const)('marks live Agent child processes for a %s shutdown', async (reason, expected) => {
        const directory = await temporaryDirectory(`caxri-db-agent-shutdown-${reason}-`);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const starting = database.createSession(project.id, 'codex').terminal!;
        const running = database.createTerminal(starting.sessionId, 'claude');
        const finished = database.createTerminal(starting.sessionId, 'codex');
        const shell = database.createTerminal(starting.sessionId, 'shell');
        database.updateAgentProcessState(running.id, 'running');
        database.updateAgentProcessState(finished.id, 'dead');

        database.markAgentProcessesShutdown(reason);

        expect(database.getTerminal(starting.id)?.lastAgentProcessState).toBe(expected);
        expect(database.getTerminal(running.id)?.lastAgentProcessState).toBe(expected);
        expect(database.getTerminal(finished.id)?.lastAgentProcessState).toBe('dead');
        expect(database.getTerminal(shell.id)?.lastAgentProcessState).toBeUndefined();
        database.close();
    });
});
