import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings, TerminalRecord } from '@caxri/protocol';
import { defaultAgentActionsSettings, defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigService } from '../../config';
import type { CaxriDatabase } from '../../db';
import { listAgentActions, readAgentAction, recordRecentAgentAction } from '../actions';

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
        ...structuredClone(defaultAgentActionsSettings),
        items: {
            '/goal': { enabled: true, description: 'Manage a long-running goal' },
            '/status': { enabled: false },
        },
    };
    return value;
}

describe('readAgentAction', () => {
    it('reads a discovered skill body by invocation, even after the Agent stopped', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-actions-read-'));
        temporaryDirectories.push(root);
        const skillDirectory = join(root, '.agents', 'skills', 'status-report');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: status-report\ndescription: Report delivery status\n---\n\n# Status report\n\nList every open PR.\n',
        );
        const database = databaseWith({
            id: 'terminal-1',
            sessionId: 'session-1',
            cwd: root,
            provider: 'codex',
            lastProcessState: 'stopped',
        });
        const environment = { homeDirectory: join(root, 'home'), variables: {} };

        const result = await readAgentAction(database, environment, 'terminal-1', '$status-report');

        expect(result).toEqual({
            invocation: '$status-report',
            kind: 'skill',
            description: 'Report delivery status',
            markdown: '# Status report\n\nList every open PR.',
        });
        expect(JSON.stringify(result)).not.toContain(root);
        await expect(
            readAgentAction(database, environment, 'terminal-1', '$missing'),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

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

describe('recordRecentAgentAction', () => {
    it('derives the provider from the authoritative Terminal record', async () => {
        const record = vi.fn(() =>
            Promise.resolve({ version: 1 as const, invocations: ['/status'] }),
        );
        const config = { recordRecentAgentAction: record } as unknown as ConfigService;

        await expect(
            recordRecentAgentAction(
                databaseWith({ id: 'agent-1', provider: 'codex' }),
                config,
                'agent-1',
                '/status',
            ),
        ).resolves.toEqual({ version: 1, invocations: ['/status'] });
        expect(record).toHaveBeenCalledWith('codex', '/status');

        expect(() =>
            recordRecentAgentAction(databaseWith({ id: 'shell-1' }), config, 'shell-1', '/status'),
        ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error);
    });
});

describe('listAgentActions with skills the running provider reports', () => {
    async function scannedProject() {
        const root = await mkdtemp(join(tmpdir(), 'caxri-actions-reported-'));
        temporaryDirectories.push(root);
        await Promise.all(
            ['commit', 'stale'].map(async (name) => {
                const directory = join(root, '.agents', 'skills', name);
                await mkdir(directory, { recursive: true });
                await writeFile(
                    join(directory, 'SKILL.md'),
                    `---\nname: ${name}\ndescription: Scanned ${name}\n---\nBody.\n`,
                );
            }),
        );
        const pluginDirectory = join(root, 'plugin-skill');
        await mkdir(pluginDirectory);
        const pluginFile = join(pluginDirectory, 'SKILL.md');
        await writeFile(pluginFile, '---\nname: github:triage\n---\nTriage the issue.\n');
        const database = databaseWith({
            id: 'terminal-1',
            sessionId: 'session-1',
            cwd: root,
            provider: 'codex',
            lastProcessState: 'running',
        });
        return {
            root,
            pluginFile,
            database,
            environment: { homeDirectory: join(root, 'h'), variables: {} },
        };
    }

    it('lists enabled plugin skills, drops disabled and unreported scanned ones, and keeps paths off the wire', async () => {
        const { root, pluginFile, database, environment } = await scannedProject();
        const result = await listAgentActions(database, environment, settings(), 'terminal-1', () =>
            Promise.resolve([
                {
                    name: 'github:triage',
                    description: 'Triage',
                    enabled: true,
                    isProject: false,
                    path: pluginFile,
                },
                { name: 'linear:plan', enabled: false, isProject: false, path: pluginFile },
                {
                    name: 'commit',
                    description: 'Reported commit',
                    enabled: true,
                    isProject: true,
                    path: pluginFile,
                },
            ]),
        );
        const skills = result.actions.filter(({ kind }) => kind === 'skill');
        expect(
            skills
                .map(({ invocation }) => invocation)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['$commit', '$github:triage']);
        expect(skills.find(({ invocation }) => invocation === '$commit')).toMatchObject({
            description: 'Reported commit',
            source: 'project',
        });
        expect(JSON.stringify(result)).not.toContain(root);
    });

    it.each([
        ['has no answer', () => Promise.resolve(undefined)],
        ['fails', () => Promise.reject(new Error('Method not found'))],
    ])('falls back to the scan when the provider %s', async (_case, reader) => {
        const { database, environment } = await scannedProject();
        const result = await listAgentActions(
            database,
            environment,
            settings(),
            'terminal-1',
            reader,
        );
        expect(
            result.actions
                .filter(({ kind }) => kind === 'skill')
                .map(({ invocation }) => invocation)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['$commit', '$stale']);
    });

    it('reads a reported plugin skill body by invocation', async () => {
        const { pluginFile, database, environment } = await scannedProject();
        const result = await readAgentAction(
            database,
            environment,
            'terminal-1',
            '$github:triage',
            () =>
                Promise.resolve([
                    { name: 'github:triage', enabled: true, isProject: false, path: pluginFile },
                ]),
        );
        expect(result.markdown).toBe('Triage the issue.');
    });
});
