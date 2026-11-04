import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { DELEGATION_COMMANDS } from '../delegation';

describe('delegation CLI', () => {
    it.each(['claude', 'codex'])(
        'loads bounded %s task input from an explicit file instead of a positional prompt',
        async (provider) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-cli-'));
            onTestFinished(() => rm(directory, { recursive: true, force: true }));
            const path = join(directory, 'task.md');
            await writeFile(path, 'Synthetic task');
            const command = DELEGATION_COMMANDS.find(
                (item) => item.method === 'agent.delegation.create',
            )!;
            const tokens = [
                '--project',
                'project',
                '--session',
                'session',
                '--provider',
                provider,
                '--prompt-file',
                path,
            ];
            expect(await command.parseParams(tokens)).toEqual({
                projectId: 'project',
                sessionId: 'session',
                provider,
                prompt: 'Synthetic task',
            });
            await expect(command.parseParams(['Synthetic task'])).rejects.toThrow(/unique/u);
            await writeFile(path, 'a'.repeat(16_385));
            await expect(command.parseParams(tokens)).rejects.toThrow(/16 KiB/u);
        },
    );

    it('asks for a new Session in place of --session, never both or neither', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-cli-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, 'task.md');
        await writeFile(path, 'Synthetic task');
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.create',
        )!;
        const base = ['--project', 'project', '--provider', 'codex', '--prompt-file', path];
        expect(
            await command.parseParams([...base, '--new-session', '--title', 'Fix login retry']),
        ).toEqual({
            projectId: 'project',
            newSession: true,
            title: 'Fix login retry',
            provider: 'codex',
            prompt: 'Synthetic task',
        });
        await expect(command.parseParams([...base, '--new-session'])).rejects.toThrow(/--title/u);
        expect(
            await command.parseParams([
                ...base,
                '--new-session',
                '--handoff',
                '--title',
                'Fix login retry',
            ]),
        ).toMatchObject({ newSession: true, handoff: true });
        expect(
            await command.parseParams([
                ...base,
                '--new-session',
                '--consult',
                '--title',
                'Review the retry design',
            ]),
        ).toMatchObject({ newSession: true, consult: true });
        await expect(
            command.parseParams([...base, '--session', 'session', '--consult']),
        ).rejects.toThrow(/--consult applies only with --new-session/u);
        await expect(
            command.parseParams([
                ...base,
                '--new-session',
                '--consult',
                '--handoff',
                '--title',
                'Fix login retry',
            ]),
        ).rejects.toThrow(/--consult or --handoff, not both/u);
        await expect(
            command.parseParams([
                ...base,
                '--new-session',
                '--consult',
                '--consult',
                '--title',
                'Fix login retry',
            ]),
        ).rejects.toThrow(/--consult at most once/u);
        expect(
            await command.parseParams([
                ...base,
                '--new-session',
                '--title',
                'Fix login retry',
                '--worktree',
                'feat/login-retry',
            ]),
        ).toMatchObject({ newSession: true, worktreeBranch: 'feat/login-retry' });
        await expect(
            command.parseParams([...base, '--session', 'session', '--worktree', 'feat/x']),
        ).rejects.toThrow(/--worktree applies only with --new-session/u);
        await expect(
            command.parseParams([...base, '--session', 'session', '--handoff']),
        ).rejects.toThrow(/--handoff applies only with --new-session/u);
        await expect(
            command.parseParams([
                ...base,
                '--new-session',
                '--handoff',
                '--handoff',
                '--title',
                'Fix login retry',
            ]),
        ).rejects.toThrow(/--handoff at most once/u);
        await expect(
            command.parseParams([...base, '--session', 'session', '--title', 'Fix login retry']),
        ).rejects.toThrow(/--title/u);
        await expect(
            command.parseParams([...base, '--new-session', '--session', 'session']),
        ).rejects.toThrow(/one of --session or --new-session/u);
        await expect(command.parseParams(base)).rejects.toThrow(
            /one of --session or --new-session/u,
        );
        await expect(
            command.parseParams([
                ...base,
                '--new-session',
                '--title',
                'Fix login retry',
                '--follow-up',
                'task-1',
            ]),
        ).rejects.toThrow();
    });

    it('maps --surface terminal to pty and refuses it on a continuation or a bad value', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-cli-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, 'task.md');
        await writeFile(path, 'Synthetic task');
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.create',
        )!;
        const base = [
            '--project',
            'project',
            '--session',
            'session',
            '--provider',
            'claude',
            '--prompt-file',
            path,
        ];
        expect(await command.parseParams([...base, '--surface', 'terminal'])).toMatchObject({
            surface: 'pty',
        });
        expect(await command.parseParams([...base, '--surface', 'chat'])).toMatchObject({
            surface: 'chat',
        });
        expect(await command.parseParams(base)).not.toHaveProperty('surface');
        await expect(command.parseParams([...base, '--surface', 'pty'])).rejects.toThrow(
            /chat or terminal/u,
        );
        const continuations = ['--follow-up', '--resume', '--continue-handover'];
        await Promise.all(
            continuations.map((flag) =>
                expect(
                    command.parseParams([...base, '--surface', 'chat', flag, 'task-1']),
                ).rejects.toThrow(/keeps the surface/u),
            ),
        );
    });

    it('delegates by folder: --project-path resolves against the shell directory and needs --new-session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-cli-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, 'task.md');
        await writeFile(path, 'Synthetic task');
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.create',
        )!;
        const base = ['--provider', 'codex', '--prompt-file', path];
        const fresh = ['--new-session', '--title', 'Fix login retry'];
        const parsed = await command.parseParams([
            ...base,
            ...fresh,
            '--project-path',
            '../other-repo',
        ]);
        expect(parsed).toEqual({
            projectPath: resolve('../other-repo'),
            newSession: true,
            title: 'Fix login retry',
            provider: 'codex',
            prompt: 'Synthetic task',
        });
        expect(parsed).not.toHaveProperty('projectId');
        await expect(
            command.parseParams([...base, ...fresh, '--project-path', '/a', '--project', 'p']),
        ).rejects.toThrow(/not both/u);
        await expect(
            command.parseParams([...base, '--session', 'session', '--project-path', '/a']),
        ).rejects.toThrow(/only with --new-session/u);
        await expect(command.parseParams([...base, ...fresh])).rejects.toThrow(
            /--project or --project-path/u,
        );
        expect(
            await command.parseParams([...base, ...fresh, '--consult', '--project-path', '/a']),
        ).toMatchObject({ projectPath: '/a', consult: true });
    });

    it('waits on one or several tasks and rejects flags or an unbounded list', () => {
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.wait',
        )!;
        expect(command.parseParams(['task-1'])).toEqual({ delegationId: 'task-1' });
        expect(command.parseParams(['task-1', 'task-2', 'task-3'])).toEqual({
            delegationId: 'task-1',
            otherDelegationIds: ['task-2', 'task-3'],
        });
        expect(() => command.parseParams([])).toThrow(/delegation IDs/u);
        expect(() => command.parseParams(['task-1', '--json'])).toThrow(/delegation IDs/u);
        expect(() =>
            command.parseParams(Array.from({ length: 33 }, (_, index) => `task-${index}`)),
        ).toThrow(/delegation IDs/u);
    });

    it('lets a wait skip questions and rejects the flag twice', () => {
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.wait',
        )!;
        expect(command.parseParams(['task-1', '--ignore-questions'])).toEqual({
            delegationId: 'task-1',
            ignoreQuestions: true,
        });
        expect(command.parseParams(['--ignore-questions', 'task-1', 'task-2'])).toEqual({
            delegationId: 'task-1',
            otherDelegationIds: ['task-2'],
            ignoreQuestions: true,
        });
        expect(() =>
            command.parseParams(['task-1', '--ignore-questions', '--ignore-questions']),
        ).toThrow(/at most once/u);
        expect(() => command.parseParams(['--ignore-questions'])).toThrow(/delegation IDs/u);
    });

    it('lists the caller own tasks with an optional active filter and bounded limit', () => {
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.list',
        )!;

        expect(command.parseParams([])).toEqual({ active: false });
        expect(command.parseParams(['--active', '--limit', '5'])).toEqual({
            active: true,
            limit: 5,
        });
        expect(() => command.parseParams(['--limit', 'all'])).toThrow(/positive integer/u);
        expect(() => command.parseParams(['--session', 'x'])).toThrow(/Unexpected argument/u);
    });

    it('reads a delegated Chat from the start or after a cursor', () => {
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.transcript',
        )!;

        expect(command.path).toEqual(['agent', 'delegate', 'transcript']);
        expect(command.parseParams(['task-1'])).toEqual({ delegationId: 'task-1' });
        expect(command.parseParams(['task-1', '--after', 'cursor'])).toEqual({
            delegationId: 'task-1',
            after: 'cursor',
        });
        expect(() => command.parseParams([])).toThrow(/one delegation ID/u);
        expect(() => command.parseParams(['task-1', '--after'])).toThrow(/--after <cursor>/u);
        expect(() => command.parseParams(['task-1', 'task-2'])).toThrow(/--after <cursor>/u);
    });
});
