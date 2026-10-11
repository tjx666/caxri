import { describe, expect, it } from 'vitest';

import { chatPermissionToStore } from '../chat-permission-switch';
import {
    claudeChatPermission,
    claudePermissionMode,
    codexPermissionMode,
    codexPermissionSettings,
    grokPermissionMode,
    withGrokPermission,
} from '../chat-permissions';

describe('Codex permission levels', () => {
    it('round-trips every level through its thread settings', () => {
        for (const mode of ['readOnly', 'acceptEdits', 'auto', 'fullAccess'] as const)
            expect(codexPermissionMode(codexPermissionSettings(mode))).toBe(mode);
        expect(codexPermissionSettings('auto')).toEqual({
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write',
        });
    });

    it('reads a launch configuration no level matches as no level', () => {
        expect(
            codexPermissionMode({
                approvalPolicy: 'untrusted',
                approvalsReviewer: 'user',
                sandbox: 'workspace-write',
            }),
        ).toBeUndefined();
        expect(() => codexPermissionSettings('ask')).toThrow();
    });
});

describe('Claude Code permission modes', () => {
    it('maps plan mode, a chosen level, and the launch mode', () => {
        expect(claudePermissionMode({ permissionMode: 'ask', planMode: true }, 'default')).toBe(
            'plan',
        );
        expect(
            claudePermissionMode({ permissionMode: 'fullAccess', planMode: false }, 'default'),
        ).toBe('bypassPermissions');
        expect(claudePermissionMode({ planMode: false }, 'acceptEdits')).toBe('acceptEdits');
        // A launch `--permission-mode plan` is the composer's toggle, not a level.
        expect(claudePermissionMode({ planMode: false }, 'plan')).toBe('default');
    });

    it('reads a reported mode back as a level and plan mode', () => {
        expect(claudeChatPermission('plan')).toEqual({ planMode: true });
        expect(claudeChatPermission('auto')).toEqual({ permissionMode: 'auto', planMode: false });
        expect(claudeChatPermission('dontAsk')).toEqual({ planMode: false });
    });
});

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

describe('Stored Chat permission', () => {
    it('keeps an inherited level unstored until the user picks one', () => {
        const next = { permissionMode: 'fullAccess' as const, planMode: true };
        // Only plan mode changed on a Chat that follows the launch settings.
        expect(chatPermissionToStore(undefined, next)).toEqual({ planMode: true });
        expect(chatPermissionToStore({ planMode: false }, next)).toEqual({ planMode: true });
        // The user picked the level now, or picked one before.
        expect(chatPermissionToStore(undefined, next, true)).toEqual(next);
        expect(chatPermissionToStore({ permissionMode: 'ask', planMode: false }, next)).toEqual(
            next,
        );
    });
});
