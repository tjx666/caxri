import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';
import type { AgentChatPendingPermission } from '../agent-chat-permissions.js';
import {
    agentChatPermissionModeLabel,
    agentChatPermissionModes,
    agentChatPermissionSelectionView,
    canAgentChatPlan,
    initialAgentChatPermission,
    isAgentChatPermissionNextTurnOnly,
    isAgentChatPermissionSettled,
    resolveAgentChatPermissionChange,
} from '../agent-chat-permissions.js';

describe('Agent Chat permission levels', () => {
    it('offers only the levels each provider supports natively', () => {
        expect(agentChatPermissionModes('claude')).toEqual([
            'ask',
            'acceptEdits',
            'auto',
            'fullAccess',
        ]);
        expect(agentChatPermissionModes('codex')).toEqual([
            'readOnly',
            'acceptEdits',
            'auto',
            'fullAccess',
        ]);
        expect(agentChatPermissionModes('grok')).toEqual(['ask', 'auto', 'fullAccess']);
        expect(canAgentChatPlan('grok')).toBe(false);
        expect(agentChatPermissionModeLabel('acceptEdits', 'codex')).toBe('Default');
        expect(agentChatPermissionModeLabel('acceptEdits', 'claude')).toBe(
            agentChatPermissionModeLabel('acceptEdits'),
        );
    });

    it('says which providers apply a switch made during a turn only from the next turn', () => {
        // Codex has no in-place request: the switch rides on the next `turn/start`.
        expect(isAgentChatPermissionNextTurnOnly('codex')).toBe(true);
        expect(isAgentChatPermissionNextTurnOnly('claude')).toBe(false);
        expect(isAgentChatPermissionNextTurnOnly('grok')).toBe(false);
    });

    it('starts a Chat from the Project default, dropping what the provider lacks', () => {
        expect(initialAgentChatPermission('codex', undefined)).toEqual({ planMode: false });
        expect(
            initialAgentChatPermission('codex', {
                codex: { permissionMode: 'readOnly', planMode: true },
            }),
        ).toEqual({ permissionMode: 'readOnly', planMode: true });
        expect(
            initialAgentChatPermission('grok', {
                grok: { permissionMode: 'readOnly', planMode: true },
            }),
        ).toEqual({ planMode: false });
        // Another provider's default never applies.
        expect(initialAgentChatPermission('claude', { codex: { permissionMode: 'auto' } })).toEqual(
            {
                planMode: false,
            },
        );
    });

    it('applies a partial change and rejects one the provider cannot run', () => {
        const current = { permissionMode: 'ask' as const, planMode: false };
        expect(resolveAgentChatPermissionChange('claude', current, { planMode: true })).toEqual({
            permissionMode: 'ask',
            planMode: true,
        });
        expect(
            resolveAgentChatPermissionChange('claude', current, { permissionMode: 'fullAccess' }),
        ).toEqual({ permissionMode: 'fullAccess', planMode: false });
        expect(() =>
            resolveAgentChatPermissionChange('claude', current, { permissionMode: 'readOnly' }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(() =>
            resolveAgentChatPermissionChange('grok', { planMode: false }, { planMode: true }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    });

    it('accepts a per-provider Chat default with known levels only', () => {
        const parse = (parameters: unknown) =>
            methods['project.setChatDefault'].params.safeParse(parameters).success;
        const valid = {
            projectId: 'project-1',
            provider: 'codex',
            chatDefault: { permissionMode: 'readOnly', planMode: true },
        };
        expect(parse(valid)).toBe(true);
        expect(parse({ ...valid, chatDefault: null })).toBe(true);
        expect(parse({ ...valid, provider: 'shell' })).toBe(false);
        expect(parse({ ...valid, chatDefault: { permissionMode: 'yolo' } })).toBe(false);
        expect(parse({ ...valid, chatDefault: { sandbox: 'read-only' } })).toBe(false);
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
