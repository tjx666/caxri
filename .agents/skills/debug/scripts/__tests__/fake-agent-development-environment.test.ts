import { describe, expect, it } from 'vitest';

import {
    fakeAgentDevelopmentEnvironment,
    fakeAgentDevelopmentExports,
    parseFakeAgentDevelopmentArguments,
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
});
