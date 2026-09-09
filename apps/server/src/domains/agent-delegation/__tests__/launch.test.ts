import { describe, expect, it } from 'vitest';

import { validateDelegationLaunch } from '../launch';

describe('delegation launch configuration', () => {
    it('preserves a read-only tool boundary without changing the owned interactive session', () => {
        expect(() =>
            validateDelegationLaunch('claude', {
                executable: 'claude',
                args: ['--tools', 'Read', '--strict-mcp-config', '--permission-mode=plan'],
            }),
        ).not.toThrow();
    });

    it.each([
        ['--print'],
        ['--resume', 'another-session'],
        ['--session-id=another-session'],
        ['--settings', 'unreviewed-settings.json'],
        ['--model', '--print'],
        ['unexpected positional prompt'],
    ])('rejects launch arguments that can replace submission or evidence: %j', (...arguments_) => {
        expect(() =>
            validateDelegationLaunch('claude', { executable: 'claude', args: arguments_ }),
        ).toThrow(/unsupported/u);
    });
});
