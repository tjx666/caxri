import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    AgentAttentionAutoAllow,
    createPermissionAutoAllowController,
    shouldAutoAllowAttention,
} from '../attention-auto-allow';

describe('shouldAutoAllowAttention', () => {
    it('auto-allows a permission request only while granted', () => {
        expect(shouldAutoAllowAttention('permission', true)).toBe(true);
        expect(shouldAutoAllowAttention('permission', false)).toBe(false);
    });

    it('never auto-allows a question request, even while granted', () => {
        expect(shouldAutoAllowAttention('question', true)).toBe(false);
        expect(shouldAutoAllowAttention('question', false)).toBe(false);
    });
});

describe('AgentAttentionAutoAllow', () => {
    it('grants, reports, and revokes a Session-scoped auto-allow', () => {
        const store = new AgentAttentionAutoAllow();
        expect(store.isGranted('session-one')).toBe(false);
        expect(store.status('session-one')).toEqual({ granted: false });

        const grant = store.grant('session-one');
        expect(grant.granted).toBe(true);
        expect(grant.grantedAt).toBeTypeOf('number');
        expect(store.isGranted('session-one')).toBe(true);
        expect(store.status('session-one')).toEqual(grant);
        // A different Session was never granted.
        expect(store.isGranted('session-two')).toBe(false);

        expect(store.revoke('session-one')).toEqual({ autoAllowCount: 0, revoked: true });
        expect(store.isGranted('session-one')).toBe(false);
        expect(store.status('session-one')).toEqual({ granted: false });
    });

    it('reports a no-op revoke on a Session that was never granted', () => {
        const store = new AgentAttentionAutoAllow();
        expect(store.revoke('session-never-granted')).toEqual({
            autoAllowCount: 0,
            revoked: false,
        });
    });

    it('accumulates the per-lifetime auto-allow count until revoked', () => {
        const store = new AgentAttentionAutoAllow();
        // Recording against an ungranted Session is a safe no-op, per the method's own contract.
        expect(store.recordAutoAllow('session-one')).toBe(0);

        store.grant('session-one');
        expect(store.recordAutoAllow('session-one')).toBe(1);
        expect(store.recordAutoAllow('session-one')).toBe(2);
        expect(store.revoke('session-one')).toEqual({ autoAllowCount: 2, revoked: true });

        // A fresh grant starts its own count back at zero.
        store.grant('session-one');
        expect(store.recordAutoAllow('session-one')).toBe(1);
    });
});

function createController() {
    const logger = { write: vi.fn() };
    const events: ServerEvent[] = [];
    const controller = createPermissionAutoAllowController({
        logger: logger as never,
        send: (event) => events.push(event),
    });
    return { controller, logger, events };
}

describe('createPermissionAutoAllowController', () => {
    it('grant logs and emits the transition with reason "user"', () => {
        const { controller, logger, events } = createController();

        const status = controller.grant('session-one');

        expect(status.granted).toBe(true);
        expect(logger.write).toHaveBeenCalledExactlyOnceWith(
            'info',
            'agent.permission_auto_allow_changed',
            {
                fields: {
                    sessionId: 'session-one',
                    granted: true,
                    reason: 'user',
                    autoAllowCount: 0,
                },
            },
        );
        expect(events).toEqual([
            {
                event: 'agent.permissionAutoAllowChanged',
                payload: { sessionId: 'session-one', granted: true, grantedAt: status.grantedAt },
            },
        ]);
    });

    it('revoke logs and emits the transition with the caller-supplied reason and count', () => {
        const { controller, logger, events } = createController();
        controller.grant('session-one');
        controller.recordAutoAllow('session-one');
        controller.recordAutoAllow('session-one');
        logger.write.mockClear();
        events.length = 0;

        const status = controller.revoke('session-one', 'agentRestart');

        expect(status).toEqual({ granted: false });
        expect(logger.write).toHaveBeenCalledExactlyOnceWith(
            'info',
            'agent.permission_auto_allow_changed',
            {
                fields: {
                    sessionId: 'session-one',
                    granted: false,
                    reason: 'agentRestart',
                    autoAllowCount: 2,
                },
            },
        );
        expect(events).toEqual([
            {
                event: 'agent.permissionAutoAllowChanged',
                payload: { sessionId: 'session-one', granted: false },
            },
        ]);
    });

    it('is silent on a revoke for a Session that was never granted', () => {
        const { controller, logger, events } = createController();

        expect(controller.revoke('session-never-granted', 'sessionDeleted')).toEqual({
            granted: false,
        });
        expect(logger.write).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    it('routes isGranted/status/recordAutoAllow to the underlying grant without side effects', () => {
        const { controller, logger, events } = createController();
        expect(controller.isGranted('session-one')).toBe(false);

        controller.grant('session-one');
        logger.write.mockClear();
        events.length = 0;

        expect(controller.isGranted('session-one')).toBe(true);
        expect(controller.status('session-one').granted).toBe(true);
        expect(controller.recordAutoAllow('session-one')).toBe(1);
        // Reads and the auto-allow counter never log or emit; only grant/revoke transitions do.
        expect(logger.write).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });
});
