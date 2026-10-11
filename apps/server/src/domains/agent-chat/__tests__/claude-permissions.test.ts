import { describe, expect, it } from 'vitest';

import { claudeChatPermission, claudePermissionMode } from '../claude-permissions';

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
