import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { agentCommandEnvironment, throwAgentRenameError } from '../rename';

function thrown(function_: () => never): unknown {
    try {
        function_();
    } catch (error) {
        return error;
    }
    throw new Error('expected throwAgentRenameError to throw');
}

vi.mock('../../executables', () => ({
    serverProcessEnvironment: (variables: NodeJS.ProcessEnv = {}) =>
        Promise.resolve({ ...variables, PATH: '/login/bin' }),
}));

describe('agentCommandEnvironment', () => {
    it('launches a provider CLI on the login PATH, not the PATH the Server was started with', async () => {
        const environment = await agentCommandEnvironment({
            homeDirectory: '/agent-home',
            variables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: '/agent-home/.codex' },
        });

        expect(environment).toMatchObject({
            CODEX_HOME: '/agent-home/.codex',
            HOME: '/agent-home',
            PATH: '/login/bin',
        });
    });
});

describe('throwAgentRenameError', () => {
    /**
     * Issue #1345: the fallback branch used to discard `execFileAsync`'s rejected-error `stderr` entirely, so a
     * signed-out or rate-limited CLI always surfaced the same generic "could not rename the Agent session", no more
     * actionable than a crash. `promisify(execFile)` attaches `stderr` to the rejected `Error` per Node's documented
     * special case; this regression proves that text now reaches the thrown `CaxriError`.
     */
    it('keeps the CLI stderr instead of discarding it behind the generic fallback message', () => {
        const error = new Error('Command failed: claude --resume …') as Error & { stderr: string };
        error.stderr = 'Error: Not logged in. Run `claude login` to authenticate.';

        expect(thrown(() => throwAgentRenameError('claude', error))).toMatchObject({
            code: 'UNAVAILABLE',
            message:
                'Claude could not rename the Agent session: Error: Not logged in. Run `claude login` to authenticate.',
        });
    });

    it('falls back to error.message when the rejected error carries no stderr', () => {
        const error = new Error('spawn claude ENOENT');

        expect(thrown(() => throwAgentRenameError('claude', error))).toMatchObject({
            code: 'UNAVAILABLE',
            message: 'Claude could not rename the Agent session: spawn claude ENOENT',
        });
    });

    it('stays generic when the error carries neither stderr nor a message', () => {
        // A whitespace-only message is the narrowest way to reach the "no usable detail" branch: `unicorn/error-message`
        // forbids constructing `Error` with a literal empty string.
        const error = new Error(' '.repeat(3));

        expect(thrown(() => throwAgentRenameError('claude', error))).toMatchObject({
            code: 'UNAVAILABLE',
            message: 'Claude could not rename the Agent session',
        });
    });

    it('bounds an oversized stderr so the rename toast and its log record stay readable', () => {
        const error = new Error('Command failed') as Error & { stderr: string };
        error.stderr = 'x'.repeat(500);

        expect(thrown(() => throwAgentRenameError('claude', error))).toMatchObject({
            code: 'UNAVAILABLE',
            message: `Claude could not rename the Agent session: ${'x'.repeat(300)}…`,
        });
    });

    it('still passes an already-typed CaxriError through unchanged', () => {
        const original = new CaxriError('TIMEOUT', 'Claude Session rename timed out');

        expect(thrown(() => throwAgentRenameError('claude', original))).toBe(original);
    });
});
