import { describe, expect, it } from 'vitest';

import { grokOpeningSettings, grokPermissionMode, withGrokPermission } from '../grok-permissions';

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

    it('passes Ask explicitly so the user config cannot raise it (#1957)', () => {
        /**
         * Grok Build 1.0.62 follows `[ui] permission_mode = "always-approve"` unless `--permission-mode default` is
         * given.
         */
        const opened = (launch: { args: string[] }, permission?: { permissionMode: 'ask' }) =>
            grokOpeningSettings({
                launch: { ...launch, command: 'grok' },
                permission,
            } as unknown as Parameters<typeof grokOpeningSettings>[0]);
        expect(opened({ args: [] })).toEqual({
            settings: { rootArgs: ['--permission-mode', 'default'], agentArgs: [] },
            permissionMode: 'ask',
        });
        expect(opened({ args: ['--permission-mode', 'auto'] }).settings.rootArgs).toEqual([
            '--permission-mode',
            'auto',
        ]);
        expect(opened({ args: ['--yolo'] }).permissionMode).toBe('fullAccess');
    });
});
