import { describe, expect, it } from 'vitest';

import {
    fakeAgentDevelopmentEnvironment,
    fakeAgentDevelopmentExports,
    parseFakeAgentDevelopmentArguments,
    realAgentDevelopmentEnvironment,
} from '../fake-agent-development-environment';

describe('fakeAgentDevelopmentEnvironment', () => {
    it('lists the E2E switches and every set isolation key', () => {
        expect(
            fakeAgentDevelopmentEnvironment(
                { CLAUDE_CONFIG_DIR: '/tmp/task/claude', CODEX_HOME: undefined },
                ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
                '/tmp/task/project',
            ),
        ).toEqual([
            ['CAXRI_E2E', '1'],
            ['CAXRI_E2E_WINDOW_MODE', 'visible'],
            ['CAXRI_TEST_ROOT_PATH', '/tmp/task/project'],
            ['CLAUDE_CONFIG_DIR', '/tmp/task/claude'],
        ]);
    });
});

describe('fakeAgentDevelopmentExports', () => {
    it('shell-quotes each entry as an export line', () => {
        const exports = fakeAgentDevelopmentExports([
            ['CAXRI_E2E', '1'],
            ['CLAUDE_CONFIG_DIR', "/tmp/task/it's"],
        ]);
        expect(exports.split('\n')).toEqual([
            "export CAXRI_E2E='1'",
            String.raw`export CLAUDE_CONFIG_DIR='/tmp/task/it'\''s'`,
        ]);
    });
});

describe('parseFakeAgentDevelopmentArguments', () => {
    it('defaults to fake Claude and requires an absolute directory', () => {
        expect(parseFakeAgentDevelopmentArguments(['/tmp/task'])).toEqual({
            directory: '/tmp/task',
            launchDev: false,
            provider: 'claude',
        });
        expect(() => parseFakeAgentDevelopmentArguments(['task'])).toThrow(/absolute/u);
        expect(() =>
            parseFakeAgentDevelopmentArguments(['/tmp/task', '--provider', 'gpt']),
        ).toThrow(/claude, codex, grok/u);
    });

    it('launches the dev instance only with --dev', () => {
        expect(
            parseFakeAgentDevelopmentArguments(['/tmp/task', '--dev', '--provider', 'codex']),
        ).toEqual({ directory: '/tmp/task', launchDev: true, provider: 'codex' });
    });

    it('accepts an absolute script for fake Claude or Codex in either flag order', () => {
        expect(
            parseFakeAgentDevelopmentArguments([
                '/tmp/task',
                '--script',
                '/tmp/task/script.json',
                '--provider',
                'codex',
            ]),
        ).toEqual({
            directory: '/tmp/task',
            launchDev: false,
            provider: 'codex',
            scriptPath: '/tmp/task/script.json',
        });
        expect(() =>
            parseFakeAgentDevelopmentArguments(['/tmp/task', '--script', 'script.json']),
        ).toThrow(/absolute/u);
        expect(() =>
            parseFakeAgentDevelopmentArguments([
                '/tmp/task',
                '--provider',
                'grok',
                '--script',
                '/tmp/task/script.json',
            ]),
        ).toThrow(/claude and codex/u);
    });

    it('takes an absolute real executable for the selected provider, but no script with it', () => {
        expect(
            parseFakeAgentDevelopmentArguments([
                '/tmp/task',
                '--provider',
                'antigravity',
                '--real-executable',
                '/usr/local/bin/agy',
            ]),
        ).toEqual({
            directory: '/tmp/task',
            launchDev: false,
            provider: 'antigravity',
            realExecutable: '/usr/local/bin/agy',
        });
        expect(() =>
            parseFakeAgentDevelopmentArguments(['/tmp/task', '--real-executable', 'agy']),
        ).toThrow(/absolute/u);
        expect(() =>
            parseFakeAgentDevelopmentArguments([
                '/tmp/task',
                '--real-executable',
                '/usr/local/bin/claude',
                '--script',
                '/tmp/task/script.json',
            ]),
        ).toThrow(/no script/u);
    });
});

describe('realAgentDevelopmentEnvironment', () => {
    it('allows only the selected provider, through its real executable, and keeps the host HOME', () => {
        const entries = realAgentDevelopmentEnvironment(
            'antigravity',
            '/usr/local/bin/agy',
            '/tmp/task/project',
        );
        expect(entries).toEqual([
            ['CAXRI_E2E', '1'],
            ['CAXRI_E2E_AGENT_MODE', 'fake'],
            ['CAXRI_E2E_FAKE_ANTIGRAVITY_EXECUTABLE', '/usr/local/bin/agy'],
            ['CAXRI_E2E_WINDOW_MODE', 'visible'],
            ['CAXRI_TEST_ROOT_PATH', '/tmp/task/project'],
        ]);
        expect(entries.map(([key]) => key)).not.toContain('HOME');
    });
});
