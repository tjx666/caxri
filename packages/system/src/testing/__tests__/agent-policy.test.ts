import { agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    assertE2EAgentChatInput,
    assertE2EAgentChatLaunch,
    assertE2EAgentInput,
    assertE2EAgentLaunch,
    assertE2EShellLaunch,
    e2eAgentPolicyEnvironment,
    e2eAgentShellShimProviders,
    e2eAgentShellShims,
    e2eFakeExecutableEnvironment,
    e2eFakeExecutableEnvironmentKey,
    readE2EAgentPolicy,
    readE2EFakeExecutables,
    resolveE2EAgentPolicy,
    selectE2EAgentExecutable,
} from '../agent-policy';

describe('E2E Agent policy', () => {
    it('defaults E2E launches to blocked without changing production discovery', () => {
        const production = resolveE2EAgentPolicy({ isE2E: false });
        const e2e = resolveE2EAgentPolicy({ isE2E: true });

        expect(selectE2EAgentExecutable(production, 'codex', 'codex')).toBe('codex');
        expect(selectE2EAgentExecutable(e2e, 'codex', 'codex')).toBeUndefined();
    });

    it('allows only declared fake executables', () => {
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'fake',
            requestedExecutables: { codex: '/tmp/fake-codex' },
        });

        expect(selectE2EAgentExecutable(policy, 'codex', 'codex')).toBe('/tmp/fake-codex');
        expect(selectE2EAgentExecutable(policy, 'claude', 'claude')).toBeUndefined();
        expect(e2eAgentPolicyEnvironment(policy)).toEqual({
            CAXRI_E2E: '1',
            CAXRI_E2E_AGENT_MODE: 'fake',
            CAXRI_E2E_FAKE_CODEX_EXECUTABLE: '/tmp/fake-codex',
        });
    });

    it('derives fake environment keys and Shell shims for every supplied provider id', () => {
        const providers = ['claude', 'codex', 'synthetic-agent'] as const;
        const executables = { 'synthetic-agent': '/tmp/fake-synthetic-agent' };
        const shimProviders = providers.map((provider) => ({
            provider,
            executableName: provider === 'synthetic-agent' ? 'synthetic-cli' : provider,
        }));
        const environment = e2eFakeExecutableEnvironment(executables, providers);

        expect(environment).toEqual({
            CAXRI_E2E_FAKE_SYNTHETIC_AGENT_EXECUTABLE: '/tmp/fake-synthetic-agent',
        });
        expect(e2eFakeExecutableEnvironmentKey('claude')).toBe('CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE');
        expect(readE2EFakeExecutables(environment, providers)).toEqual(executables);
        const fakeShim = e2eAgentShellShims(executables, shimProviders).find(
            (shim) => shim.executable === 'synthetic-cli',
        );
        const blockedShim = e2eAgentShellShims({}, shimProviders).find(
            (shim) => shim.executable === 'synthetic-cli',
        );
        expect(fakeShim?.source).toContain('/tmp/fake-synthetic-agent');
        expect(blockedShim?.source).toContain('Caxri E2E blocked synthetic-cli');
        expect(
            e2eAgentShellShims({ 'synthetic-agent': "/tmp/fake'synthetic-agent" }, shimProviders)[2]
                ?.source,
        ).toContain(`exec '/tmp/fake'"'"'synthetic-agent'`);
    });

    it('rejects colliding fake environment keys instead of dropping provider authority', () => {
        expect(() =>
            e2eFakeExecutableEnvironment(
                { 'foo-bar': '/tmp/fake-dash', 'foo_bar': '/tmp/fake-underscore' },
                ['foo-bar', 'foo_bar'],
            ),
        ).toThrow('E2E fake executable environment keys collide');
    });

    it('generates one default Shell shim for every catalog provider', () => {
        expect(e2eAgentShellShimProviders().map(({ provider }) => provider)).toEqual(
            agentProviderIds,
        );
        expect(e2eAgentShellShims({}).map((shim) => shim.provider)).toEqual(agentProviderIds);
    });

    it('rejects duplicate or unsafe Shell shim executable names', () => {
        expect(() =>
            e2eAgentShellShims({}, [
                { provider: 'first', executableName: 'same-cli' },
                { provider: 'second', executableName: 'same-cli' },
            ]),
        ).toThrow('must be unique');
        for (const executableName of ['../agent', 'agent/cli', 'agent\u{0}cli', '.']) {
            expect(() =>
                e2eAgentShellShims({}, [{ provider: 'synthetic', executableName }]),
            ).toThrow('must be a portable basename');
        }
    });

    it('round-trips every catalog fake executable through the Main-to-Runtime environment', () => {
        const executables = Object.fromEntries(
            agentProviderIds.map((provider) => [provider, `/tmp/fake-${provider}`]),
        );
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'fake',
            requestedExecutables: executables,
        });

        expect(readE2EAgentPolicy(e2eAgentPolicyEnvironment(policy))).toEqual(policy);
    });

    it('allows production discovery for exactly one real provider', () => {
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'real',
            requestedProvider: 'claude',
        });

        expect(selectE2EAgentExecutable(policy, 'claude', 'custom-claude')).toBe('custom-claude');
        expect(selectE2EAgentExecutable(policy, 'codex', 'codex')).toBeUndefined();
    });

    it('limits real mode to one read-only Codex launch without interactive input', () => {
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'real',
            requestedProvider: 'codex',
        });
        const safeLaunch = {
            executable: 'codex',
            args: [
                'exec',
                '--sandbox',
                'read-only',
                '--skip-git-repo-check',
                '--ephemeral',
                '--ignore-rules',
                '--color',
                'never',
                'Read README.md and report its heading. Do not modify files.',
            ],
        };

        expect(() => assertE2EAgentLaunch(policy, 'codex', safeLaunch)).not.toThrow();
        expect(() =>
            assertE2EAgentLaunch(policy, 'codex', safeLaunch, 'persisted-session'),
        ).toThrow('does not resume persisted Agent sessions');
        expect(() =>
            assertE2EAgentLaunch(policy, 'codex', {
                ...safeLaunch,
                args: ['--dangerously-bypass-approvals-and-sandbox', 'run'],
            }),
        ).toThrow('bounded read-only Codex smoke launch');
        expect(() => assertE2EAgentInput(policy, 'codex')).toThrow(
            'does not accept interactive Terminal input',
        );
        expect(() => assertE2EShellLaunch(policy)).toThrow(
            'does not allow Shell Terminal launches',
        );
    });

    it('keeps the real PTY smoke from starting a Chat', () => {
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'real',
            requestedProvider: 'codex',
        });

        expect(policy).toEqual({ mode: 'real', provider: 'codex', surface: 'pty' });
        expect(() =>
            assertE2EAgentChatLaunch(policy, 'codex', { executable: 'codex', args: [] }),
        ).toThrow('Chat is unavailable');
    });

    it('limits a real Chat run to one Codex Chat with short natural prompts', () => {
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'real',
            requestedProvider: 'codex',
            requestedSurface: 'chat',
        });
        const launch = { executable: 'codex', args: ['--search'] };

        expect(readE2EAgentPolicy(e2eAgentPolicyEnvironment(policy))).toEqual(policy);
        expect(() => assertE2EAgentChatLaunch(policy, 'codex', launch)).not.toThrow();
        expect(() =>
            assertE2EAgentChatLaunch(policy, 'codex', { executable: '/tmp/codex', args: [] }),
        ).toThrow('Chat is unavailable');
        expect(() =>
            assertE2EAgentLaunch(policy, 'codex', {
                executable: 'codex',
                args: ['exec', 'Read README.md'],
            }),
        ).toThrow('does not launch Agent Terminals');
        expect(() => assertE2EShellLaunch(policy)).toThrow(
            'does not allow Shell Terminal launches',
        );
        expect(() => assertE2EAgentChatInput(policy, 'What is this project about?')).not.toThrow();
        expect(() => assertE2EAgentChatInput(policy, 'x'.repeat(201))).toThrow(
            'short natural prompts',
        );
        expect(() => assertE2EAgentChatInput(policy, 'line\u{3}')).toThrow('short natural prompts');
        expect(() => assertE2EAgentChatInput(undefined, 'x'.repeat(201))).not.toThrow();
    });

    it('never grants real Chat authority to a provider without a reviewed Chat policy', () => {
        const policy = resolveE2EAgentPolicy({
            isE2E: true,
            requestedMode: 'real',
            requestedProvider: 'claude',
            requestedSurface: 'chat',
        });

        expect(() =>
            assertE2EAgentChatLaunch(policy, 'claude', { executable: 'claude', args: [] }),
        ).toThrow('Chat is unavailable');
    });

    it('rejects invalid modes, providers, and relative fake paths', () => {
        expect(() =>
            resolveE2EAgentPolicy({
                isE2E: true,
                requestedMode: 'real',
                requestedSurface: 'both',
            }),
        ).toThrow('Unsupported real E2E Agent surface');
        expect(() => resolveE2EAgentPolicy({ isE2E: true, requestedMode: 'unknown' })).toThrow(
            'Unsupported E2E Agent mode',
        );
        expect(() =>
            resolveE2EAgentPolicy({
                isE2E: true,
                requestedMode: 'real',
                requestedProvider: 'unknown',
            }),
        ).toThrow('Unsupported E2E Agent provider');
        expect(() =>
            resolveE2EAgentPolicy({
                isE2E: true,
                requestedMode: 'fake',
                requestedExecutables: { codex: 'relative/codex' },
            }),
        ).toThrow('must be an absolute path');
    });
});
