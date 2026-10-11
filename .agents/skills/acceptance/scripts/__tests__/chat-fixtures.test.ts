import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareAcceptanceAgentFixture } from '../agent-fixtures';
import { chatFixtureSource } from '../chat-fixtures';

const directories: string[] = [];

afterEach(async () => {
    const owned = [...directories];
    directories.length = 0;
    await Promise.all(owned.map((directory) => rm(directory, { force: true, recursive: true })));
});

async function runUntilClosed(
    executable: string,
    environment: NodeJS.ProcessEnv,
    input: string,
): Promise<string> {
    const child = spawn(executable, [], { env: environment, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stdin.end(input);
    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    return stdout;
}

describe('agent-chat-v1 fixture', () => {
    it('backs Claude Code and Codex with the Agent Chat protocol fakes beneath the owned profile', async () => {
        const userDataDirectory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-chat-fixture-'));
        directories.push(userDataDirectory);

        const fixture = await prepareAcceptanceAgentFixture({
            fixtureId: 'agent-chat-v1',
            sourceEnvironment: { PATH: '/usr/bin:/bin' },
            userDataDir: userDataDirectory,
        });

        expect(
            Object.keys(fixture.executables).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['claude', 'codex']);
        expect(fixture.environment.CAXRI_E2E_AGENT_MODE).toBe('fake');
        const codex = fixture.executables.codex!;
        expect(String((await execFileAsync(codex, ['--version'])).stdout)).toBe(
            'codex-cli 0.162.0\n',
        );
        expect(await readFile(codex, 'utf8')).toContain(
            JSON.stringify(join(fixture.root, 'codex-threads')),
        );
        // One stream-json turn proves the Claude target speaks the Chat protocol, not the PTY fixture. Closing stdin
        // ends the fake mid-reply, so assert its init frame rather than the full text.
        const claudeOutput = await runUntilClosed(
            fixture.executables.claude!,
            fixture.environment,
            `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`,
        );
        expect(claudeOutput).toContain('"subtype":"init","cwd"');
        expect(claudeOutput).toContain('"model":"fake-claude-model"');
    });

    it('has no target for a provider the fixture does not declare', () => {
        expect(() => chatFixtureSource('grok', '/tmp/fixture')).toThrow(
            'The agent-chat-v1 fixture has no grok target',
        );
    });
});
