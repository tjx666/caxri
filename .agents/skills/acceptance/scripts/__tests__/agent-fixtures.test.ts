import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
                expect(String(result.stdout)).toContain(
                    provider === 'claude' ? 'Claude Code' : 'codex-cli',
                );
            }),
        );
        await access(join(fixture.root, 'shell-bin', 'claude'));
        await expect(
            readFile(join(fixture.environment.CODEX_HOME!, 'config.toml'), 'utf8'),
        ).resolves.toBe('notify = ["/usr/bin/true"]\n');
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

    it('drives both provider naming boundaries without putting private context in argv', async () => {
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
        ).resolves.toBe('🧭 Claude automatic naming');
        await expect(
            runFixture(
                fixture.executables.codex,
                ['exec', '--skip-git-repo-check', '-'],
                fixture.environment,
                'CAXRI_ACCEPTANCE_PRIVATE_CODEX',
            ),
        ).resolves.toContain('🧭 Codex automatic naming');

        await Promise.all(
            [fixture.environment.CLAUDE_CONFIG_DIR!, fixture.environment.CODEX_HOME!].map(
                async (root) => {
                    const receipts = (
                        await readFile(join(root, 'acceptance-receipts.jsonl'), 'utf8')
                    )
                        .trim()
                        .split('\n')
                        .map((line) => JSON.parse(line) as Record<string, unknown>);
                    expect(receipts).toContainEqual(
                        expect.objectContaining({
                            argumentContainsPrivateInput: false,
                            inputContainsPrivateMarker: true,
                            kind: 'generate',
                        }),
                    );
                },
            ),
        );
    });
});
