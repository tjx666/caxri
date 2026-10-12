import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';
import {
    agentChatPermissionModeLabel,
    agentChatPermissionModes,
    canAgentChatPlan,
    initialAgentChatPermission,
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
