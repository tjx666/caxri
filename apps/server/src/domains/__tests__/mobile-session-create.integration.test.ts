import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Principal, ServerEvent, TerminalKind } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

const pairedPrincipal = (
    projectIds: string[],
    role: Extract<Principal, { kind: 'paired-device' }>['role'] = 'control',
): Extract<Principal, { kind: 'paired-device' }> => ({
    kind: 'paired-device',
    id: 'device-1',
    deviceId: 'device-1',
    generation: 1,
    projectIds,
    role,
});

describe('mobile Session creation', () => {
    it('enforces the device grant and role before creating a Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-create-auth-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            await Promise.all(
                [pairedPrincipal([]), pairedPrincipal([project.id], 'view')].map((principal) =>
                    expect(
                        runtime.handlers['mobile.session.createForPrincipal']({
                            projectId: project.id,
                            defaultAgent: 'shell',
                            principal,
                        }),
                    ).rejects.toMatchObject({ code: 'FORBIDDEN' }),
                ),
            );
            const canceled = new AbortController();
            canceled.abort();
            await expect(
                runtime.handlers['mobile.session.createForPrincipal'](
                    {
                        projectId: project.id,
                        defaultAgent: 'shell',
                        principal: pairedPrincipal([project.id]),
                    },
                    canceled.signal,
                ),
            ).rejects.toMatchObject({ code: 'CANCELLED' });
            expect((await runtime.handlers['app.bootstrap']({})).sessions).toEqual([]);
        } finally {
            await runtime.close();
        }
    });

    it('uses Desktop Agent launch settings and preserves the Desktop selection', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-create-launch-'));
        temporaryDirectories.push(directory);
        const selectedRoot = join(directory, 'selected');
        const remoteRoot = join(directory, 'remote');
        await Promise.all([mkdir(selectedRoot), mkdir(remoteRoot)]);
        const events: ServerEvent[] = [];
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => events.push(event),
            terminal: {
                resolveExecutable: (kind: TerminalKind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn,
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            const selectedProject = await runtime.handlers['project.create']({
                rootPath: selectedRoot,
            });
            const remoteProject = await runtime.handlers['project.create']({
                rootPath: remoteRoot,
            });
            const selected = await runtime.handlers['session.create']({
                projectId: selectedProject.id,
                defaultAgent: 'shell',
            });
            const settings = await runtime.handlers['settings.get']({});
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...settings.value,
                    'agents.providers': {
                        ...settings.value['agents.providers'],
                        codex: {
                            launch: { executable: '/bin/echo', args: ['--profile', 'remote'] },
                        },
                    },
                }),
            });

            const created = await runtime.handlers['mobile.session.createForPrincipal']({
                projectId: remoteProject.id,
                defaultAgent: 'codex',
                principal: pairedPrincipal([remoteProject.id]),
            });

            expect(created.sessionId).toBeTruthy();
            expect(created.terminalId).toBeTruthy();
            expect(
                Object.keys(created).toSorted((left, right) => left.localeCompare(right)),
            ).toEqual(['sessionId', 'terminalId']);
            expect(JSON.stringify(created)).not.toContain(directory);
            expect(JSON.stringify(created)).not.toContain('agentSessionId');
            const createdTerminal = (await runtime.handlers['app.bootstrap']({})).terminals.find(
                (terminal) => terminal.id === created.terminalId,
            );
            expect(createdTerminal).toMatchObject({ kind: 'codex', lastProcessState: 'running' });
            expect(start.mock.calls.at(-1)?.[0].agent).toMatchObject({
                executable: '/bin/echo',
                args: ['-c', 'tui.auto_recap=false', '--profile', 'remote'],
            });
            expect(spawn).toHaveBeenCalledTimes(2);
            expect((await runtime.handlers['app.bootstrap']({})).selectedSessionId).toBe(
                selected.session.id,
            );
            expect((await runtime.handlers['app.bootstrap']({})).selectedProjectId).toBe(
                selectedProject.id,
            );
            expect(events).toContainEqual({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'session.create' },
            });
        } finally {
            await runtime.close();
        }
    });

    it('returns the created Session with a clear launch error and preserves Desktop selection', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-create-failure-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const events: ServerEvent[] = [];
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => events.push(event),
            terminal: {
                resolveExecutable: (kind: TerminalKind) =>
                    kind === 'shell'
                        ? Promise.resolve('/bin/zsh')
                        : Promise.reject(
                              new CaxriError(
                                  'UNAVAILABLE',
                                  'Configured Agent executable was not found',
                              ),
                          ),
                spawn: () => createFakePty(),
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const selected = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const created = await runtime.handlers['mobile.session.createForPrincipal']({
                projectId: project.id,
                defaultAgent: 'codex',
                principal: pairedPrincipal([project.id]),
            });
            expect(created).toMatchObject({
                launchError: {
                    code: 'TERMINAL_START_FAILED',
                    message:
                        'Terminal failed to start. The Session was created; open it to review the error.',
                },
            });
            expect(
                Object.keys(created).toSorted((left, right) => left.localeCompare(right)),
            ).toEqual(['launchError', 'sessionId', 'terminalId']);
            const state = await runtime.handlers['app.bootstrap']({});
            expect(state.selectedSessionId).toBe(selected.session.id);
            expect(state.sessions).toHaveLength(2);
            expect(state.sessions.some((session) => session.id === created.sessionId)).toBe(true);
            expect(state.terminals.find((terminal) => terminal.kind === 'codex')).toMatchObject({
                lastProcessState: 'failed',
            });
            expect(events).toContainEqual({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'session.create' },
            });
        } finally {
            await runtime.close();
        }
    });
});
