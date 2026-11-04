import type { AgentChatPermission } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatSessionHost } from '../../../chat-provider';
import { ClaudePermissions } from '../permissions';
import { ClaudeRequestBroker } from '../requests';

type Switch = Parameters<ClaudePermissions['set']>[0];

const DEFAULT_PERMISSION: AgentChatPermission = { permissionMode: 'fullAccess', planMode: false };

function fixture(permission: AgentChatPermission = DEFAULT_PERMISSION) {
    const changes: AgentChatPermission[] = [];
    const host = {
        apply: vi.fn(),
        onPermissionChanged: (next: AgentChatPermission) => changes.push(next),
        permission,
    } as unknown as ConstructorParameters<typeof ClaudePermissions>[0];
    return { changes, permissions: new ClaudePermissions(host, 'default') };
}

/**
 * A mode switch the test settles by hand, like the Agent SDK's control request.
 */
function deferredSwitch() {
    const calls: Array<{ mode: string; resolve: () => void; reject: (error: Error) => void }> = [];
    const query: Switch = {
        setPermissionMode: (mode) =>
            new Promise<void>((resolve, reject) => {
                calls.push({ mode, resolve, reject });
            }),
    };
    return { calls, query };
}

describe('Claude appliedPermission', () => {
    it('is applied at rest', () => {
        const { permissions } = fixture();

        expect(permissions.appliedPermission()).toEqual({
            permissionMode: 'fullAccess',
            planMode: false,
            applied: true,
        });
    });

    it('is unapplied while a chosen switch has not been confirmed, and applied after it', async () => {
        const { permissions } = fixture({ permissionMode: 'ask', planMode: false });
        const { calls, query } = deferredSwitch();

        const switching = permissions.set(query, { permissionMode: 'fullAccess', planMode: false });
        expect(permissions.appliedPermission().applied).toBe(false);

        calls[0].resolve();
        await switching;
        expect(permissions.appliedPermission()).toMatchObject({
            permissionMode: 'fullAccess',
            applied: true,
        });
    });

    it('is applied again after a refused switch, still at the previous level', async () => {
        const { permissions } = fixture({ permissionMode: 'ask', planMode: false });
        const { calls, query } = deferredSwitch();

        const switching = permissions.set(query, { permissionMode: 'fullAccess', planMode: false });
        calls[0].reject(new Error('refused'));
        await expect(switching).rejects.toThrow('refused');

        expect(permissions.appliedPermission()).toMatchObject({
            permissionMode: 'ask',
            applied: true,
        });
    });

    it('stays unapplied while two switches overlap until both settle', async () => {
        const { permissions } = fixture({ permissionMode: 'ask', planMode: false });
        const { calls, query } = deferredSwitch();

        const first = permissions.set(query, { permissionMode: 'acceptEdits', planMode: false });
        const second = permissions.set(query, { permissionMode: 'fullAccess', planMode: false });
        calls[0].resolve();
        await first;
        expect(permissions.appliedPermission().applied).toBe(false);

        calls[1].resolve();
        await second;
        expect(permissions.appliedPermission().applied).toBe(true);
    });
});

describe('a plan-exit correction', () => {
    async function leavingPlanMode() {
        const f = fixture({ permissionMode: 'fullAccess', planMode: true });
        const { calls, query } = deferredSwitch();
        // Claude Code leaves plan mode on its own after an approved plan, in a mode that is not the chosen level.
        f.permissions.onReported('acceptEdits', query);
        await Promise.resolve();
        return { ...f, calls };
    }

    it('keeps the Chat unapplied until Claude Code confirms the chosen level', async () => {
        const { permissions, calls } = await leavingPlanMode();

        expect(calls.map((call) => call.mode)).toEqual(['bypassPermissions']);
        expect(permissions.appliedPermission()).toMatchObject({ planMode: false, applied: false });

        calls[0].resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(permissions.appliedPermission()).toMatchObject({
            permissionMode: 'fullAccess',
            applied: true,
        });
    });

    it('is applied once Claude Code reports the chosen mode before the request settles', async () => {
        const { permissions } = await leavingPlanMode();

        permissions.onReported('bypassPermissions', undefined);

        expect(permissions.appliedPermission()).toMatchObject({
            permissionMode: 'fullAccess',
            applied: true,
        });
    });

    it('converges to the mode Claude Code really runs when the correction fails', async () => {
        const { permissions, calls, changes } = await leavingPlanMode();

        calls[0].reject(new Error('refused'));
        await Promise.resolve();
        await Promise.resolve();

        expect(permissions.appliedPermission()).toEqual({
            permissionMode: 'acceptEdits',
            planMode: false,
            applied: true,
        });
        expect(changes.at(-1)).toEqual({ permissionMode: 'acceptEdits', planMode: false });
    });

    it('converges at once when there is no query to switch', () => {
        const { permissions } = fixture({ permissionMode: 'fullAccess', planMode: true });

        permissions.onReported('acceptEdits', undefined);

        expect(permissions.appliedPermission()).toEqual({
            permissionMode: 'acceptEdits',
            planMode: false,
            applied: true,
        });
    });
});

describe('ClaudeRequestBroker offers', () => {
    function broker() {
        const host = {
            read: () => ({ requests: [], activeTurnId: 'turn' }),
            apply: vi.fn(),
            lifecycle: vi.fn(),
        } as unknown as AgentChatSessionHost;
        return new ClaudeRequestBroker({
            host,
            sessionId: () => 's1',
            isEnded: () => false,
            onInterruptRequested: vi.fn(),
            planExitMode: () => {},
        });
    }
    const options = () => ({ requestId: 'request-1', signal: new AbortController().signal });

    it('offers both plain decisions for a tool approval and none for a question or an unknown request', () => {
        const claude = broker();
        void claude.canUseTool('Bash', { command: 'ls' }, { ...options(), toolUseID: 'tool-1' });
        void claude.canUseTool(
            'AskUserQuestion',
            { questions: [] },
            { ...options(), toolUseID: 'ask-1' },
        );

        expect(claude.offers('tool-1')).toEqual({ accept: true, decline: true });
        expect(claude.offers('ask-1')).toBeUndefined();
        expect(claude.offers('nope')).toBeUndefined();
    });
});
