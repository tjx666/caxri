import { describe, expect, it } from 'vitest';

import type { AgentChatPendingPermission } from '../agent-chat-permissions';
import {
    agentChatPermissionLabel,
    agentChatPermissionSelectionView,
    agentChatPermissionView,
    agentChatProjectDefault,
    isAgentChatPermissionDeferred,
    isAgentChatPermissionSettled,
    isAgentChatProjectDefault,
    nextAgentChatPermissionTurnBaseline,
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
            ariaLabel: 'Permissions: Full access',
            isFullAccess: true,
            projectDefault: { permissionMode: 'fullAccess', planMode: true },
            isSavedDefault: true,
            projectDefaultItem: { label: 'Project default', isChecked: true },
            pendingCaption: undefined,
        });
        expect(agentChatPermissionView({ planMode: false }, 'codex', undefined)).toEqual({
            label: 'Custom',
            ariaLabel: 'Permissions: Custom',
            isFullAccess: false,
            projectDefault: undefined,
            isSavedDefault: false,
            // Shown but unavailable, with the reason, rather than missing from the menu.
            projectDefaultItem: {
                label: 'Use as Project default',
                isChecked: false,
                disabledReason: 'Choose a level to save it as the default',
            },
            pendingCaption: undefined,
        });
        expect(
            agentChatPermissionView({ permissionMode: 'auto' }, 'codex', undefined)
                .projectDefaultItem,
        ).toEqual({ label: 'Use as Project default', isChecked: false });
    });

    it('says when the shown choice waits for the next turn', () => {
        const view = agentChatPermissionView({ permissionMode: 'readOnly' }, 'codex', undefined, {
            isDeferred: true,
        });
        expect(view.pendingCaption).toBe('from next turn');
        expect(view.ariaLabel).toBe('Permissions: Read only, from the next turn');
    });
});

describe('Agent Chat permission switch in flight', () => {
    const pending: AgentChatPendingPermission = {
        change: { permissionMode: 'readOnly' },
        baseline: { permissionMode: 'fullAccess', planMode: false },
        isAccepted: false,
    };

    it('shows the requested choice until the snapshot reports it', () => {
        const reported = { permissionMode: 'fullAccess' as const, planMode: false };
        expect(agentChatPermissionSelectionView(reported, pending)).toEqual({
            permissionMode: 'readOnly',
            planMode: false,
        });
        expect(agentChatPermissionSelectionView(reported, undefined)).toBe(reported);
        expect(isAgentChatPermissionSettled(pending, reported)).toBe(false);
        expect(isAgentChatPermissionSettled(pending, { permissionMode: 'readOnly' })).toBe(true);
    });

    it('settles an accepted switch on any reported change, even one the provider adjusted', () => {
        const accepted = { ...pending, isAccepted: true };
        expect(isAgentChatPermissionSettled(accepted, { permissionMode: 'auto' })).toBe(true);
        expect(
            isAgentChatPermissionSettled(accepted, {
                permissionMode: 'fullAccess',
                planMode: false,
            }),
        ).toBe(false);
    });

    it('settles a plan mode switch once the snapshot reports it', () => {
        const plan: AgentChatPendingPermission = {
            change: { planMode: true },
            baseline: { permissionMode: 'auto', planMode: false },
            isAccepted: false,
        };
        expect(
            isAgentChatPermissionSettled(plan, { permissionMode: 'auto', planMode: false }),
        ).toBe(false);
        expect(isAgentChatPermissionSettled(plan, { permissionMode: 'auto', planMode: true })).toBe(
            true,
        );
    });
});

describe('Agent Chat permission switch during a turn', () => {
    const reported = { permissionMode: 'fullAccess' as const, planMode: false };

    it('captures what the running turn uses only for a provider that applies switches next turn', () => {
        expect(
            nextAgentChatPermissionTurnBaseline(undefined, {
                activeTurnId: 'turn-1',
                appliesOnNextTurn: true,
                reported,
            }),
        ).toEqual({ turnId: 'turn-1', permissionMode: 'fullAccess', planMode: false });
        expect(
            nextAgentChatPermissionTurnBaseline(undefined, {
                activeTurnId: 'turn-1',
                appliesOnNextTurn: false,
                reported,
            }),
        ).toBeUndefined();
        expect(
            nextAgentChatPermissionTurnBaseline(undefined, {
                activeTurnId: undefined,
                appliesOnNextTurn: true,
                reported,
            }),
        ).toBeUndefined();
    });

    it('keeps the first capture of a turn, so a second switch still compares with what the turn runs', () => {
        const first = { turnId: 'turn-1', permissionMode: 'fullAccess' as const, planMode: false };
        expect(
            nextAgentChatPermissionTurnBaseline(first, {
                activeTurnId: 'turn-1',
                appliesOnNextTurn: true,
                reported: { permissionMode: 'readOnly', planMode: false },
            }),
        ).toBe(first);
    });

    it('defers a changed choice until the turn that captured it ends', () => {
        const baseline = {
            turnId: 'turn-1',
            permissionMode: 'fullAccess' as const,
            planMode: false,
        };
        const shown = { permissionMode: 'readOnly' as const, planMode: false };
        expect(isAgentChatPermissionDeferred(baseline, shown, 'turn-1')).toBe(true);
        // Switching back to what the turn runs leaves nothing waiting.
        expect(isAgentChatPermissionDeferred(baseline, reported, 'turn-1')).toBe(false);
        expect(isAgentChatPermissionDeferred(baseline, shown, 'turn-2')).toBe(false);
        expect(isAgentChatPermissionDeferred(baseline, shown, undefined)).toBe(false);
        expect(isAgentChatPermissionDeferred(undefined, shown, 'turn-1')).toBe(false);
        expect(
            isAgentChatPermissionDeferred(
                baseline,
                { permissionMode: 'fullAccess', planMode: true },
                'turn-1',
            ),
        ).toBe(true);
    });
});
