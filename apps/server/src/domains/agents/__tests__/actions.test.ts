import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings, TerminalRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { listAgentActions } from '../actions';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pending = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((directory) => rm(directory, { recursive: true, force: true })));
});

function databaseWith(terminal: Partial<TerminalRecord>): CaxriDatabase {
    return {
        getProject: () => ({ id: 'project-1', rootPath: terminal.cwd }),
        getSession: () => ({ id: 'session-1', projectId: 'project-1' }),
        getTerminal: () => terminal,
    } as unknown as CaxriDatabase;
}

function settings(): AppSettings {
    const value = structuredClone(defaultAppSettings);
    value['agents.providers'].codex.actions = {
        items: {
            '/goal': { enabled: true, description: 'Manage a long-running goal' },
            '/status': { enabled: false },
        },
    };
    return value;
}

describe('listAgentActions', () => {
    it('binds discovery and overrides to the durable running Agent Terminal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-actions-service-'));
        temporaryDirectories.push(root);
        const skillDirectory = join(root, '.agents', 'skills', 'commit');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: commit\ndescription: Commit the current changes\n---\nPrivate body.\n',
        );

        const result = await listAgentActions(
            databaseWith({
                id: 'terminal-1',
                sessionId: 'session-1',
                cwd: root,
                provider: 'codex',
                lastProcessState: 'running',
            }),
            { homeDirectory: join(root, 'home'), variables: {} },
            settings(),
            'terminal-1',
        );

        expect(result.provider).toBe('codex');
        expect(result.actions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ invocation: '$commit', source: 'project' }),
                expect.objectContaining({ invocation: '/goal', source: 'custom' }),
            ]),
        );
        expect(result.actions.some((action) => action.invocation === '/status')).toBe(false);
        expect(JSON.stringify(result)).not.toContain(root);
        expect(JSON.stringify(result)).not.toContain('Private body');
    });

    it('rejects Shell and stopped Agent Terminals before discovery', async () => {
        await expect(
            listAgentActions(
                databaseWith({
                    id: 'shell-1',
                    sessionId: 'session-1',
                    cwd: '/project',
                    lastProcessState: 'running',
                }),
                { homeDirectory: '/home', variables: {} },
                settings(),
                'shell-1',
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
            listAgentActions(
                databaseWith({
                    id: 'agent-1',
                    sessionId: 'session-1',
                    cwd: '/project',
                    provider: 'claude',
                    lastProcessState: 'stopped',
                }),
                { homeDirectory: '/home', variables: {} },
                settings(),
                'agent-1',
            ),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('reports partial results when discovered actions fill the response capacity', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-actions-capacity-'));
        temporaryDirectories.push(root);
        const skillRoot = join(root, '.agents', 'skills');
        await mkdir(skillRoot, { recursive: true });
        await Promise.all(
            Array.from({ length: 252 }, async (_, index) => {
                const directory = join(skillRoot, `skill-${index.toString().padStart(3, '0')}`);
                await mkdir(directory);
                await writeFile(join(directory, 'SKILL.md'), '---\n---\n');
            }),
        );

        const result = await listAgentActions(
            databaseWith({
                id: 'terminal-capacity',
                sessionId: 'session-1',
                cwd: root,
                provider: 'codex',
                lastProcessState: 'running',
            }),
            { homeDirectory: join(root, 'home'), variables: {} },
            defaultAppSettings,
            'terminal-capacity',
        );

        expect(result.actions).toHaveLength(256);
        expect(result.discovery).toBe('partial');
        expect(result.actions.some((action) => action.invocation === '/status')).toBe(true);
    });
});
