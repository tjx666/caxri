import { describe, expect, it } from 'vitest';

import { grokPermissionMode, withGrokPermission } from '../grok-permissions';

describe('Grok Build permission arguments', () => {
    const launched = { rootArgs: ['--permission-mode', 'auto', '-m', 'x'], agentArgs: ['--foo'] };

    it('replaces the launch permission options with the chosen level', () => {
        expect(withGrokPermission(launched, 'fullAccess')).toEqual({
            rootArgs: ['-m', 'x'],
            agentArgs: ['--always-approve', '--foo'],
        });
        expect(withGrokPermission(withGrokPermission(launched, 'fullAccess'), 'ask')).toEqual({
            rootArgs: ['-m', 'x', '--permission-mode', 'default'],
            agentArgs: ['--foo'],
        });
        expect(() => withGrokPermission(launched, 'readOnly')).toThrow();
    });

    it('reads the level the launch arguments describe', () => {
        expect(grokPermissionMode(launched)).toBe('auto');
        expect(grokPermissionMode({ rootArgs: [], agentArgs: [] })).toBe('ask');
        expect(
            grokPermissionMode({
                rootArgs: ['--permission-mode', 'bypassPermissions'],
                agentArgs: [],
            }),
        ).toBe('fullAccess');
        expect(
            grokPermissionMode({ rootArgs: ['--permission-mode', 'plan'], agentArgs: [] }),
        ).toBeUndefined();
    });
});
