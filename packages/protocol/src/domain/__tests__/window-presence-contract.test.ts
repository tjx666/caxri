import { describe, expect, it } from 'vitest';

import { windowDesktopMethods } from '../../desktop/window-state-contract';
import { sessionMethods } from '../session-contract';
import {
    windowKeySchema,
    windowPresenceInternalMethods,
    windowScopedMethods,
} from '../window-presence-contract';
import { workbenchInternalMethods } from '../workbench-contract';

describe('tear-off window protocol', () => {
    it('accepts the key shape Desktop Main mints for a torn-off window', () => {
        expect(windowKeySchema.safeParse(`win-${crypto.randomUUID()}`).success).toBe(true);
        expect(windowKeySchema.safeParse('has space').success).toBe(false);
    });

    it('keeps the transfer, release, and restore methods Main-only', () => {
        for (const method of [
            'window.openSessions.moveToWindow',
            'window.openSessions.release',
            'window.openSessions.listTearOffs',
        ] as const) {
            expect(Object.keys(workbenchInternalMethods)).toContain(method);
            expect(windowScopedMethods as readonly string[]).not.toContain(method);
        }
    });

    it('requires a source window and a target window key to move a Session', () => {
        const { params } = windowPresenceInternalMethods['window.openSessions.moveToWindow'];
        expect(
            params.safeParse({ sessionId: 's', windowKey: 'main', targetWindowKey: 'win-1' })
                .success,
        ).toBe(true);
        expect(params.safeParse({ sessionId: 's', windowKey: 'main' }).success).toBe(false);
    });

    it('reports the owner window on a redirected select and resume', () => {
        expect(
            sessionMethods['session.select'].result.shape.ownerWindowKey.safeParse(undefined)
                .success,
        ).toBe(true);
        expect(
            sessionMethods['session.resume'].result.shape.ownerWindowKey.safeParse(undefined)
                .success,
        ).toBe(true);
    });
});

describe('window.tearOffSession', () => {
    const { params } = windowDesktopMethods['window.tearOffSession'];

    it('takes a Session and an optional drop point, never a window key or bounds', () => {
        expect(params.safeParse({ sessionId: 'session-1' }).success).toBe(true);
        expect(
            params.safeParse({ sessionId: 'session-1', screenPoint: { x: -10.5, y: 4 } }).success,
        ).toBe(true);
        expect(params.parse({ sessionId: 'session-1', windowKey: 'win-x', bounds: {} })).toEqual({
            sessionId: 'session-1',
        });
        expect(params.safeParse({ sessionId: 'session-1', screenPoint: { x: 1 } }).success).toBe(
            false,
        );
    });
});
