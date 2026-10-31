import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    createAgentSignInProbe,
    parseClaudeAuthStatus,
    parseCodexLoginStatus,
} from '../sign-in-status';

describe('sign-in status parsing', () => {
    it('reads Claude Code from the loggedIn field whatever the exit code', () => {
        expect(
            parseClaudeAuthStatus({
                exitCode: 0,
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}',
            }),
        ).toBe('signedIn');
        expect(
            parseClaudeAuthStatus({
                exitCode: 1,
                stdout: '{"loggedIn":false,"authMethod":"none"}',
            }),
        ).toBe('signedOut');
        expect(parseClaudeAuthStatus({ exitCode: 1, stdout: 'error: unknown command' })).toBe(
            'unknown',
        );
        expect(parseClaudeAuthStatus({ exitCode: undefined, stdout: '' })).toBe('unknown');
    });

    it('reads Codex from its exit code and only trusts a failure that says it is not logged in', () => {
        expect(parseCodexLoginStatus({ exitCode: 0, stdout: 'Logged in using ChatGPT\n' })).toBe(
            'signedIn',
        );
        expect(parseCodexLoginStatus({ exitCode: 1, stdout: 'Not logged in\n' })).toBe('signedOut');
        expect(parseCodexLoginStatus({ exitCode: 1, stdout: 'error: unexpected argument' })).toBe(
            'unknown',
        );
        expect(parseCodexLoginStatus({ exitCode: undefined, stdout: '' })).toBe('unknown');
    });
});

describe('createAgentSignInProbe', () => {
    it('runs each provider status command once per cache window and skips providers without one', async () => {
        let time = 0;
        const run = vi.fn((_executable: string, arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[0] === 'auth'
                    ? { exitCode: 1, stdout: '{"loggedIn":false}' }
                    : { exitCode: 0, stdout: 'Logged in' },
            ),
        );
        const probe = createAgentSignInProbe({ isFakeAgents: () => false, now: () => time, run });

        await expect(probe.read('claude', '/bin/claude')).resolves.toBe('signedOut');
        await expect(probe.read('claude', '/bin/claude')).resolves.toBe('signedOut');
        await expect(probe.read('codex', '/bin/codex')).resolves.toBe('signedIn');
        await expect(probe.read('grok', '/bin/grok')).resolves.toBe('unknown');
        expect(run.mock.calls).toEqual([
            ['/bin/claude', ['auth', 'status', '--json']],
            ['/bin/codex', ['login', 'status']],
        ]);

        time = 30_000;
        await probe.read('claude', '/bin/claude');
        expect(run).toHaveBeenCalledTimes(3);
    });

    it('reads a fake Agent status from its marker file instead of running it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-sign-in-'));
        try {
            const run = vi.fn();
            const probe = createAgentSignInProbe({ isFakeAgents: () => true, run });
            const executable = join(directory, 'claude');
            await expect(probe.read('claude', executable)).resolves.toBe('unknown');
            await writeFile(`${executable}.sign-in`, 'signedOut\n');
            await expect(probe.read('claude', executable)).resolves.toBe('signedOut');
            expect(run).not.toHaveBeenCalled();
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});
