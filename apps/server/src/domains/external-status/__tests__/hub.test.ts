import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { currentBackgroundWork, runAsBackgroundWork } from '../../../observability/background-work';
import { scheduleGitCommand } from '../../git/command';
import { GitCommandBudget } from '../../git/command-budget';
import type { ExternalStatusRunner } from '../command';
import { ExternalStatusHub } from '../hub';

const silentLogger: Pick<StructuredLogger, 'write'> = { write: () => {} };

/**
 * A runner whose `git` calls the test finishes by hand, recording which ones have started.
 */
function controlledRunner() {
    const started: string[] = [];
    const finishers = new Map<string, () => void>();
    const runner: ExternalStatusRunner = (_source, arguments_) => {
        const [name] = arguments_.slice(-1);
        started.push(name);
        const done = Promise.withResolvers<string>();
        finishers.set(name, () => done.resolve(`${name}\n`));
        return done.promise;
    };
    const finish = (name: string) => finishers.get(name)?.();
    return { finish, runner, started };
}

function loadedBudget() {
    return new GitCommandBudget(8, {
        isBackground: () => currentBackgroundWork() !== undefined,
        isLoaded: () => true,
    });
}

/**
 * A hub wired the way the Server's composition root wires it, against a test budget and logger.
 */
function scheduledHub(
    gitCommands: GitCommandBudget,
    runner: ExternalStatusRunner,
    logger: Pick<StructuredLogger, 'write'> = silentLogger,
) {
    return new ExternalStatusHub({
        runner,
        scheduleGit: (cwd, arguments_, run) =>
            scheduleGitCommand(gitCommands, logger, cwd, arguments_, run),
    });
}

describe('ExternalStatusHub git probes', () => {
    it('queue in the shared Git budget: a loaded machine holds them to two background slots and lets foreground Git through', async () => {
        const { finish, runner, started } = controlledRunner();
        const gitCommands = loadedBudget();
        const hub = scheduledHub(gitCommands, runner);
        const probes = ['b1', 'b2', 'b3'].map((name) =>
            runAsBackgroundWork('project-status-poll', () =>
                hub.run('git', ['rev-parse', name], '/repo'),
            ),
        );
        await expect.poll(() => started).toEqual(['b1', 'b2']);

        const foreground = gitCommands.run(() => {
            started.push('foreground');
            return Promise.resolve();
        });
        await foreground;
        expect(started).toEqual(['b1', 'b2', 'foreground']);

        finish('b1');
        await expect.poll(() => started).toEqual(['b1', 'b2', 'foreground', 'b3']);
        finish('b2');
        finish('b3');
        await expect(Promise.all(probes)).resolves.toEqual(['b1\n', 'b2\n', 'b3\n']);
    });

    it('record each probe as git.command, naming the background driver when it is slow', async () => {
        const write = vi.fn<StructuredLogger['write']>();
        const now = vi.spyOn(performance, 'now');
        let clock = 0;
        now.mockImplementation(() => clock);
        const hub = scheduledHub(
            loadedBudget(),
            () => {
                clock += 1_500;
                return Promise.resolve('origin\n');
            },
            { write },
        );

        await runAsBackgroundWork('project-status-poll', () =>
            hub.run('git', ['remote', 'get-url', 'origin'], '/repo'),
        );
        now.mockRestore();

        const records = write.mock.calls.filter(([, event]) => event === 'git.command');
        expect(records).toHaveLength(1);
        const [[level, , options]] = records;
        expect(level).toBe('info');
        expect(options?.fields).toMatchObject({
            background: 'project-status-poll',
            execMs: 1_500,
            operation: 'remote.get-url',
            queueMs: 0,
        });
    });

    it('keep gh calls out of the Git budget', async () => {
        const scheduleGit = vi.fn<(cwd: string) => Promise<string>>();
        const hub = new ExternalStatusHub({ runner: () => Promise.resolve('[]'), scheduleGit });

        await hub.run('gh', ['pr', 'list'], '/repo');
        expect(scheduleGit).not.toHaveBeenCalled();
    });
});
