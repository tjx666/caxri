import { describe, expect, it } from 'vitest';

import { methods, permissionAutoAllowStatusSchema } from '../index.js';
import { mobileAttentionAnswerParametersSchema } from '../mobile/mobile-attention-contract.js';
import { mobileInternalMethods, mobileMethods } from '../mobile/mobile-contract.js';

describe('permissionAutoAllowStatusSchema', () => {
    it('accepts a granted status with its timestamp and an ungranted status without one', () => {
        expect(permissionAutoAllowStatusSchema.parse({ granted: true, grantedAt: 1_700 })).toEqual({
            granted: true,
            grantedAt: 1_700,
        });
        expect(permissionAutoAllowStatusSchema.parse({ granted: false })).toEqual({
            granted: false,
        });
    });

    it('rejects an unknown field and a non-positive timestamp', () => {
        expect(
            permissionAutoAllowStatusSchema.safeParse({ granted: true, grantedAt: 0 }).success,
        ).toBe(false);
        expect(
            permissionAutoAllowStatusSchema.safeParse({ granted: true, extra: 'nope' }).success,
        ).toBe(false);
    });
});

describe('session.permissionAutoAllowStatus / session.revokePermissionAutoAllow', () => {
    it('are Desktop-reachable Server commands returning the shared status schema', () => {
        expect(methods['session.permissionAutoAllowStatus']).toMatchObject({
            owner: 'server',
            effect: 'read',
        });
        expect(methods['session.revokePermissionAutoAllow']).toMatchObject({
            owner: 'server',
            effect: 'write',
        });
        expect(
            methods['session.permissionAutoAllowStatus'].params.parse({ sessionId: 'session-1' }),
        ).toEqual({ sessionId: 'session-1' });
        expect(methods['session.permissionAutoAllowStatus'].result).toBe(
            permissionAutoAllowStatusSchema,
        );
        expect(methods['session.revokePermissionAutoAllow'].result).toBe(
            permissionAutoAllowStatusSchema,
        );
    });
});

describe('mobile.attention.answer autoAllow field', () => {
    it('accepts autoAllow only as the literal true', () => {
        expect(
            mobileAttentionAnswerParametersSchema.parse({
                sessionId: 'session-1',
                requestId: 'request-1',
                decision: 'allow',
                autoAllow: true,
            }),
        ).toMatchObject({ autoAllow: true });
        expect(
            mobileAttentionAnswerParametersSchema.safeParse({
                sessionId: 'session-1',
                requestId: 'request-1',
                decision: 'allow',
                autoAllow: false,
            }).success,
        ).toBe(false);
        // Omitting it entirely still parses, matching every answer sent before this field existed.
        expect(
            mobileAttentionAnswerParametersSchema.parse({
                sessionId: 'session-1',
                requestId: 'request-1',
                decision: 'deny',
            }),
        ).not.toHaveProperty('autoAllow');
    });
});

describe('mobile.attention.list result', () => {
    it('requires the autoAllow status alongside pending requests', () => {
        const result = mobileMethods['mobile.attention.list'].result;
        expect(
            result.safeParse({ requests: [] }).success,
            'autoAllow must be required, not optional, so every client reads a real status',
        ).toBe(false);
        expect(result.parse({ requests: [], autoAllow: { granted: false } })).toEqual({
            requests: [],
            autoAllow: { granted: false },
        });
    });
});

describe('mobile.attention.autoAllowRevoke', () => {
    it('is a control-effect Server command scoped to one Session', () => {
        expect(mobileMethods['mobile.attention.autoAllowRevoke']).toMatchObject({
            owner: 'server',
            effect: 'control',
        });
        expect(
            mobileMethods['mobile.attention.autoAllowRevoke'].params.parse({
                sessionId: 'session-1',
            }),
        ).toEqual({ sessionId: 'session-1' });
        expect(mobileMethods['mobile.attention.autoAllowRevoke'].result).toBe(
            permissionAutoAllowStatusSchema,
        );
    });

    it('extends the public params with a principal only on the Internal variant', () => {
        expect(
            mobileInternalMethods['mobile.attention.autoAllowRevokeInternal'].params.safeParse({
                sessionId: 'session-1',
            }).success,
        ).toBe(false);
    });
});
