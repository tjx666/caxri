import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    codexPermissionMode,
    CodexPermissions,
    codexPermissionSettings,
} from '../codex-permissions';
import type { JsonRpcConnection } from '../json-rpc-connection';

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

describe('Codex plan mode without a model', () => {
    function permissions(model: string | undefined, isPlanMode: boolean) {
        const applied: AgentChatPatchOperation[] = [];
        const host = {
            apply: (operations: AgentChatPatchOperation[]) => applied.push(...operations),
            read: () => ({ ...(model && { model }) }) as AgentChatSnapshot,
        };
        const settings = {
            ...codexPermissionSettings('acceptEdits'),
        } as ConstructorParameters<typeof CodexPermissions>[1];
        return { applied, permissions: new CodexPermissions(host, settings, isPlanMode) };
    }
    const connection = {} as JsonRpcConnection;

    it('shows plan mode off when the thread opened without a model, since it could not be sent', () => {
        const { applied, permissions: withoutModel } = permissions(undefined, true);
        withoutModel.reportOpened(undefined);
        expect(applied.at(-1)).toEqual({
            op: 'state',
            state: { permissionMode: 'acceptEdits', planMode: false },
        });
        expect(withoutModel.turnParameters({}).parameters).toEqual({});
    });

    it('refuses to turn plan mode on until the model is known', async () => {
        const { applied, permissions: withoutModel } = permissions(undefined, false);
        await expect(withoutModel.set({ planMode: true }, connection, '/')).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(applied).toEqual([]);

        const { permissions: withModel } = permissions('fake-codex-model', false);
        await withModel.set({ planMode: true }, connection, '/');
        expect(withModel.turnParameters({ model: 'fake-codex-model' }).parameters).toMatchObject({
            collaborationMode: { mode: 'plan' },
        });
    });
});
