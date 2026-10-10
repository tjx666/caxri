import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { TerminalKind } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
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
});

it('keeps a detached Chat off its Agent Session across reads until the Session resumes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-detach-chat-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    const stateDirectory = join(directory, 'codex-state');
    await mkdir(projectRoot);
    // Server Core spawns the resolved executable directly, so the fake app-server sits behind a launcher script.
    const launcher = join(directory, 'codex');
    await writeFile(
        launcher,
        `#!/bin/sh\nFAKE_CODEX_STATE_DIR='${stateDirectory}' exec '${process.execPath}' '${FAKE_APP_SERVER}' "$@"\n`,
    );
    await chmod(launcher, 0o755);
    const domains = await createTestDomainServices({
        agentEnvironment: { homeDirectory: join(directory, 'home'), variables: {} },
        userDataPath: join(directory, 'user-data'),
        logger: new StructuredLogger(join(directory, 'logs')),
        send: () => {},
        terminal: {
            resolveExecutable: (kind: TerminalKind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : launcher),
            spawn: () => createFakePty(),
        },
    });
    const threadOpens = async () =>
        (await readFile(join(stateDirectory, 'thread-opens.jsonl'), 'utf8')).trim().split('\n')
            .length;

    try {
        const project = await domains.handlers['project.create']({ rootPath: projectRoot });
        const created = await domains.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'codex',
            surface: 'chat',
        });
        const terminalId = created.terminal!.id;
        const record = async () =>
            (await domains.handlers['app.bootstrap']({})).terminals.find(
                (terminal) => terminal.id === terminalId,
            );
        const read = () => domains.handlers['agentChat.read']({ terminalId });
        await vi.waitFor(async () => expect((await read()).status).toBe('ready'), {
            timeout: 5_000,
        });
        expect(await threadOpens()).toBe(1);

        await domains.handlers['session.detach']({ sessionId: created.session.id });
        expect(await record()).toMatchObject({
            lastProcessState: 'detached',
            lastAgentProcessState: 'detached',
        });
        expect((await domains.handlers['app.health']({})).activePtyCount).toBe(0);

        // A pane remount reads again; it must not take the thread back from the other client.
        expect((await read()).status).toBe('stopped');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await read()).status).toBe('stopped');
        expect(await threadOpens()).toBe(1);
        expect((await record())?.lastProcessState).toBe('detached');

        await domains.handlers['session.resume']({ sessionId: created.session.id });
        expect((await record())?.lastProcessState).not.toBe('detached');
        // Resume relaunches the thread like a detached PTY Agent, so a pane or phone that read the Chat while it was
        // detached receives the replay as patches instead of waiting on a read nothing triggers.
        await vi.waitFor(async () => expect(await threadOpens()).toBe(2), { timeout: 5_000 });
        await vi.waitFor(async () => expect((await read()).status).toBe('ready'), {
            timeout: 5_000,
        });
        expect(await threadOpens()).toBe(2);
        expect((await record())?.lastProcessState).toBe('running');
    } finally {
        await domains.close();
    }
});
