import { agentProviderCatalog } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { benchmarkLaunchSettings, probeLaunchSettings } from '../launch';

const configured = { executable: '/opt/agent', args: ['--model', 'pinned-by-user'] };

describe('benchmarkLaunchSettings', () => {
    it('passes the Codex model and effort as Codex flags', () => {
        expect(
            benchmarkLaunchSettings(
                { provider: 'codex', model: 'gpt-x', effort: 'high' },
                configured,
            ),
        ).toEqual({
            executable: '/opt/agent',
            args: [
                agentProviderCatalog.codex.autonomyArgs[0],
                '-m',
                'gpt-x',
                '-c',
                'model_reasoning_effort="high"',
            ],
        });
    });

    it('passes the Grok Build effort as a launch flag', () => {
        expect(
            benchmarkLaunchSettings(
                { provider: 'grok', model: 'grok-x', effort: 'low' },
                configured,
            ).args,
        ).toEqual([
            agentProviderCatalog.grok.autonomyArgs[0],
            '--model',
            'grok-x',
            '--reasoning-effort',
            'low',
        ]);
    });

    it('leaves the Claude Code effort to the session and drops the user arguments', () => {
        expect(
            benchmarkLaunchSettings(
                { provider: 'claude', model: 'opus', effort: 'max' },
                configured,
            ).args,
        ).toEqual([agentProviderCatalog.claude.autonomyArgs[0], '--model', 'opus']);
    });
});

describe('probeLaunchSettings', () => {
    it('starts with autonomy only so the provider reports its own default model', () => {
        expect(probeLaunchSettings('codex', configured)).toEqual({
            executable: '/opt/agent',
            args: [agentProviderCatalog.codex.autonomyArgs[0]],
        });
    });
});
