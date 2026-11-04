import type { ProtocolWelcome } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CliConnectOptions, CliServerClient } from '../application';
import { runCli } from '../application';
import {
    assertAgentDelegationCredential,
    DELEGATION_PROJECT_ENVIRONMENT,
    DELEGATION_SESSION_ENVIRONMENT,
    withDelegationDefaults,
} from '../delegation-environment';
import type { DelegationClientCredential } from '../environment';

const clientId = 'd1decb80-7644-44fd-b821-a7d6678fb0eb';
const credential: DelegationClientCredential = {
    kind: 'delegation-client',
    clientId,
    generation: 1,
    token: 'ab'.repeat(32),
};
const defaults = {
    [DELEGATION_PROJECT_ENVIRONMENT]: 'project-env',
    [DELEGATION_SESSION_ENVIRONMENT]: 'session-env',
};

describe('withDelegationDefaults', () => {
    it('fills the project and session for create and presets', () => {
        expect(
            withDelegationDefaults(
                'agent.delegation.create',
                ['--prompt-file', 'p.md'],
                defaults,
                credential,
            ),
        ).toEqual([
            '--prompt-file',
            'p.md',
            '--project',
            'project-env',
            '--session',
            'session-env',
        ]);
        expect(
            withDelegationDefaults('agent.delegation.presets', [], defaults, credential),
        ).toEqual(['--project', 'project-env', '--session', 'session-env']);
    });

    it('never adds a default Session to --new-session, nor a Project ID next to --project-path', () => {
        expect(
            withDelegationDefaults(
                'agent.delegation.create',
                ['--new-session', '--title', 'T', '--project-path', '/r'],
                defaults,
                credential,
            ),
        ).toEqual(['--new-session', '--title', 'T', '--project-path', '/r']);
        expect(
            withDelegationDefaults(
                'agent.delegation.create',
                ['--new-session', '--title', 'T'],
                defaults,
                credential,
            ),
        ).toEqual(['--new-session', '--title', 'T', '--project', 'project-env']);
    });

    it('lets an explicit target win', () => {
        expect(
            withDelegationDefaults(
                'agent.delegation.create',
                ['--project', 'mine', '--session', 'mine-s'],
                defaults,
                credential,
            ),
        ).toEqual(['--project', 'mine', '--session', 'mine-s']);
    });

    it('does nothing without a delegation-client credential or for other methods', () => {
        const tokens = ['--prompt-file', 'p.md'];
        expect(withDelegationDefaults('agent.delegation.create', tokens, defaults, undefined)).toBe(
            tokens,
        );
        expect(
            withDelegationDefaults('agent.delegation.status', tokens, defaults, credential),
        ).toBe(tokens);
        expect(withDelegationDefaults('agent.delegation.create', tokens, {}, credential)).toBe(
            tokens,
        );
    });
});

describe('assertAgentDelegationCredential', () => {
    it('refuses delegation and dispatch methods for an Agent without a credential', () => {
        for (const method of [
            'agent.delegation.create',
            'agent.delegation.wait',
            'agent.dispatch.wait',
        ] as const)
            expect(() => assertAgentDelegationCredential(method, 'agent', undefined)).toThrow(
                /access launch/u,
            );
    });

    it('allows a credentialed Agent, a human, CI and unrelated methods', () => {
        expect(() =>
            assertAgentDelegationCredential('agent.delegation.create', 'agent', credential),
        ).not.toThrow();
        expect(() =>
            assertAgentDelegationCredential('agent.delegation.create', 'human', undefined),
        ).not.toThrow();
        expect(() =>
            assertAgentDelegationCredential('agent.delegation.create', 'ci', undefined),
        ).not.toThrow();
        expect(() =>
            assertAgentDelegationCredential('project.list', 'agent', undefined),
        ).not.toThrow();
    });
});

function fixture(commands: string[]) {
    const request = vi.fn(() => Promise.resolve({}));
    const client: CliServerClient = {
        close: vi.fn(),
        request,
        requestWithId: request,
        welcome: {
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            principal: { kind: 'human-cli', id: 'owner' },
            capabilities: ['agents.delegate', 'projects.read'],
            commands,
        } satisfies ProtocolWelcome,
    };
    const connect = vi.fn<(options: CliConnectOptions) => Promise<CliServerClient>>(() =>
        Promise.resolve(client),
    );
    let stderr = '';
    const io = {
        writeStdout: vi.fn(),
        writeStderr: (text: string) => {
            stderr += text;
        },
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
    };
    return { client, connect, io, request, stderr: () => stderr };
}

describe('Agent without a credential through the CLI', () => {
    it('is refused before any connection, by command and by generic request', async () => {
        const { connect, io, stderr } = fixture(['agent.delegation.list']);
        const environment = { CLAUDECODE: '1' };
        expect(
            await runCli(['agent', 'delegate', 'list', '--json'], { connect, environment, io }),
        ).not.toBe(0);
        expect(stderr()).toContain('access launch');
        expect(
            await runCli(
                ['request', 'agent.delegation.list', '--params', '{}', '--profile', '/p', '--yes'],
                { connect, environment, io },
            ),
        ).not.toBe(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('still works for a human owner and for a delegation credential', async () => {
        const { connect, io, request } = fixture(['agent.delegation.list']);
        expect(
            await runCli(['agent', 'delegate', 'list', '--json'], {
                connect,
                environment: {},
                io,
            }),
        ).toBe(0);
        expect(request).toHaveBeenCalledWith('agent.delegation.list', { active: false });
        expect(
            await runCli(['agent', 'delegate', 'list', '--json'], {
                connect,
                environment: {
                    CLAUDECODE: '1',
                    CAXRI_USER_DATA_DIR: '/profiles/external',
                    CAXRI_DELEGATION_CLIENT_ID: clientId,
                    CAXRI_DELEGATION_GENERATION: '1',
                    CAXRI_DELEGATION_TOKEN: credential.token,
                },
                io,
            }),
        ).toBe(0);
    });
});
