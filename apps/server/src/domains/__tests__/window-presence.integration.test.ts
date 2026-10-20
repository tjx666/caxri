import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { runWithRequestOrigin } from '../window-presence';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function createRuntime() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-window-presence-'));
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
    const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
    return { project, runtime };
}

describe('per-window Open Sessions', () => {
    it('bootstraps each window with its own selection and Open Sessions', async () => {
        const { project, runtime } = await createRuntime();
        try {
            const a = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });
            const b = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-b',
            });

            const first = await runtime.handlers['app.bootstrap']({ windowKey: 'win-a' });
            const second = await runtime.handlers['app.bootstrap']({ windowKey: 'win-b' });
            const fresh = await runtime.handlers['app.bootstrap']({ windowKey: 'win-new' });

            expect(first).toMatchObject({
                selectedSessionId: a.session.id,
                openSessionIds: [a.session.id],
            });
            expect(second).toMatchObject({
                selectedSessionId: b.session.id,
                openSessionIds: [b.session.id],
            });
            expect(fresh.openSessionIds ?? []).toEqual([]);
        } finally {
            await runtime.close();
        }
    });

    it('edits a strip, drops unknown Sessions, and prunes a deleted Session from every window', async () => {
        const { project, runtime } = await createRuntime();
        try {
            const a = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });
            const b = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });

            const stored = await runtime.handlers['window.openSessions.set']({
                windowKey: 'win-b',
                openSessionIds: [b.session.id, 'unknown', a.session.id],
            });
            expect(stored).toEqual({
                openSessionIds: [b.session.id, a.session.id],
                activeSessionId: b.session.id,
            });

            await runtime.handlers['session.delete']({
                sessionId: a.session.id,
                windowKey: 'win-b',
            });
            const state = await runtime.handlers['app.bootstrap']({ windowKey: 'win-b' });
            expect(state.openSessionIds).toEqual([b.session.id]);
            expect(state.selectedSessionId).toBe(b.session.id);
            const other = await runtime.handlers['app.bootstrap']({ windowKey: 'win-a' });
            expect(other.openSessionIds).toEqual([b.session.id]);
        } finally {
            await runtime.close();
        }
    });
});

describe('requests without a window', () => {
    it('create touches no strip, and a window-less bootstrap shows no selection', async () => {
        const { project, runtime } = await createRuntime();
        try {
            // The test composition root tags requests with a window; naming `undefined` acts as a CLI client would.
            await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: undefined,
            });

            const anonymous = await runtime.handlers['app.bootstrap']({ windowKey: undefined });
            const main = await runtime.handlers['app.bootstrap']({ windowKey: 'main' });
            expect(anonymous.selectedSessionId).toBeUndefined();
            expect(anonymous.openSessionIds ?? []).toEqual([]);
            expect(main.openSessionIds ?? []).toEqual([]);
        } finally {
            await runtime.close();
        }
    });

    it('rejects a strip edit that names no window', async () => {
        const { runtime } = await createRuntime();
        try {
            expect(() =>
                runtime.handlers['window.openSessions.set']({
                    windowKey: undefined,
                    openSessionIds: [],
                }),
            ).toThrow('requires a window');
        } finally {
            await runtime.close();
        }
    });
});

describe('window presence seed', () => {
    it('replaces the rows of the calling connection at once', async () => {
        const { project, runtime } = await createRuntime();
        try {
            const a = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });
            await runWithRequestOrigin('conn-1', async () => {
                await runtime.handlers['window.seedPresence']({
                    windows: [
                        {
                            windowKey: 'win-a',
                            viewingSessionId: a.session.id,
                            focused: true,
                            visible: true,
                            focusedAt: 7,
                        },
                    ],
                });
            });
            const context = await runtime.handlers['app.activeContext']({});
            expect(context.sessionId).toBe(a.session.id);
        } finally {
            await runtime.close();
        }
    });
});

describe('window presence', () => {
    it('reports the focused window Session as active context and forgets a closed connection', async () => {
        const { project, runtime } = await createRuntime();
        try {
            const a = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });
            const b = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-b',
            });

            await runWithRequestOrigin('conn-1', async () => {
                await runtime.handlers['window.reportPresence']({
                    windowKey: 'win-a',
                    viewingSessionId: a.session.id,
                    focused: false,
                    visible: true,
                });
                await runtime.handlers['window.reportPresence']({
                    windowKey: 'win-b',
                    viewingSessionId: b.session.id,
                    focused: true,
                    visible: true,
                });
            });
            expect(runtime.handlers['app.activeContext']({})).toMatchObject({
                sessionId: b.session.id,
            });

            runtime.onConnectionClosed?.('conn-1');
            await runWithRequestOrigin('conn-2', () =>
                runtime.handlers['window.reportPresence']({
                    windowKey: 'win-a',
                    viewingSessionId: a.session.id,
                    focused: true,
                    visible: true,
                }),
            );
            expect(runtime.handlers['app.activeContext']({})).toMatchObject({
                sessionId: a.session.id,
            });
        } finally {
            await runtime.close();
        }
    });
});
