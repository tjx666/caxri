import { describe, expect, it } from 'vitest';

import {
    agentChatPermissionLabel,
    agentChatPermissionView,
    agentChatProjectDefault,
    isAgentChatProjectDefault,
} from '../agent-chat-permissions';

describe('Agent Chat permission picker', () => {
    it('names the level in the provider words, and Custom without one', () => {
        expect(agentChatPermissionLabel({ permissionMode: 'acceptEdits' }, 'codex')).toBe(
            'Default',
        );
        expect(agentChatPermissionLabel({ permissionMode: 'acceptEdits' }, 'claude')).toBe(
            'Accept edits',
        );
        expect(agentChatPermissionLabel({}, 'codex')).toBe('Custom');
    });

    it('saves the level and plan mode as the Project default, and nothing for Custom', () => {
        expect(agentChatProjectDefault({ permissionMode: 'auto', planMode: true })).toEqual({
            permissionMode: 'auto',
            planMode: true,
        });
        // Grok Build has no plan mode, so its default carries none.
        expect(agentChatProjectDefault({ permissionMode: 'auto' })).toEqual({
            permissionMode: 'auto',
        });
        expect(agentChatProjectDefault({ planMode: false })).toBeUndefined();
    });

    it('recognizes the default the Project already has for that provider', () => {
        const defaults = { codex: { permissionMode: 'readOnly' as const } };
        expect(
            isAgentChatProjectDefault(
                { permissionMode: 'readOnly', planMode: false },
                defaults,
                'codex',
            ),
        ).toBe(true);
        expect(
            isAgentChatProjectDefault(
                { permissionMode: 'readOnly', planMode: true },
                defaults,
                'codex',
            ),
        ).toBe(false);
        expect(isAgentChatProjectDefault({ permissionMode: 'readOnly' }, defaults, 'claude')).toBe(
            false,
        );
        expect(isAgentChatProjectDefault({ permissionMode: 'readOnly' }, undefined, 'codex')).toBe(
            false,
        );
    });

    it('describes the trigger and whether the Chat already matches the Project default', () => {
        expect(
            agentChatPermissionView({ permissionMode: 'fullAccess', planMode: true }, 'claude', {
                claude: { permissionMode: 'fullAccess', planMode: true },
            }),
        ).toEqual({
            label: 'Full access',
            ariaLabel: 'Permissions: Full access, plan mode on',
            isFullAccess: true,
            projectDefault: { permissionMode: 'fullAccess', planMode: true },
            isSavedDefault: true,
        });
        expect(agentChatPermissionView({ planMode: false }, 'codex', undefined)).toEqual({
            label: 'Custom',
            ariaLabel: 'Permissions: Custom',
            isFullAccess: false,
            projectDefault: undefined,
            isSavedDefault: false,
        });
    });
});
