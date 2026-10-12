import { describe, expect, it } from 'vitest';

import { codexPermissionMode, codexPermissionSettings } from '../codex-permissions';

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
