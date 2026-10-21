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

/**
 * The error a handler rejects with, or `undefined` when it resolves, so a refusal's `details` can be matched.
 */
async function refusal(run: () => unknown): Promise<unknown> {
    try {
        await run();
    } catch (error) {
        return error;
    }
    return undefined;
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

    it('replaces a window Open Session on navigation and prunes a deleted Session from every window', async () => {
        const { project, runtime } = await createRuntime();
        try {
            const a = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: undefined,
            });
            const b = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: undefined,
            });
            const c = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });

            await runtime.handlers['session.select']({
                sessionId: a.session.id,
                windowKey: 'win-b',
            });
            await runtime.handlers['session.select']({
                sessionId: b.session.id,
                windowKey: 'win-b',
            });
            const shown = await runtime.handlers['app.bootstrap']({ windowKey: 'win-b' });
            expect(shown.openSessionIds).toEqual([b.session.id]);
            expect(shown.selectedSessionId).toBe(b.session.id);

            await runtime.handlers['session.delete']({
                sessionId: b.session.id,
                windowKey: 'win-b',
            });
            const state = await runtime.handlers['app.bootstrap']({ windowKey: 'win-b' });
            expect(state.openSessionIds).not.toContain(b.session.id);
            const other = await runtime.handlers['app.bootstrap']({ windowKey: 'win-a' });
            expect(other.openSessionIds).toEqual([c.session.id]);
        } finally {
            await runtime.close();
        }
    });

    it('creating a Session in a window replaces what the window shows', async () => {
        const { project, runtime } = await createRuntime();
        try {
            await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });
            const b = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'win-a',
            });
            const state = await runtime.handlers['app.bootstrap']({ windowKey: 'win-a' });
            expect(state.openSessionIds).toEqual([b.session.id]);
            expect(state).not.toHaveProperty('previewSessionId');
        } finally {
            await runtime.close();
        }
    });

    it('opens a Session in a new window and redirects selects of it to that window', async () => {
        const { project, runtime } = await createRuntime();
        try {
            const a = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'main',
            });
            const b = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
                windowKey: 'main',
            });

            const moved = await runtime.handlers['window.openSessions.moveToWindow']({
                sessionId: a.session.id,
                windowKey: 'main',
                targetWindowKey: 'win-tear',
            });
            expect(moved.target).toEqual({
                openSessionIds: [a.session.id],
                activeSessionId: a.session.id,
            });
            expect(moved.source).toEqual({
                openSessionIds: [b.session.id],
                activeSessionId: b.session.id,
            });
            expect(runtime.handlers['window.openSessions.listTearOffs']({})).toEqual([
                { windowKey: 'win-tear', ...moved.target },
            ]);

            const redirected = await runtime.handlers['session.select']({
                sessionId: a.session.id,
                windowKey: 'main',
            });
            expect(redirected.ownerWindowKey).toBe('win-tear');
            const main = await runtime.handlers['app.bootstrap']({ windowKey: 'main' });
            expect(main.openSessionIds).toEqual([b.session.id]);
            expect(main.selectedSessionId).toBe(b.session.id);

            const shownRefusal = await refusal(() =>
                runtime.handlers['window.openSessions.moveToWindow']({
                    sessionId: b.session.id,
                    windowKey: 'main',
                    targetWindowKey: 'win-other',
                }),
            );
            expect(shownRefusal).toMatchObject({ details: { reason: 'shown_session' } });
            const ownedRefusal = await refusal(() =>
                runtime.handlers['window.openSessions.moveToWindow']({
                    sessionId: a.session.id,
                    windowKey: 'main',
                    targetWindowKey: 'win-other',
                }),
            );
            expect(ownedRefusal).toMatchObject({ details: { reason: 'open_elsewhere' } });

            await runtime.handlers['window.openSessions.release']({ windowKey: 'win-tear' });
            const reselected = await runtime.handlers['session.select']({
                sessionId: a.session.id,
                windowKey: 'main',
            });
            expect(reselected.ownerWindowKey).toBeUndefined();
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
