import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ExecutablesModule from '../../../../executables';

const mocks = vi.hoisted(() => ({
    loginPath: '/login/bin',
    runExternalCommand: vi.fn<typeof ExecutablesModule.runExternalCommand>(),
}));

vi.mock('../../../../executables', async (importOriginal) => {
    const actual = await importOriginal<typeof ExecutablesModule>();
    /**
     * The real implementation reads the login shell's PATH, which is whatever machine runs the suite. Stubbing it keeps
     * the assertion about what this test owns: the Agent's own variables survive, and PATH comes from the login shell
     * rather than from the caller.
     */
    const agentProcessEnvironment: typeof actual.agentProcessEnvironment = (variables = {}) =>
        Promise.resolve({ ...variables, PATH: mocks.loginPath });
    return { ...actual, agentProcessEnvironment, runExternalCommand: mocks.runExternalCommand };
});

import type { AgentProviderSessionRenameContext } from '../../../contract';
import { renameClaudeSession } from '..';

afterEach(() => {
    mocks.runExternalCommand.mockReset();
});

function claudeRenameContext(
    overrides: Partial<AgentProviderSessionRenameContext> = {},
): AgentProviderSessionRenameContext {
    return {
        agentSessionId: 'claude-session-rename',
        cwd: '/workspace/project',
        title: 'Release readiness',
        environment: {
            homeDirectory: '/Users/test',
            variables: {
                CLAUDE_CONFIG_DIR: '/tmp/claude-test-config',
                CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
                PATH: '/opt/claude/bin:/usr/bin',
            },
        },
        executable: '/opt/claude/bin/claude',
        version: '2.1.251 (Claude Code)',
        ...overrides,
    };
}

describe('renameClaudeSession', () => {
    it('renames the exact native session with structured arguments and returns the provider-authoritative name', async () => {
        mocks.runExternalCommand.mockResolvedValue({
            stderr: '',
            stdout: JSON.stringify({
                is_error: false,
                result: 'Session renamed to: Release readiness 2',
                session_id: 'claude-session-rename',
                subtype: 'success',
                type: 'result',
            }),
        });

        await expect(renameClaudeSession(claudeRenameContext())).resolves.toEqual({
            title: 'Release readiness 2',
        });
        expect(mocks.runExternalCommand).toHaveBeenCalledOnce();
        const [executable, arguments_, options, dependencies] =
            mocks.runExternalCommand.mock.calls[0];
        expect(executable).toBe('/opt/claude/bin/claude');
        expect(arguments_).toEqual([
            '--resume',
            'claude-session-rename',
            '--print',
            '--output-format',
            'json',
            '/rename Release readiness',
        ]);
        expect(options).toMatchObject({
            cwd: '/workspace/project',
            maxBuffer: 64 * 1024,
            signal: undefined,
            timeout: 60_000,
        });
        expect(options.env).toMatchObject({
            CLAUDE_CODE_ENTRYPOINT: 'caxri',
            CLAUDE_CONFIG_DIR: '/tmp/claude-test-config',
            HOME: '/Users/test',
            // The caller's own `/opt/claude/bin:/usr/bin` is deliberately overridden: a GUI-launched Server only has
            // launchd's PATH, which cannot start a CLI shim that `exec node`.
            PATH: mocks.loginPath,
        });
        expect(dependencies).toBeUndefined();
    });

    it.each(['2.1.231 (Claude Code)', '3.0.0 (Claude Code)'])(
        'rejects Claude Code version %s outside the native rename contract',
        async (version) => {
            await expect(
                renameClaudeSession(claudeRenameContext({ version })),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(mocks.runExternalCommand).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['malformed output', 'not-json'],
        [
            'a rejected rename',
            JSON.stringify({
                is_error: true,
                result: 'Session rename denied',
                session_id: 'claude-session-rename',
                subtype: 'error',
                type: 'result',
            }),
        ],
    ])('maps %s to UNAVAILABLE', async (_case, stdout) => {
        mocks.runExternalCommand.mockResolvedValue({ stderr: '', stdout });

        await expect(renameClaudeSession(claudeRenameContext())).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
    });

    it('classifies a bounded Claude Code process timeout', async () => {
        mocks.runExternalCommand.mockRejectedValue(
            Object.assign(new Error('timed out'), { killed: true }),
        );

        await expect(renameClaudeSession(claudeRenameContext())).rejects.toMatchObject({
            code: 'TIMEOUT',
        });
    });
});
