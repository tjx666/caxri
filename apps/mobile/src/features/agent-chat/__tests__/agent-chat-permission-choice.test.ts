import { describe, expect, it } from 'vitest';

import {
    agentChatPermissionFailureMessage,
    agentChatPermissionOptions,
    agentChatPermissionSheetNote,
    agentChatPermissionTrigger,
    agentChatPlanModeToggle,
} from '../agent-chat-permission-choice';

describe('Agent Chat permission choice', () => {
    it('names the level in the provider words, marks Full access and plan mode', () => {
        expect(
            agentChatPermissionTrigger(
                { permissionMode: 'acceptEdits', planMode: false },
                'codex',
                true,
            ),
        ).toEqual({
            label: 'Default',
            isFullAccess: false,
            isPlanMode: false,
            isInteractive: true,
            accessibilityLabel: 'Permissions: Default',
        });
        expect(
            agentChatPermissionTrigger(
                { permissionMode: 'fullAccess', planMode: true },
                'claude',
                false,
            ),
        ).toMatchObject({
            label: 'Full access',
            isFullAccess: true,
            isPlanMode: true,
            isInteractive: false,
            accessibilityLabel: 'Permissions: Full access, plan mode on',
        });
        // Launch settings no level matches read as Custom.
        expect(agentChatPermissionTrigger({ planMode: false }, 'codex', true)?.label).toBe(
            'Custom',
        );
    });

    it('shows nothing before the Chat reports its permission or without a provider', () => {
        expect(agentChatPermissionTrigger({}, 'codex', true)).toBeUndefined();
        expect(agentChatPermissionTrigger(undefined, 'codex', true)).toBeUndefined();
        expect(
            agentChatPermissionTrigger({ permissionMode: 'auto' }, undefined, true),
        ).toBeUndefined();
    });

    it('lists only the provider levels with the Desktop names and descriptions', () => {
        const codex = agentChatPermissionOptions({ permissionMode: 'readOnly' }, 'codex');
        expect(codex.map((option) => [option.value, option.label, option.isSelected])).toEqual([
            ['readOnly', 'Read only', true],
            ['acceptEdits', 'Default', false],
            ['auto', 'Auto', false],
            ['fullAccess', 'Full access', false],
        ]);
        expect(codex[1]?.description).toBe('Edits in the workspace; asks to go further');
        expect(codex.find((option) => option.isFullAccess)?.value).toBe('fullAccess');
        // Android reports only lower-case resource IDs, so each level's row stays reachable by its `testID`.
        expect(codex.map((option) => option.testID)).toEqual([
            'agent-chat-permission-read-only',
            'agent-chat-permission-accept-edits',
            'agent-chat-permission-auto',
            'agent-chat-permission-full-access',
        ]);
        expect(
            agentChatPermissionOptions({ permissionMode: 'ask' }, 'grok').map(
                (option) => option.value,
            ),
        ).toEqual(['ask', 'auto', 'fullAccess']);
    });

    it('checks a Custom row while launch settings decide the level', () => {
        const options = agentChatPermissionOptions({}, 'claude');
        expect(options[0]).toMatchObject({
            value: 'custom',
            label: 'Custom (from launch settings)',
            isSelected: true,
        });
        expect(options.filter((option) => option.isSelected)).toHaveLength(1);
    });

    it('offers plan mode only for a provider that has it', () => {
        expect(agentChatPlanModeToggle({ planMode: true }, 'codex')).toEqual({
            label: 'Plan mode',
            description: 'Plans first and changes nothing until you approve',
            isOn: true,
        });
        expect(agentChatPlanModeToggle({ planMode: false }, 'grok')).toBeUndefined();
        expect(agentChatPlanModeToggle({}, 'claude')).toBeUndefined();
    });

    it('says a Codex switch during a turn applies to the next turn', () => {
        expect(agentChatPermissionSheetNote({ activeTurnId: 'turn-1' }, 'codex')).toBe(
            'Applies to the next turn.',
        );
        expect(agentChatPermissionSheetNote({ activeTurnId: 'turn-1' }, 'claude')).toBeUndefined();
        expect(agentChatPermissionSheetNote({}, 'codex')).toBeUndefined();
    });

    it('names what failed to change', () => {
        expect(agentChatPermissionFailureMessage({ permissionMode: 'auto' })).toBe(
            'Unable to change permissions. Try again.',
        );
        expect(agentChatPermissionFailureMessage({ planMode: true })).toBe(
            'Unable to turn on plan mode. Try again.',
        );
        expect(agentChatPermissionFailureMessage({ planMode: false })).toBe(
            'Unable to turn off plan mode. Try again.',
        );
    });
});
