import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareAcceptanceAgentFixture } from '../agent-fixtures';

const directories: string[] = [];

async function runFixture(
    executable: string,
    arguments_: string[],
    environment: NodeJS.ProcessEnv,
    input: string,
): Promise<string> {
    const child = spawn(executable, arguments_, {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
    });
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    if (code !== 0) throw new Error(`Fixture exited with ${code}: ${stderr}`);
    return stdout;
}

async function readReceipts(root: string): Promise<Array<Record<string, unknown>>> {
    try {
        return (await readFile(join(root, 'acceptance-receipts.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

async function waitForReceiptCount(root: string, event: string, count: number): Promise<void> {
    await expect
        .poll(
            async () =>
                (await readReceipts(root)).filter((receipt) => receipt.event === event).length,
            { interval: 25, timeout: 3_000 },
        )
        .toBeGreaterThanOrEqual(count);
}

afterEach(async () => {
    const currentDirectories = [...directories];
    directories.length = 0;
    await Promise.all(
        currentDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('Acceptance Agent fixtures', () => {
    it('prepares one fixed fake-only fixture beneath the owned profile', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);

        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });

        expect(fixture.root.startsWith(`${userDataDirectory}/`)).toBe(true);
        expect(fixture.environment).toMatchObject({
            CAXRI_E2E_AGENT_HOOKS: '1',
            CAXRI_E2E_AGENT_MODE: 'fake',
            HOME: join(fixture.root, 'home'),
        });
        await Promise.all(
            Object.entries(fixture.executables).map(async ([provider, executable]) => {
                expect(executable.startsWith(`${fixture.root}/`)).toBe(true);
                expect((await stat(executable)).mode & 0o111).not.toBe(0);
                const result = await execFileAsync(executable, ['--version']);
                expect(String(result.stdout)).toBe(
                    provider === 'claude' ? '2.1.251 (Claude Code)\n' : 'codex-cli 0.151.0\n',
                );
            }),
        );
        await access(join(fixture.root, 'shell-bin', 'claude'));
        await expect(
            readFile(join(fixture.environment.CODEX_HOME!, 'config.toml'), 'utf8'),
        ).resolves.toBe('notify = ["/usr/bin/true"]\n');
    });

    it('emits Codex SessionStart once per fixture process and prompt hooks once per turn', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const codexRoot = fixture.environment.CODEX_HOME!;
        const hook = [{ hooks: [{ command: '/usr/bin/true' }] }];
        await writeFile(
            join(codexRoot, 'hooks.json'),
            JSON.stringify({
                hooks: {
                    PermissionRequest: hook,
                    SessionStart: hook,
                    Stop: hook,
                    UserPromptSubmit: hook,
                },
            }),
        );
        const child = spawn(fixture.executables.codex, [], {
            env: fixture.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdout.resume();
        child.stderr.resume();
        try {
            await waitForReceiptCount(codexRoot, 'Stop', 1);
            child.stdin.write('fixture:turn\n');
            await waitForReceiptCount(codexRoot, 'Stop', 2);
        } finally {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => child.once('close', () => resolve()));
        }

        const hookReceipts = (await readReceipts(codexRoot)).filter(({ kind }) => kind === 'hook');
        expect(hookReceipts.filter(({ event }) => event === 'SessionStart')).toHaveLength(1);
        expect(hookReceipts.filter(({ event }) => event === 'UserPromptSubmit')).toHaveLength(2);
        expect(hookReceipts.filter(({ event }) => event === 'Stop')).toHaveLength(2);
        expect(
            (await readReceipts(codexRoot)).filter(({ kind }) => kind === 'providerNativeTitle'),
        ).toHaveLength(2);
        const database = join(fixture.environment.CODEX_SQLITE_HOME!, 'state_9.sqlite');
        const nativeTitle = await execFileAsync('/usr/bin/sqlite3', [
            database,
            'SELECT name FROM threads LIMIT 1;',
        ]);
        expect(String(nativeTitle.stdout).trim()).toBe('Codex Resumed Naming');
    });

    it('exits cleanly on the fixed lifecycle command', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const child = spawn(fixture.executables.claude, [], {
            env: fixture.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.resume();

        await expect.poll(() => stdout).toContain('Fake claude Acceptance fixture ready');
        child.stdin.write('fixture:exit\n');
        await expect(
            new Promise<number | null>((resolve, reject) => {
                child.once('error', reject);
                child.once('close', resolve);
            }),
        ).resolves.toBe(0);
        expect(stdout).toContain('Fixture Agent exiting');
        await expect(readReceipts(fixture.environment.CLAUDE_CONFIG_DIR!)).resolves.toContainEqual(
            expect.objectContaining({ kind: 'fixtureExit' }),
        );
    });

    it('can expose unsent Terminal input through an explicit fixture receipt and echo', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const codexRoot = fixture.environment.CODEX_HOME!;
        await writeFile(join(codexRoot, 'acceptance-echo-terminal-input'), '');
        const child = spawn(fixture.executables.codex, [], {
            env: fixture.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.resume();
        try {
            await expect.poll(() => stdout).toContain('Fake codex Acceptance fixture ready');
            child.stdin.write('SYNTHETIC_SUMMARY_WITHOUT_SUBMIT');
            await expect.poll(() => stdout).toContain('SYNTHETIC_SUMMARY_WITHOUT_SUBMIT');
            await expect
                .poll(async () => readReceipts(codexRoot))
                .toContainEqual({
                    inputContainsPrivateMarker: false,
                    kind: 'terminalChunk',
                    length: 32,
                    provider: 'codex',
                });
        } finally {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => child.once('close', () => resolve()));
        }

        expect((await readReceipts(codexRoot)).some(({ kind }) => kind === 'terminalInput')).toBe(
            false,
        );
    });

    it('keeps multiline bracketed paste as unsent Agent input', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const codexRoot = fixture.environment.CODEX_HOME!;
        await writeFile(join(codexRoot, 'acceptance-echo-terminal-input'), '');
        const child = spawn(fixture.executables.codex, [], {
            env: fixture.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.resume();
        try {
            await expect.poll(() => stdout).toContain('\u{1B}[?2004h');
            child.stdin.write('\u{1B}[200~Summary:\n- Error E42\n- src/task.ts:17\u{1B}[201~');
            await expect
                .poll(() => stdout)
                .toContain('Summary:\r\n- Error E42\r\n- src/task.ts:17');
        } finally {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => child.once('close', () => resolve()));
        }

        expect((await readReceipts(codexRoot)).some(({ kind }) => kind === 'terminalInput')).toBe(
            false,
        );
        expect(stdout).not.toContain('\u{1B}[200~');
        expect(stdout).not.toContain('\u{1B}[201~');
    });

    it('waits for managed hooks before starting the initial fixture turn', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const codexRoot = fixture.environment.CODEX_HOME!;
        const child = spawn(fixture.executables.codex, [], {
            env: fixture.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.resume();
        try {
            await expect.poll(() => stdout).toContain('Fake codex Acceptance fixture ready');
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(await readReceipts(codexRoot)).not.toContainEqual(
                expect.objectContaining({ kind: 'fixtureError' }),
            );

            const hook = { hooks: [{ command: '/usr/bin/true' }] };
            await writeFile(
                join(codexRoot, 'hooks.json'),
                JSON.stringify({
                    hooks: { SessionStart: [hook], Stop: [hook], UserPromptSubmit: [hook] },
                }),
            );
            await expect
                .poll(
                    async () =>
                        (await readReceipts(codexRoot)).filter(({ kind }) => kind === 'hook')
                            .length,
                )
                .toBe(3);
            expect(await readReceipts(codexRoot)).not.toContainEqual(
                expect.objectContaining({ kind: 'fixtureError' }),
            );
        } finally {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => child.once('close', () => resolve()));
        }
    });

    it('rejects paths, arbitrary names, and host provider fixture requests', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);

        await Promise.all(
            ['../agent-features-v1', '/tmp/agent', 'real', 'claude'].map(async (fixtureId) =>
                expect(
                    prepareAcceptanceAgentFixture({
                        fixtureId,
                        userDataDir: userDataDirectory,
                    }),
                ).rejects.toThrow(`Unknown Acceptance Agent fixture: ${fixtureId}`),
            ),
        );
    });

    it('drives Claude naming and Codex paste summaries while rejecting a Codex naming call', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        await expect(
            runFixture(
                fixture.executables.claude,
                ['--print', '--model', 'haiku'],
                fixture.environment,
                'CAXRI_ACCEPTANCE_PRIVATE_CLAUDE',
            ),
        ).resolves.toBe('Claude Automatic Naming');
        await expect(
            runFixture(
                fixture.executables.codex,
                ['exec', '--skip-git-repo-check', '-'],
                fixture.environment,
                'CAXRI_ACCEPTANCE_PRIVATE_CODEX',
            ),
        ).rejects.toThrow('Fixture exited with 7');
        await expect(
            runFixture(
                fixture.executables.codex,
                ['exec', '--skip-git-repo-check', '-'],
                fixture.environment,
                'If the text is a log, build trace, test output, or diagnostic dump:\n\nCAXRI_ACCEPTANCE_PRIVATE_CODEX',
            ),
        ).resolves.toContain('Actual error: build failed with code E42');

        await expect(readReceipts(fixture.environment.CLAUDE_CONFIG_DIR!)).resolves.toContainEqual(
            expect.objectContaining({
                argumentContainsPrivateInput: false,
                inputContainsPrivateMarker: true,
                kind: 'generate',
            }),
        );
        await expect(readReceipts(fixture.environment.CODEX_HOME!)).resolves.toContainEqual(
            expect.objectContaining({ kind: 'unexpectedCodexTextGeneration' }),
        );
        await expect(readReceipts(fixture.environment.CODEX_HOME!)).resolves.toContainEqual(
            expect.objectContaining({
                argumentContainsPrivateInput: false,
                inputContainsPrivateMarker: true,
                kind: 'generate',
            }),
        );
    });
});
