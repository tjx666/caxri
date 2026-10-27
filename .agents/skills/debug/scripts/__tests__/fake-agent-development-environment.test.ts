import { describe, expect, it } from 'vitest';

import {
    fakeAgentDevelopmentExports as fakeAgentDevelopmentExports,
    parseFakeAgentDevelopmentArguments as parseFakeAgentDevelopmentArguments,
} from '../fake-agent-development-environment';

describe('fakeAgentDevelopmentExports', () => {
    it('exports the E2E switches and every set isolation key, shell-quoted', () => {
        const exports = fakeAgentDevelopmentExports(
            { CLAUDE_CONFIG_DIR: "/tmp/task/it's", CODEX_HOME: undefined },
            ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
            '/tmp/task/project',
        );
        expect(exports.split('\n')).toEqual([
            "export CAXRI_E2E='1'",
            "export CAXRI_E2E_WINDOW_MODE='visible'",
            "export CAXRI_TEST_ROOT_PATH='/tmp/task/project'",
            String.raw`export CLAUDE_CONFIG_DIR='/tmp/task/it'\''s'`,
        ]);
    });
});

describe('parseFakeAgentDevelopmentArguments', () => {
    it('defaults to fake Claude and requires an absolute directory', () => {
        expect(parseFakeAgentDevelopmentArguments(['/tmp/task'])).toEqual({
            directory: '/tmp/task',
            provider: 'claude',
        });
        expect(() => parseFakeAgentDevelopmentArguments(['task'])).toThrow(/absolute/u);
        expect(() =>
            parseFakeAgentDevelopmentArguments(['/tmp/task', '--provider', 'gpt']),
        ).toThrow(/claude, codex, grok/u);
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
