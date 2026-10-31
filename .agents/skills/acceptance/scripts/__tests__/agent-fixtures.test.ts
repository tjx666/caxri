import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { setAcceptanceAgentFixtureProviderAvailability } from '../agent-fixture-availability';
import {
    getAgentFixtureStdout,
    observeAgentFixtureProcess,
    stopAgentFixtureProcess,
    waitForAgentFixtureExit,
    waitForAgentFixtureReady,
} from '../agent-fixture-process';
import {
    prepareAcceptanceAgentEnvironment,
    prepareAcceptanceAgentFixture,
} from '../agent-fixtures';

const directories: string[] = [];

function fixtureExecutable(
    fixture: { executables: Partial<Record<AgentProvider, string>> },
    provider: AgentProvider,
): string {
    const executable = fixture.executables[provider];
    expect(executable).toBeTypeOf('string');
    if (!executable) throw new Error(`Missing ${provider} fixture executable`);
    return executable;
}

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
    it('keeps hook health available in the owned profile while provider launches remain blocked', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const environment = await prepareAcceptanceAgentEnvironment({
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        expect(environment).toMatchObject({
            CAXRI_E2E_AGENT_HOOKS: '1',
            CAXRI_E2E_AGENT_MODE: 'blocked',
            HOME: join(userDataDirectory, 'acceptance-agents', 'home'),
            CLAUDE_CONFIG_DIR: join(userDataDirectory, 'acceptance-agents', 'claude'),
            CODEX_HOME: join(userDataDirectory, 'acceptance-agents', 'codex'),
        });
    });

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
                    provider === 'claude'
                        ? '2.1.251 (Claude Code)\n'
                        : provider === 'grok'
                          ? 'grok 1.0.24\n'
                          : 'codex-cli 0.151.0\n',
                );
            }),
        );
        await access(join(fixture.root, 'shell-bin', 'claude'));
        await expect(
            readFile(join(fixture.environment.CODEX_HOME!, 'config.toml'), 'utf8'),
        ).resolves.toBe('notify = ["/usr/bin/true"]\n');
    });

    it('keeps a closed provider availability transition across restart preparation', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const hostBin = join(userDataDirectory, 'host-bin');
        await mkdir(hostBin);
        await writeFile(join(hostBin, 'codex'), '#!/bin/sh\nexit 0\n');
        await chmod(join(hostBin, 'codex'), 0o700);
        const sourceEnvironment = { PATH: `${hostBin}:/usr/bin:/bin` };

        const first = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment,
            userDataDir: userDataDirectory,
        });
        expect(
            Object.keys(first.executables).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['claude', 'codex']);
        await setAcceptanceAgentFixtureProviderAvailability({
            available: false,
            fixtureId: 'agent-features-v1',
            provider: 'codex',
            userDataDir: userDataDirectory,
        });

        const second = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment,
            userDataDir: userDataDirectory,
        });
        expect(Object.keys(second.executables)).toEqual(['claude']);
        expect(second.environment.CAXRI_E2E_FAKE_CODEX_EXECUTABLE).toBeUndefined();
        const blocked = spawn('/bin/zsh', ['-lc', 'codex --version'], {
            env: second.environment,
            stdio: 'ignore',
        });
        await expect(
            new Promise<number | null>((resolve, reject) => {
                blocked.once('error', reject);
                blocked.once('close', resolve);
            }),
        ).resolves.toBe(127);

        await setAcceptanceAgentFixtureProviderAvailability({
            available: true,
            fixtureId: 'agent-features-v1',
            provider: 'codex',
            userDataDir: userDataDirectory,
        });
        const restored = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment,
            userDataDir: userDataDirectory,
        });
        expect(
            Object.keys(restored.executables).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['claude', 'codex']);
    });

    it('rejects untrusted provider availability state and update inputs', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const root = join(userDataDirectory, 'acceptance-agents');
        await mkdir(root);
        const state = join(root, 'provider-availability.json');
        await writeFile(
            state,
            JSON.stringify({
                executable: '/tmp/untrusted',
                fixtureId: 'agent-features-v1',
                schemaVersion: 1,
                unavailableProviders: ['codex'],
            }),
        );
        await expect(
            prepareAcceptanceAgentFixture({
                fixtureId: 'agent-features-v1',
                userDataDir: userDataDirectory,
            }),
        ).rejects.toThrow();
        await rm(state);
        await symlink(join(root, 'missing-target'), state);
        await expect(
            prepareAcceptanceAgentFixture({
                fixtureId: 'agent-features-v1',
                userDataDir: userDataDirectory,
            }),
        ).rejects.toThrow('direct regular file');
        await expect(
            setAcceptanceAgentFixtureProviderAvailability({
                available: false,
                fixtureId: 'unknown',
                provider: 'codex',
                userDataDir: userDataDirectory,
            }),
        ).rejects.toThrow();
        await expect(
            setAcceptanceAgentFixtureProviderAvailability({
                available: false,
                fixtureId: 'agent-features-v1',
                provider: 'claude',
                userDataDir: userDataDirectory,
            }),
        ).rejects.toThrow();
        await expect(
            setAcceptanceAgentFixtureProviderAvailability({
                available: false,
                executable: '/tmp/untrusted',
                fixtureId: 'agent-features-v1',
                provider: 'codex',
                userDataDir: userDataDirectory,
            } as Parameters<typeof setAcceptanceAgentFixtureProviderAvailability>[0]),
        ).rejects.toThrow();
    });

    it('completes the initial Claude turn with its provider hooks and no SessionStart binding', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const claudeRoot = fixture.environment.CLAUDE_CONFIG_DIR!;
        const hook = [{ hooks: [{ command: '/usr/bin/true' }] }];
        await writeFile(
            join(claudeRoot, 'settings.json'),
            JSON.stringify({
                hooks: { UserPromptSubmit: hook, Stop: hook },
            }),
        );
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'claude'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake claude Acceptance fixture ready');
            await waitForReceiptCount(claudeRoot, 'Stop', 1);
            const receipts = await readReceipts(claudeRoot);
            expect(receipts.filter(({ event }) => event === 'UserPromptSubmit')).toHaveLength(1);
            expect(receipts.filter(({ event }) => event === 'SessionStart')).toHaveLength(0);
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
        }
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
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'codex'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake codex Acceptance fixture ready');
            await waitForReceiptCount(codexRoot, 'Stop', 1);
            fixtureProcess.child.stdin?.write('fixture:turn\n');
            await waitForReceiptCount(codexRoot, 'Stop', 2);
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
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
        expect(String(nativeTitle.stdout).trim()).toBe('Codex Renewed Title');
    });

    it('exits cleanly on the fixed lifecycle command', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'claude'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );

        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake claude Acceptance fixture ready');
            fixtureProcess.child.stdin?.write('fixture:exit\n');
            await expect(waitForAgentFixtureExit(fixtureProcess)).resolves.toMatchObject({
                exitCode: 0,
                signal: null,
            });
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
        }
        const stdout = getAgentFixtureStdout(fixtureProcess);
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
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'codex'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake codex Acceptance fixture ready');
            fixtureProcess.child.stdin?.write('SYNTHETIC_SUMMARY_WITHOUT_SUBMIT');
            await expect
                .poll(() => getAgentFixtureStdout(fixtureProcess))
                .toContain('SYNTHETIC_SUMMARY_WITHOUT_SUBMIT');
            await expect
                .poll(async () => readReceipts(codexRoot))
                .toContainEqual({
                    inputContainsPrivateMarker: false,
                    kind: 'terminalChunk',
                    length: 32,
                    provider: 'codex',
                });
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
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
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'codex'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, '\u{1B}[?2004h');
            fixtureProcess.child.stdin?.write(
                '\u{1B}[200~Summary:\n- Error E42\n- src/task.ts:17\u{1B}[201~',
            );
            await expect
                .poll(() => getAgentFixtureStdout(fixtureProcess))
                .toContain('Summary:\r\n- Error E42\r\n- src/task.ts:17');
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
        }

        const stdout = getAgentFixtureStdout(fixtureProcess);
        expect((await readReceipts(codexRoot)).some(({ kind }) => kind === 'terminalInput')).toBe(
            false,
        );
        expect(stdout).not.toContain('\u{1B}[200~');
        expect(stdout).not.toContain('\u{1B}[201~');
    });

    it('confirms a public-frame Agent received an existing image path without recording it', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            isPublicFrame: true,
            userDataDir: userDataDirectory,
        });
        const claudeRoot = fixture.environment.CLAUDE_CONFIG_DIR!;
        const imagePath = join(claudeRoot, 'image_0123456789abcdef0123456789abcdef.jpg');
        await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff]));
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'claude'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            fixtureProcess.child.stdin?.write(
                `\u{1B}[200~Review image\n\nAttached image paths:\n${imagePath}\u{1B}[201~\r`,
            );
            await expect
                .poll(() => readReceipts(claudeRoot), { timeout: 10_000 })
                .toContainEqual(
                    expect.objectContaining({
                        kind: 'imageAttachmentReceived',
                        pathValid: true,
                        exists: true,
                    }),
                );
            expect(JSON.stringify(await readReceipts(claudeRoot))).not.toContain(imagePath);
            expect(getAgentFixtureStdout(fixtureProcess)).toBe('');
        } finally {
            await stopAgentFixtureProcess(fixtureProcess);
        }
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
        const fixtureProcess = observeAgentFixtureProcess(
            spawn(fixtureExecutable(fixture, 'codex'), [], {
                env: fixture.environment,
                stdio: ['pipe', 'pipe', 'pipe'],
            }),
        );
        try {
            await waitForAgentFixtureReady(fixtureProcess, 'Fake codex Acceptance fixture ready');
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
            await stopAgentFixtureProcess(fixtureProcess);
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

    it('supports the product title-generation invocation for both providers', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const instructions = 'Generate a concise coding-session title from the conversation below.';
        const conversation =
            '<user>CAXRI_ACCEPTANCE_PRIVATE_CLAUDE CAXRI_ACCEPTANCE_PRIVATE_CODEX</user>';
        await expect(
            runFixture(
                fixtureExecutable(fixture, 'claude'),
                ['--print', '--model', 'haiku', '--system-prompt', instructions],
                fixture.environment,
                conversation,
            ),
        ).resolves.toBe('Repair Session Naming');
        await expect(
            runFixture(
                fixtureExecutable(fixture, 'codex'),
                ['exec', '--skip-git-repo-check', '-'],
                fixture.environment,
                `${instructions}\n\n${conversation}`,
            ),
        ).resolves.toContain('Repair Session Naming');
        const receipts = await Promise.all(
            [fixture.environment.CLAUDE_CONFIG_DIR!, fixture.environment.CODEX_HOME!].map(
                readReceipts,
            ),
        );
        for (const records of receipts) {
            expect(records).toContainEqual(
                expect.objectContaining({
                    kind: 'generate',
                    argumentContainsPrivateInput: false,
                    inputContainsPrivateMarker: true,
                }),
            );
        }
    });

    it('drives session auto-naming for both providers and rejects unrecognized text generation', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-agent-fixture-'));
        directories.push(userDataDirectory);
        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-features-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });
        const titleInstructions =
            'Generate a concise coding-session title from the conversation below.';
        await expect(
            runFixture(
                fixtureExecutable(fixture, 'claude'),
                ['--print', '--model', 'haiku'],
                fixture.environment,
                'CAXRI_ACCEPTANCE_PRIVATE_CLAUDE',
            ),
        ).rejects.toThrow('Fixture exited with 7');
        await expect(
            runFixture(
                fixtureExecutable(fixture, 'claude'),
                ['--print', '--model', 'haiku', '--system-prompt', titleInstructions],
                fixture.environment,
                'CAXRI_ACCEPTANCE_PRIVATE_CLAUDE',
            ),
        ).resolves.toContain('Repair Session Naming');
        await expect(
            runFixture(
                fixtureExecutable(fixture, 'codex'),
                ['exec', '--skip-git-repo-check', '-'],
                fixture.environment,
                'CAXRI_ACCEPTANCE_PRIVATE_CODEX',
            ),
        ).rejects.toThrow('Fixture exited with 7');
        await expect(
            runFixture(
                fixtureExecutable(fixture, 'codex'),
                ['exec', '--skip-git-repo-check', '-'],
                fixture.environment,
                `${titleInstructions}\n\nCAXRI_ACCEPTANCE_PRIVATE_CODEX`,
            ),
        ).resolves.toContain('Repair Session Naming');

        await expect(readReceipts(fixture.environment.CLAUDE_CONFIG_DIR!)).resolves.toContainEqual(
            expect.objectContaining({ kind: 'unexpectedTextGeneration', provider: 'claude' }),
        );
        await expect(readReceipts(fixture.environment.CLAUDE_CONFIG_DIR!)).resolves.toContainEqual(
            expect.objectContaining({
                argumentContainsPrivateInput: false,
                inputContainsPrivateMarker: true,
                kind: 'generate',
            }),
        );
        await expect(readReceipts(fixture.environment.CODEX_HOME!)).resolves.toContainEqual(
            expect.objectContaining({ kind: 'unexpectedTextGeneration', provider: 'codex' }),
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
