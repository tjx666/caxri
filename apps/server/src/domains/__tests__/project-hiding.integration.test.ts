import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { ServerEvent, TerminalKind } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { GitService } from '../git';
import { createFakePty } from './create-test-domain-services';

const FAKE_APP_SERVER = join(
    import.meta.dirname,
    '..',
    'agent-chat',
    '__tests__',
    'fixtures',
    'fake-codex-app-server.ts',
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

it('hides a Project from bootstrap and restores its Sessions when the root is added again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-project-hide-'));
    temporaryDirectories.push(directory);
    const keeperRoot = join(directory, 'keeper');
    const hiddenRoot = join(directory, 'hidden');
    await Promise.all([mkdir(keeperRoot), mkdir(hiddenRoot)]);
    const events: ServerEvent[] = [];
    const evict = vi.spyOn(GitService.prototype, 'evictSessions');
    const runtime = await createTestDomainServices({
        userDataPath: join(directory, 'user-data'),
        logger: new StructuredLogger(join(directory, 'logs')),
        send: (event) => events.push(event),
        terminal: { spawn: () => createFakePty() },
    });

    try {
        const keeper = await runtime.handlers['project.create']({ rootPath: keeperRoot });
        await runtime.handlers['session.create']({ projectId: keeper.id, defaultAgent: 'shell' });
        const project = await runtime.handlers['project.create']({ rootPath: hiddenRoot });
        const created = await runtime.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });

        expect(await runtime.handlers['project.restorable']({ rootPath: hiddenRoot })).toBe(false);
        const hidden = await runtime.handlers['project.hide']({ projectId: project.id });
        expect(await runtime.handlers['project.restorable']({ rootPath: hiddenRoot })).toBe(true);
        expect(
            await runtime.handlers['project.restorable']({ rootPath: join(directory, 'missing') }),
        ).toBe(false);

        expect(hidden.projects.map(({ id }) => id)).toEqual([keeper.id]);
        expect(hidden.sessions.some(({ projectId }) => projectId === project.id)).toBe(false);
        expect(hidden.terminals.some(({ sessionId }) => sessionId === created.session.id)).toBe(
            false,
        );
        expect(hidden.sessionStates.some(({ sessionId }) => sessionId === created.session.id)).toBe(
            false,
        );
        expect(hidden.selectedProjectId).toBe(keeper.id);
        expect(evict).toHaveBeenCalledWith([created.session.id]);
        expect(events).toContainEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.hide' },
        });
        expect((await runtime.handlers['project.list']({})).projects.map(({ id }) => id)).toEqual([
            keeper.id,
        ]);

        const restored = await runtime.handlers['project.create']({ rootPath: hiddenRoot });

        expect(restored.id).toBe(project.id);
        expect(await runtime.handlers['project.restorable']({ rootPath: hiddenRoot })).toBe(false);
        const bootstrap = await runtime.handlers['app.bootstrap']({});
        expect(bootstrap.sessions.map(({ id }) => id)).toContain(created.session.id);
        expect(bootstrap.terminals.map(({ id }) => id)).toContain(created.terminal!.id);
    } finally {
        await runtime.close();
    }
});

it("stops a hidden Project's live Chats the way archiving their Session does", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-project-hide-chat-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    // Server Core spawns the resolved executable directly, so the fake app-server sits behind a launcher script.
    const launcher = join(directory, 'codex');
    const stateDirectory = join(directory, 'codex-state');
    await writeFile(
        launcher,
        `#!/bin/sh\nFAKE_CODEX_STATE_DIR='${stateDirectory}' exec '${process.execPath}' '${FAKE_APP_SERVER}' "$@"\n`,
    );
    await chmod(launcher, 0o755);
    const userDataPath = join(directory, 'user-data');
    const runtime = await createTestDomainServices({
        agentEnvironment: { homeDirectory: join(directory, 'home'), variables: {} },
        userDataPath,
        logger: new StructuredLogger(join(directory, 'logs')),
        send: () => {},
        terminal: {
            resolveExecutable: (kind: TerminalKind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : launcher),
            spawn: () => createFakePty(),
        },
    });

    try {
        const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
        const created = await runtime.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'codex',
            surface: 'chat',
        });
        const terminalId = created.terminal!.id;
        await vi.waitFor(
            async () =>
                expect((await runtime.handlers['agentChat.read']({ terminalId })).status).toBe(
                    'ready',
                ),
            { timeout: 5_000 },
        );
        expect(await runtime.handlers['terminal.runningCount']({})).toEqual({
            terminals: 0,
            chats: 1,
        });

        await runtime.handlers['project.hide']({ projectId: project.id });

        // The close prompt and Server Core's idle-exit check both read this count.
        expect(await runtime.handlers['terminal.runningCount']({})).toEqual({
            terminals: 0,
            chats: 0,
        });
        // Hidden Sessions leave bootstrap, so read the durable record directly; a read handler would relaunch it.
        const direct = new Database(join(userDataPath, 'caxri.db'), { readonly: true });
        try {
            expect(
                direct
                    .prepare('SELECT last_process_state AS state FROM terminals WHERE id = ?')
                    .get(terminalId),
            ).toEqual({ state: 'stopped' });
        } finally {
            direct.close();
        }
    } finally {
        await runtime.close();
    }
});
