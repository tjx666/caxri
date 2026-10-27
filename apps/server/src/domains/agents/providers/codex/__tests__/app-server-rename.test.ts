import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentProviderSessionRenameContext } from '../../../contract';
import { renameCodexSession } from '../app-server-rename';

const temporaryDirectories: string[] = [];

interface CodexAppServerFixture {
    context: AgentProviderSessionRenameContext;
    lifecyclePath: string;
    messagesPath: string;
}

async function createCodexAppServerFixture(
    response: 'error' | 'ignore-term' | 'success' = 'success',
): Promise<CodexAppServerFixture> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-app-server-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'codex.cjs');
    const lifecyclePath = join(directory, 'lifecycle.log');
    const messagesPath = join(directory, 'messages.jsonl');
    const renameResponse =
        response !== 'error'
            ? { id: 2, result: {} }
            : { id: 2, error: { code: -32_603, message: 'rename failed' } };
    await writeFile(
        executable,
        String.raw`#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const ignoreTerm = ${JSON.stringify(response === 'ignore-term')};
const lifecyclePath = ${JSON.stringify(lifecyclePath)};
const messagesPath = ${JSON.stringify(messagesPath)};
if (process.argv[2] !== 'app-server' || process.argv[3] !== '--stdio') {
    process.exit(2);
}
writeFileSync(lifecyclePath, 'pid:' + process.pid + '\n', 'utf8');
if (ignoreTerm) {
    process.on('SIGTERM', () => appendFileSync(lifecyclePath, 'signal:SIGTERM\n', 'utf8'));
    setInterval(() => {}, 60_000);
}

createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    appendFileSync(messagesPath, JSON.stringify(message) + '\n', 'utf8');
    if (message.id === 1) {
        process.stdout.write('{"method":"server/notice","params":{}}\n');
        process.stdout.write('{"id":1,"res');
        setTimeout(() => process.stdout.write('ult":{}}\n'), 5);
        return;
    }
    if (message.id === 2) {
        process.stdout.write('{"method":"thread/status/changed","params":{}}\n');
        process.stdout.write('{"id":2,');
        setTimeout(
            () => process.stdout.write(${JSON.stringify(JSON.stringify(renameResponse).slice('{"id":2,'.length))} + '\n'),
            5,
        );
    }
});
`,
        'utf8',
    );
    await chmod(executable, 0o700);
    return {
        context: {
            agentSessionId: 'thread-123',
            cwd: directory,
            title: 'Native Codex title',
            environment: { homeDirectory: directory, variables: {} },
            executable,
            version: 'codex-cli 0.110.0',
        },
        lifecyclePath,
        messagesPath,
    };
}

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('renameCodexSession', () => {
    it('renames a thread through the app-server protocol and ignores fragmented notifications', async () => {
        const fixture = await createCodexAppServerFixture();

        await expect(renameCodexSession(fixture.context)).resolves.toEqual({
            title: 'Native Codex title',
        });

        const messages = (await readFile(fixture.messagesPath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown);
        expect(messages).toEqual([
            {
                id: 1,
                method: 'initialize',
                params: {
                    clientInfo: { name: 'caxri', title: 'Caxri', version: '1.0.0' },
                },
            },
            { method: 'initialized' },
            {
                id: 2,
                method: 'thread/name/set',
                params: { name: 'Native Codex title', threadId: 'thread-123' },
            },
        ]);
    });

    it.each(['codex-cli 0.109.0', 'codex-cli 1.0.0'])(
        'rejects Codex version %s outside app-server thread naming support',
        async (version) => {
            await expect(
                renameCodexSession({
                    agentSessionId: 'thread-123',
                    cwd: '/unused',
                    title: 'Native Codex title',
                    environment: { homeDirectory: '/unused', variables: {} },
                    executable: '/must-not-run',
                    version,
                }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        },
    );

    it('maps an app-server error response to an unavailable rename and keeps its own error.message', async () => {
        const fixture = await createCodexAppServerFixture('error');

        // Issue #1345: the app-server's own JSON-RPC error.message ("rename failed", from the fixture's `error`
        // response) must reach the thrown error instead of being discarded behind the generic "rejected the Session
        // rename" wording: otherwise a signed-out or rate-limited Codex looks identical to every other failure.
        await expect(renameCodexSession(fixture.context)).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            message: expect.stringContaining('rename failed') as string,
        });
    });

    it('force-terminates and reaps an app-server that ignores SIGTERM before resolving', async () => {
        const fixture = await createCodexAppServerFixture('ignore-term');

        await expect(renameCodexSession(fixture.context)).resolves.toEqual({
            title: 'Native Codex title',
        });

        const lifecycle = await readFile(fixture.lifecyclePath, 'utf8');
        const pid = Number(lifecycle.match(/^pid:(\d+)$/mu)?.[1]);
        expect(lifecycle).toContain('signal:SIGTERM');
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
    });
});
